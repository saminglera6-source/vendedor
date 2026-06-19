-- ============================================================
-- vendedor-ia — migración inicial
-- PostgreSQL 15 + pgvector | Supabase
-- ============================================================


-- ============================================================
-- 1. Extensiones
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;


-- ============================================================
-- 2. Tipos ENUM
-- ============================================================

CREATE TYPE lead_estado AS ENUM (
  'NEW',              -- primer contacto, sin cualificar
  'CONSULTA',         -- interacción activa, consultando
  'INTERESADO',       -- preguntó precio / specs / disponibilidad
  'MUY_INTERESADO',   -- compara modelos, pregunta financiación
  'LISTO_PARA_COMPRAR', -- pidió link de pago o dijo "lo quiero"
  'CLIENTE',          -- compra confirmada
  'PERDIDO'           -- sin respuesta >7 días o rechazo explícito
);

CREATE TYPE availability_status AS ENUM (
  'AVAILABLE',        -- puede venderse y entregarse (stock propio, proveedor o red)
  'NO_DISPONIBLE'     -- no puede venderse en ningún plazo razonable
);


-- ============================================================
-- 3. Función auxiliar: updated_at automático
-- ============================================================

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 4. Tabla: products
--    Catálogo base — el modelo sin variante específica.
--    Ej: "iPhone 15 Pro", "Samsung Galaxy S24"
-- ============================================================

CREATE TABLE products (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  categoria   TEXT        NOT NULL,
  marca       TEXT        NOT NULL,
  modelo      TEXT        NOT NULL,
  descripcion TEXT,
  imagen_url  TEXT,
  activo      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT products_marca_modelo_key UNIQUE (marca, modelo)
);


-- ============================================================
-- 5. Tabla: product_variants
--    Cada combinación color × almacenamiento es una variante
--    independiente con su propio precio y disponibilidad.
--
--    IMPORTANTE: supply_notes es USO INTERNO EXCLUSIVO.
--    Nunca incluir en el contexto del agente ni respuestas al cliente.
--    db/products.ts filtra esta columna en todas las queries.
-- ============================================================

CREATE TABLE product_variants (
  id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          UUID                NOT NULL
                        REFERENCES products(id) ON DELETE CASCADE,
  color               TEXT                NOT NULL,
  almacenamiento      TEXT                NOT NULL,
  precio              NUMERIC(12, 2)      NOT NULL
                        CHECK (precio > 0),
  availability_status availability_status NOT NULL DEFAULT 'AVAILABLE',
  delivery_time_hours INT                 NOT NULL DEFAULT 0
                        CHECK (delivery_time_hours >= 0 AND delivery_time_hours <= 720),
  supply_notes        TEXT,
  activo              BOOLEAN             NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),

  CONSTRAINT product_variants_unique_key UNIQUE (product_id, color, almacenamiento)
);


-- ============================================================
-- 6. Tabla: leads
--    Cada contacto único (por teléfono) es un lead.
--    El estado y lead_score son actualizados por el agente
--    en cada interacción.
-- ============================================================

CREATE TABLE leads (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           TEXT        NOT NULL,
  name            TEXT,
  channel         TEXT        NOT NULL DEFAULT 'whatsapp',
  estado          lead_estado NOT NULL DEFAULT 'NEW',
  lead_score      INT         NOT NULL DEFAULT 0
                    CHECK (lead_score >= 0 AND lead_score <= 100),
  requiere_humano BOOLEAN     NOT NULL DEFAULT FALSE,
  last_contact    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT leads_phone_key UNIQUE (phone)
);


-- ============================================================
-- 7. Tabla: customer_memory
--    Memoria comercial persistente, 1:1 con cada lead.
--    Se crea vacía en el primer contacto y se enriquece
--    a lo largo de la conversación.
--    resumen_comercial es generado por IA cada 5 mensajes.
-- ============================================================

CREATE TABLE customer_memory (
  id                    UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id               UUID           NOT NULL
                          REFERENCES leads(id) ON DELETE CASCADE,
  producto_interes      TEXT,
  color_preferido       TEXT,
  almacenamiento        TEXT,
  presupuesto_min       NUMERIC(12, 2) CHECK (presupuesto_min >= 0),
  presupuesto_max       NUMERIC(12, 2) CHECK (presupuesto_max >= 0),
  fecha_estimada_compra DATE,
  resumen_comercial     TEXT,
  raw_preferences       JSONB          NOT NULL DEFAULT '{}'::jsonb,
  updated_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT customer_memory_lead_id_key UNIQUE (lead_id),
  CONSTRAINT customer_memory_budget_order_check
    CHECK (
      presupuesto_max IS NULL
      OR presupuesto_min IS NULL
      OR presupuesto_max >= presupuesto_min
    )
);


-- ============================================================
-- 8. Tabla: conversations
--    Registro completo de mensajes por lead.
--    metadata guarda: intencion, accion_venta, variant_id
--    consultada, estado del lead en ese momento, etc.
-- ============================================================

CREATE TABLE conversations (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID        NOT NULL
                REFERENCES leads(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL
                CHECK (role IN ('user', 'assistant')),
  content     TEXT        NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- 9. Tabla: knowledge_chunks
--    Chunks de texto vectorizados para RAG.
--    source_type distingue el origen del contenido.
--    embedding es VECTOR(1536) — text-embedding-3-small.
--
--    NOTA: el índice ivfflat se vuelve eficiente después
--    de ~2.000 filas. Con listas=100 es óptimo hasta ~1M vectores.
--    Si se supera 500k rows: REINDEX con lists=200.
-- ============================================================

CREATE TABLE knowledge_chunks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT        NOT NULL
                CHECK (source_type IN (
                  'historical_conversation',
                  'product_doc',
                  'faq'
                )),
  source_id   TEXT,
  content     TEXT        NOT NULL,
  embedding   VECTOR(1536),
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- 10. Tabla: followups
--     Cola de seguimientos programados.
--     Reemplaza Redis + BullMQ en V1.
--     El cron send-followups corre cada 15 min y procesa
--     los registros con status='pending' y scheduled_at <= NOW().
-- ============================================================

CREATE TABLE followups (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       UUID        NOT NULL
                  REFERENCES leads(id) ON DELETE CASCADE,
  tipo          TEXT        NOT NULL
                  CHECK (tipo IN ('recuperacion', 'cierre', 'check_in', 'oferta')),
  mensaje_base  TEXT,
  scheduled_at  TIMESTAMPTZ NOT NULL,
  executed_at   TIMESTAMPTZ,
  status        TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- 11. Tabla: business_rules
--     Configuración operativa editable sin tocar código.
--     El agente carga todas las reglas al iniciar y las cachea
--     en memoria de proceso (TTL: 60 min).
--     Ver 002_seed_rules.sql para valores iniciales.
-- ============================================================

CREATE TABLE business_rules (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT        NOT NULL,
  value       JSONB       NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT business_rules_key_unique UNIQUE (key)
);


-- ============================================================
-- 12. Tabla: ai_feedback
--     Correcciones manuales de humanos sobre respuestas del agente.
--     Fuente de datos para evaluación y mejora del system prompt.
--     El índice en motivo permite analizar qué errores son más frecuentes.
-- ============================================================

CREATE TABLE ai_feedback (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID
                        REFERENCES conversations(id) ON DELETE SET NULL,
  lead_id             UUID
                        REFERENCES leads(id) ON DELETE SET NULL,
  respuesta_original  TEXT        NOT NULL,
  respuesta_corregida TEXT        NOT NULL,
  motivo              TEXT
                        CHECK (motivo IN (
                          'precio_incorrecto',
                          'lenguaje_prohibido',
                          'tono_inadecuado',
                          'no_avanzo_venta',
                          'info_inventada',
                          'derivacion_innecesaria',
                          'otro'
                        )),
  corregido_por       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- 13. Triggers: updated_at automático
-- ============================================================

CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER trg_product_variants_updated_at
  BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER trg_customer_memory_updated_at
  BEFORE UPDATE ON customer_memory
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER trg_business_rules_updated_at
  BEFORE UPDATE ON business_rules
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ============================================================
-- 14. Índices
-- ============================================================

-- products
CREATE INDEX idx_products_activo_marca
  ON products (marca, modelo)
  WHERE activo = TRUE;

CREATE INDEX idx_products_categoria
  ON products (categoria)
  WHERE activo = TRUE;

-- product_variants
CREATE INDEX idx_variants_available_by_product
  ON product_variants (product_id, availability_status)
  WHERE activo = TRUE;

CREATE INDEX idx_variants_product_id
  ON product_variants (product_id);

-- leads — usados por cron jobs y el agente
CREATE INDEX idx_leads_estado
  ON leads (estado);

CREATE INDEX idx_leads_score_desc
  ON leads (lead_score DESC);

CREATE INDEX idx_leads_last_contact
  ON leads (last_contact);

CREATE INDEX idx_leads_requiere_humano
  ON leads (requiere_humano)
  WHERE requiere_humano = TRUE;

CREATE INDEX idx_leads_channel
  ON leads (channel);

-- customer_memory
CREATE INDEX idx_customer_memory_lead_id
  ON customer_memory (lead_id);

-- conversations — carga de historial reciente
CREATE INDEX idx_conversations_lead_created
  ON conversations (lead_id, created_at DESC);

-- knowledge_chunks — búsqueda vectorial ANN
CREATE INDEX idx_knowledge_chunks_embedding
  ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX idx_knowledge_chunks_source_type
  ON knowledge_chunks (source_type);

CREATE INDEX idx_knowledge_chunks_source_id
  ON knowledge_chunks (source_id)
  WHERE source_id IS NOT NULL;

-- followups — cron de envío (cada 15 min)
CREATE INDEX idx_followups_pending_scheduled
  ON followups (scheduled_at)
  WHERE status = 'pending';

CREATE INDEX idx_followups_lead_id
  ON followups (lead_id);

-- ai_feedback — análisis de errores frecuentes
CREATE INDEX idx_ai_feedback_lead_id
  ON ai_feedback (lead_id);

CREATE INDEX idx_ai_feedback_motivo
  ON ai_feedback (motivo)
  WHERE motivo IS NOT NULL;


-- ============================================================
-- 15. Comentarios de documentación
-- ============================================================

COMMENT ON TABLE products IS
  'Catálogo base de productos (marca + modelo). Sin variantes.';

COMMENT ON TABLE product_variants IS
  'Variante específica: color × almacenamiento. Tiene precio y disponibilidad propios.';

COMMENT ON COLUMN product_variants.supply_notes IS
  'USO INTERNO: origen del stock (propio, proveedor, colega). NUNCA exponer al agente ni al cliente.';

COMMENT ON COLUMN product_variants.delivery_time_hours IS
  '0=hoy, 24=mañana, 48=2 días. El agente traduce a lenguaje aprobado via business_rules.delivery_time_labels.';

COMMENT ON COLUMN product_variants.availability_status IS
  'AVAILABLE mientras pueda venderse por cualquier fuente. NO_DISPONIBLE solo si realmente no puede entregarse.';

COMMENT ON TABLE leads IS
  'Cada contacto único (phone). Estado y score actualizados por el agente en cada interacción.';

COMMENT ON TABLE customer_memory IS
  'Memoria comercial 1:1 con lead. Enriquecida progresivamente. resumen_comercial generado por IA cada 5 mensajes.';

COMMENT ON COLUMN customer_memory.raw_preferences IS
  'Campo flexible JSONB para preferencias no estructuradas detectadas en conversación.';

COMMENT ON TABLE conversations IS
  'Historial completo de mensajes. metadata incluye: intencion, accion_venta, variant_id_consultada.';

COMMENT ON TABLE knowledge_chunks IS
  'Chunks vectorizados (VECTOR 1536) para RAG. Fuentes: conversaciones históricas, docs de producto, FAQs.';

COMMENT ON COLUMN knowledge_chunks.embedding IS
  'Generado con text-embedding-3-small (OpenAI, 1536 dim). Si se cambia el modelo, reindexar todo.';

COMMENT ON TABLE followups IS
  'Cola de seguimientos programados. Procesada por cron/send-followups.ts cada 15 minutos.';

COMMENT ON TABLE business_rules IS
  'Configuración operativa editable en caliente. Cacheada en proceso con TTL de 60 min.';

COMMENT ON TABLE ai_feedback IS
  'Correcciones humanas sobre respuestas del agente. Exportar periódicamente para mejorar el system prompt.';

COMMENT ON COLUMN ai_feedback.motivo IS
  'lenguaje_prohibido: frase no permitida detectada post-generación. no_avanzo_venta: respuesta pasiva sin intento de cierre.';


-- ============================================================
-- 16. Row Level Security
--     El backend usa SUPABASE_SERVICE_KEY que bypasea RLS.
--     RLS habilitado para bloquear acceso accidental por
--     claves anon o de usuario autenticado.
-- ============================================================

ALTER TABLE products          ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads             ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_memory   ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE followups         ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_rules    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_feedback       ENABLE ROW LEVEL SECURITY;
