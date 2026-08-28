# vendedor-ia

Agente de ventas por chat para **GreatPhones** (iPhone usados, Bahía Blanca).
Responde por WhatsApp/Instagram vía Kommo, usa Claude como LLM y Supabase + pgvector
como backend. La documentación funcional completa está en [`CLAUDE.md`](CLAUDE.md).

**Stack:** Node.js 20+ · TypeScript (ESM) · Claude · Supabase (PostgreSQL 15 + pgvector) ·
OpenAI embeddings (opcional, para RAG) · Kommo (canal WhatsApp/IG).

---

## Puesta en marcha

### 1. Requisitos

- Node.js ≥ 20
- Un proyecto de [Supabase](https://supabase.com) (free tier alcanza)
- API key de [Anthropic](https://console.anthropic.com)
- *(Opcional)* API key de OpenAI para RAG
- *(Opcional)* Cuenta de Kommo para el canal WhatsApp/Instagram

### 2. Instalar

```bash
git clone https://github.com/saminglera6-source/vendedor.git
cd vendedor
npm install
```

### 3. Variables de entorno

```bash
cp .env.example .env
```

Completar en `.env` como mínimo:

| Variable | Obligatoria | Nota |
|---|---|---|
| `SUPABASE_URL` | ✅ | URL del proyecto |
| `SUPABASE_SERVICE_KEY` | ✅ | `service_role`, **no** la anon key |
| `ANTHROPIC_API_KEY` | ✅ | |
| `OPENAI_API_KEY` | ⬜ | Sin esto el RAG queda desactivado (el agente funciona igual) |
| `KOMMO_*` | ⬜ | Solo para el canal WhatsApp/IG. Ver `.env.example` |

`.env` está en `.gitignore` — nunca se commitea.

### 4. Base de datos

Aplicar las migraciones en orden desde el **SQL Editor** de Supabase:

1. `supabase/migrations/001_initial.sql` — tablas, ENUMs, índices, RLS
2. `supabase/migrations/002_seed_rules.sql` — business rules iniciales
3. `supabase/migrations/003_rag_search_fn.sql` — función RPC para búsqueda vectorial
4. `supabase/migrations/004_seed_products_example.sql` — **datos de ejemplo** (borrar/editar con catálogo real)

### 5. Correr

```bash
npm run dev        # servidor en :3000 con hot reload
```

Verificar:

```bash
curl http://localhost:3000/health

curl -X POST http://localhost:3000/message \
  -H "Content-Type: application/json" \
  -d '{"phone":"5491155550001","message":"buenas, tienen el iphone 15 pro?"}'
```

Debería crear un lead + conversaciones en Supabase y devolver una respuesta del agente.

---

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor en desarrollo (watch) |
| `npm run build` | Compila a `dist/` |
| `npm start` | Corre el build (`dist/api/routes.js`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` / `npm run test:run` | Tests con vitest |
| `npm run import-history` | Importa historial de chats al vector store (RAG) — requiere `OPENAI_API_KEY` y datos de entrada |

---

## RAG (opcional)

El pipeline detecta si `OPENAI_API_KEY` está definida; si no, salta la búsqueda vectorial
sin errores. Para sembrar la base de conocimiento hace falta un export de conversaciones
históricas (no incluido en el repo por privacidad de clientes) y correr
`npm run import-history`.

---

## API

| Ruta | Método | Body / Query |
|---|---|---|
| `/message` | POST | `{ phone, message, channel? }` |
| `/feedback` | POST | `{ respuesta_original, respuesta_corregida, motivo, ... }` |
| `/leads` | GET | `?estado=&min_score=&limit=` |
| `/health` | GET | — |
| `/kommo/webhook` | POST | Webhook de Kommo (form-urlencoded) |

---

## Deploy

Pensado para Railway / Render / Fly.io: 1 instancia Node 20, variables de entorno en el
panel del proveedor (no `--env-file`), Supabase aparte. Antes de exponerlo: agregar auth
por header en `src/api/routes.ts`, HTTPS y rate limiting. Checklist completa en `CLAUDE.md`.
