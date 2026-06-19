-- ============================================================
-- vendedor-ia — seed: business_rules
-- Valores operativos iniciales del negocio.
-- Editables en caliente desde la tabla business_rules
-- sin necesidad de redeploy.
-- ============================================================

INSERT INTO business_rules (key, value, description) VALUES

-- ----------------------------------------------------------
-- Cuándo derivar a un humano
-- ----------------------------------------------------------
(
  'escalation_threshold',
  '{
    "lead_score": 85,
    "keywords": [
      "hablar con humano",
      "hablar con una persona",
      "pasame con alguien",
      "quiero hablar con alguien",
      "atención personalizada",
      "quiero hablar con el dueño",
      "necesito hablar con alguien",
      "me comuniques con alguien"
    ]
  }'::jsonb,
  'Umbral de lead_score y keywords explícitas que disparan derivación al equipo humano.'
),

-- ----------------------------------------------------------
-- Horario de atención
-- ----------------------------------------------------------
(
  'business_hours',
  '{
    "timezone": "America/Buenos_Aires",
    "schedule": {
      "mon": { "open": "09:00", "close": "18:00" },
      "tue": { "open": "09:00", "close": "18:00" },
      "wed": { "open": "09:00", "close": "18:00" },
      "thu": { "open": "09:00", "close": "18:00" },
      "fri": { "open": "09:00", "close": "18:00" },
      "sat": { "open": "10:00", "close": "14:00" },
      "sun": null
    },
    "outside_hours_msg": "¡Hola! Por el momento estamos fuera de horario. Te respondemos a primera hora. ¿En qué puedo ayudarte?"
  }'::jsonb,
  'Horario de atención por día. null = cerrado. Timezone: America/Buenos_Aires.'
),

-- ----------------------------------------------------------
-- Plantillas de mensajes de seguimiento
-- Variables disponibles: {nombre}, {producto}, {color}, {almacenamiento}
-- ----------------------------------------------------------
(
  'followup_messages',
  '{
    "recuperacion": "Hola {nombre}! Te escribo porque hace unos días consultaste por el {producto}. ¿Seguís buscando? Lo tengo disponible y puedo ayudarte a cerrarlo hoy.",
    "cierre":       "Hola {nombre}! ¿Pudiste decidirte con el {producto}? Está disponible, puedo reservarlo para vos ahora.",
    "check_in":     "Hola {nombre}! ¿Cómo andás? ¿Seguís evaluando opciones? Estoy acá para ayudarte.",
    "oferta":       "Hola {nombre}! Te escribo porque tenemos disponibilidad del {producto} que consultaste. ¿Lo cerramos?"
  }'::jsonb,
  'Plantillas para mensajes de seguimiento automático. Variables: {nombre}, {producto}, {color}, {almacenamiento}.'
),

-- ----------------------------------------------------------
-- Tiempos de inactividad antes de marcar PERDIDO
-- ----------------------------------------------------------
(
  'max_no_response_hours',
  '{
    "warning": 72,
    "lost":    168
  }'::jsonb,
  'Horas sin respuesta del lead. warning=72 (3 días): crear followup tipo cierre. lost=168 (7 días): marcar PERDIDO.'
),

-- ----------------------------------------------------------
-- Frecuencia de recuperación de leads PERDIDO
-- ----------------------------------------------------------
(
  'recovery_interval_days',
  '{
    "value": 30
  }'::jsonb,
  'Días mínimos entre intentos de recuperación para leads en estado PERDIDO con lead_score > 30.'
),

-- ----------------------------------------------------------
-- Chunks RAG por consulta
-- ----------------------------------------------------------
(
  'rag_top_k',
  '{
    "value":     5,
    "threshold": 0.75
  }'::jsonb,
  'Cantidad de chunks RAG a recuperar (top_k) y similitud coseno mínima (threshold). Ajustar según calidad de respuestas.'
),

-- ----------------------------------------------------------
-- Mapeo delivery_time_hours → lenguaje natural aprobado
-- El agente usa este mapeo para traducir el valor numérico
-- a la frase que se envía al cliente.
-- Claves son strings del número de horas.
-- ----------------------------------------------------------
(
  'delivery_time_labels',
  '{
    "0":   "hoy",
    "24":  "mañana",
    "48":  "en 2 días",
    "72":  "en 3 días",
    "120": "esta semana"
  }'::jsonb,
  'Mapeo de delivery_time_hours a lenguaje natural para el cliente. Si el valor exacto no existe, usar el siguiente mayor.'
),

-- ----------------------------------------------------------
-- Frases prohibidas
-- Validadas en language-guard.ts post-generación.
-- Si hay match: loguear en ai_feedback + regenerar (1 reintento).
-- ----------------------------------------------------------
(
  'prohibited_phrases',
  '[
    "te lo consigo",
    "lo consigo",
    "tengo que buscarlo",
    "tengo que preguntar",
    "no tengo stock",
    "sin stock",
    "se lo compro a un colega",
    "no me queda",
    "no me quedan",
    "tendría que ver",
    "habría que consultar",
    "habría que preguntar",
    "no sé si tenemos",
    "no estoy seguro si hay",
    "debería costar",
    "aproximadamente vale",
    "creo que sale",
    "no tenemos disponible",
    "está agotado"
  ]'::jsonb,
  'Frases que el agente nunca debe usar. Generan desconfianza y reducen conversiones.'
),

-- ----------------------------------------------------------
-- Frases aprobadas para comunicar disponibilidad
-- Referencia para el system prompt del agente.
-- ----------------------------------------------------------
(
  'approved_availability_phrases',
  '[
    "está disponible",
    "lo tengo disponible",
    "disponible para entrega",
    "disponible para retiro",
    "puedo entregarlo hoy",
    "puedo entregarlo mañana",
    "lo tenemos",
    "está en stock",
    "tengo disponibilidad"
  ]'::jsonb,
  'Frases aprobadas para comunicar disponibilidad. Incluidas en el system prompt como ejemplos de lenguaje correcto.'
),

-- ----------------------------------------------------------
-- Planes de financiación activos
-- Array vacío = no ofrecer cuotas.
-- El agente NO menciona cuotas si este array está vacío.
-- Formato de cada plan:
--   { "name": "Ahora 12", "installments": 12, "interest_rate": 0, "min_amount": 50000 }
-- ----------------------------------------------------------
(
  'financing_plans',
  '[]'::jsonb,
  'Planes de cuotas activos. Array vacío = no ofrecer financiación. El agente no menciona cuotas si está vacío.'
),

-- ----------------------------------------------------------
-- Prioridad de acción del agente
-- Incluida en el system prompt como directiva operativa.
-- ----------------------------------------------------------
(
  'agent_sales_priority',
  '{
    "order": [
      "close_sale",
      "detect_hot_buyer",
      "schedule_followup",
      "recover_lost",
      "answer_query"
    ],
    "directive": "Cada respuesta debe avanzar la conversación hacia el cierre. Una respuesta que solo informa sin preguntar ni proponer un siguiente paso es un fallo.",
    "advance_question_required": true
  }'::jsonb,
  'Jerarquía de prioridades y directiva de conversación del agente. Cargada en el system prompt.'
);
