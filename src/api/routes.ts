/**
 * API REST del agente vendedor-ia.
 *
 * Servidor HTTP con node:http (sin framework) para mantener las dependencias
 * al mínimo. Validación de entrada con Zod. Respuestas JSON tipadas.
 *
 * Rutas:
 *   POST /message   — procesar mensaje del cliente
 *   POST /feedback  — registrar corrección humana al agente
 *   GET  /leads     — listar leads con filtros
 *   GET  /health    — healthcheck
 *
 * Autenticación: sin implementar en V1. Agregar API key middleware antes de
 * exponer al exterior. Documentado en .env.example.
 *
 * Iniciar: node --env-file .env --loader ts-node/esm src/api/routes.ts
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

import { processMessage } from '../agent/index.js';
import { createAiFeedback } from '../db/ai-feedback.js';
import { getLeads } from '../db/leads.js';
import type { LeadEstado } from '../types.js';
import {
  handleKommoMessage,
  parseFormUrlEncoded,
  parseKommoWebhook,
  verifyKommoSignature,
} from '../integrations/kommo/handler.js';

// ===========================================================================
// Tipos de respuesta API
// ===========================================================================

interface ApiOkResponse<T> {
  ok: true;
  data: T;
}

interface ApiErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

// ===========================================================================
// Schemas de validación (Zod)
// ===========================================================================

const PostMessageSchema = z.object({
  phone: z
    .string()
    .min(5, 'phone muy corto')
    .max(30, 'phone muy largo')
    .trim(),
  message: z
    .string()
    .min(1, 'message no puede estar vacío')
    .max(4000, 'message demasiado largo'),
  channel: z.enum(['whatsapp', 'instagram', 'facebook', 'web']).default('whatsapp'),
});

const PostFeedbackSchema = z.object({
  respuesta_original: z.string().min(1),
  respuesta_corregida: z.string().min(1),
  motivo: z.enum([
    'precio_incorrecto',
    'lenguaje_prohibido',
    'tono_inadecuado',
    'no_avanzo_venta',
    'info_inventada',
    'derivacion_innecesaria',
    'otro',
  ]),
  conversation_id: z.string().uuid().optional(),
  lead_id: z.string().uuid().optional(),
  corregido_por: z.string().max(100).optional(),
});

const GetLeadsSchema = z.object({
  estado: z
    .enum([
      'NEW', 'CONSULTA', 'INTERESADO', 'MUY_INTERESADO',
      'LISTO_PARA_COMPRAR', 'CLIENTE', 'PERDIDO',
    ])
    .optional(),
  min_score: z.coerce.number().min(0).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// ===========================================================================
// Helpers HTTP
// ===========================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  ...CORS_HEADERS,
};

/** Lee y parsea el body JSON de un request. Rechaza payloads > 100 KB. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BYTES = 100 * 1024;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(new Error('Payload demasiado grande (máximo 100 KB)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON inválido en el body'));
      }
    });

    req.on('error', reject);
  });
}

/** Envía una respuesta JSON con status y headers estándar. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...JSON_HEADERS,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendOk<T>(res: ServerResponse, status: number, data: T): void {
  const response: ApiOkResponse<T> = { ok: true, data };
  sendJson(res, status, response);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  const response: ApiErrorResponse = { ok: false, error: { code, message } };
  sendJson(res, status, response);
}

/** Formatea el primer error de Zod en un mensaje legible. */
function formatZodError(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Validación fallida';
  const path = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return `${path}${first.message}`;
}

/** Parsea query params de una URL a un Record string→string. */
function parseQueryParams(url: URL): Record<string, string> {
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return params;
}

// ===========================================================================
// Handlers
// ===========================================================================

/**
 * POST /message
 *
 * Recibe un mensaje del cliente, ejecuta el pipeline completo del agente
 * y devuelve la respuesta generada junto con el estado del lead.
 */
async function handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendError(res, 400, 'INVALID_BODY', e instanceof Error ? e.message : 'Body inválido');
    return;
  }

  const parsed = PostMessageSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, 'VALIDATION_ERROR', formatZodError(parsed.error));
    return;
  }

  const result = await processMessage(parsed.data);

  if (!result.ok) {
    const { error } = result;
    const status = error.message.includes('no definida') ? 503 : 500;
    sendError(res, status, error.code, error.message);
    return;
  }

  sendOk(res, 200, result.value);
}

/**
 * POST /feedback
 *
 * Registra una corrección humana al agente en la tabla ai_feedback.
 * Usado por el equipo operativo cuando detectan una respuesta incorrecta.
 */
async function handleFeedback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendError(res, 400, 'INVALID_BODY', e instanceof Error ? e.message : 'Body inválido');
    return;
  }

  const parsed = PostFeedbackSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, 'VALIDATION_ERROR', formatZodError(parsed.error));
    return;
  }

  const { data } = parsed;

  const result = await createAiFeedback({
    respuesta_original: data.respuesta_original,
    respuesta_corregida: data.respuesta_corregida,
    motivo: data.motivo,
    conversation_id: data.conversation_id ?? null,
    lead_id: data.lead_id ?? null,
    corregido_por: data.corregido_por ?? null,
  });

  if (!result.ok) {
    sendError(res, 500, result.error.code, result.error.message);
    return;
  }

  // 201 Created con el registro creado
  sendOk(res, 201, {
    id: result.value.id,
    motivo: result.value.motivo,
    created_at: result.value.created_at,
  });
}

/**
 * GET /leads
 *
 * Lista leads con filtros opcionales. Devuelve datos para el dashboard operativo.
 *
 * Query params:
 *   estado    — NEW | CONSULTA | INTERESADO | MUY_INTERESADO | LISTO_PARA_COMPRAR | CLIENTE | PERDIDO
 *   min_score — 0–100 (default: 0)
 *   limit     — 1–200 (default: 50)
 */
async function handleLeads(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const rawParams = parseQueryParams(url);
  const parsed = GetLeadsSchema.safeParse(rawParams);

  if (!parsed.success) {
    sendError(res, 400, 'VALIDATION_ERROR', formatZodError(parsed.error));
    return;
  }

  const { estado, min_score, limit } = parsed.data;

  // exactOptionalPropertyTypes: no pasar undefined explícito a campos opcionales.
  // Construir el objeto solo con los campos que realmente están presentes.
  const leadsOpts: Parameters<typeof getLeads>[0] = {
    ...(estado !== undefined && { estado: estado as LeadEstado }),
    ...(min_score !== undefined && { minScore: min_score }),
    ...(limit !== undefined && { limit }),
  };

  const result = await getLeads(leadsOpts);

  if (!result.ok) {
    sendError(res, 500, result.error.code, result.error.message);
    return;
  }

  sendOk(res, 200, {
    leads: result.value,
    total: result.value.length,
    filters: { estado, min_score: min_score ?? 0, limit: limit ?? 50 },
  });
}

/**
 * POST /kommo/webhook
 *
 * Recibe webhooks de mensajes entrantes desde Kommo CRM.
 * Kommo envía el payload cuando un cliente escribe por WhatsApp, Instagram o Facebook.
 *
 * Seguridad: verifica la firma HMAC-SHA1 con KOMMO_WEBHOOK_SECRET.
 * Responde 200 inmediatamente y procesa el mensaje de forma asincrónica para
 * que Kommo no reintente por timeout.
 *
 * Configurable en Kommo: Settings → Integrations → Webhooks → Incoming message
 * URL: https://tu-servidor.com/kommo/webhook
 */
async function handleKommoWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Leer el body raw para verificar la firma antes de parsear
  const rawBody = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 100 * 1024) { reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  }).catch(() => null);

  if (!rawBody) {
    console.error('[kommo:debug] 400 INVALID_BODY — body nulo o demasiado grande');
    sendError(res, 400, 'INVALID_BODY', 'Body inválido o demasiado grande');
    return;
  }

  // DEBUG: imprimir body completo recibido
  console.info('[kommo:debug] body recibido:\n', rawBody.toString('utf-8'));

  // Verificar firma de Kommo
  const signature = req.headers['x-signature'] as string | undefined;
  if (!verifyKommoSignature(rawBody, signature)) {
    sendError(res, 401, 'INVALID_SIGNATURE', 'Firma de webhook inválida');
    return;
  }

  // Parsear body: Kommo envía application/x-www-form-urlencoded (bracket notation PHP-style)
  let body: unknown;
  const rawStr = rawBody.toString('utf-8');
  const contentType = (req.headers['content-type'] ?? '').toLowerCase();

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const parsed = parseFormUrlEncoded(rawStr);
    console.info('[kommo:debug] body parseado (form-urlencoded):\n', JSON.stringify(parsed, null, 2));
    body = parsed;
  } else {
    try {
      body = JSON.parse(rawStr);
      console.info('[kommo:debug] body parseado (JSON):\n', JSON.stringify(body, null, 2));
    } catch (parseErr) {
      // Kommo a veces omite el Content-Type correcto — intentar form-urlencoded como fallback
      if (rawStr.includes('=') && (rawStr.includes('%5B') || rawStr.includes('['))) {
        console.warn('[kommo:debug] JSON falló, intentando form-urlencoded como fallback. Error:', parseErr);
        const parsed = parseFormUrlEncoded(rawStr);
        console.info('[kommo:debug] fallback form-urlencoded:\n', JSON.stringify(parsed, null, 2));
        body = parsed;
      } else {
        console.error('[kommo:debug] 400 INVALID_JSON — formato no reconocido:', parseErr);
        sendError(res, 400, 'INVALID_JSON', 'Formato de body no reconocido (esperado JSON o form-urlencoded)');
        return;
      }
    }
  }

  // Parsear payload de Kommo
  const webhook = parseKommoWebhook(body);

  if (!webhook) {
    // Payload que no es un mensaje de chat (lead events, status changes, etc.)
    // Responder 200 para que Kommo no reintente
    console.warn('[kommo:debug] 200 ignored — parseKommoWebhook devolvió null. body:', JSON.stringify(body, null, 2));
    sendOk(res, 200, { ok: true, ignored: true });
    return;
  }

  // Responder 200 inmediatamente — Kommo espera respuesta rápida (< 3 seg)
  // El procesamiento real es asincrónico
  sendOk(res, 200, { ok: true, received: true });

  // Procesar el mensaje después de responder
  handleKommoMessage(webhook).catch((err: unknown) => {
    console.error('[api] Error no capturado en handleKommoMessage:', err);
  });
}

/**
 * GET /health
 *
 * Healthcheck básico. No verifica conectividad a la DB en V1
 * (agregar en Etapa 5 junto con métricas de los cron jobs).
 */
function handleHealth(res: ServerResponse): void {
  sendOk(res, 200, {
    status: 'healthy',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    model: process.env['AGENT_MODEL'] ?? 'claude-sonnet-4-6',
    environment: process.env['NODE_ENV'] ?? 'development',
  });
}

// ===========================================================================
// Router principal
// ===========================================================================

async function router(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? '/';
  const host = req.headers['host'] ?? 'localhost';
  const url = new URL(rawUrl, `http://${host}`);
  const method = req.method?.toUpperCase() ?? 'GET';
  const pathname = url.pathname.replace(/\/$/, '') || '/'; // normalizar trailing slash

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Log de cada request (producción debería usar structured logging)
  console.info(`[api] ${method} ${pathname}`);

  if (method === 'POST' && pathname === '/message') {
    await handleMessage(req, res);
  } else if (method === 'POST' && pathname === '/feedback') {
    await handleFeedback(req, res);
  } else if (method === 'POST' && pathname === '/kommo/webhook') {
    await handleKommoWebhook(req, res);
  } else if (method === 'GET' && pathname === '/leads') {
    await handleLeads(req, res, url);
  } else if (method === 'GET' && pathname === '/health') {
    handleHealth(res);
  } else {
    sendError(res, 404, 'NOT_FOUND', `Ruta no encontrada: ${method} ${pathname}`);
  }
}

// ===========================================================================
// Startup
// ===========================================================================

function validateEnv(): void {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);

  if (missing.length > 0) {
    console.error(
      `[api] Variables de entorno faltantes: ${missing.join(', ')}\n` +
        'Verificar .env o cargar con: node --env-file .env ...',
    );
    process.exit(1);
  }
}

function getPort(): number {
  const raw = process.env['PORT'];
  if (raw === undefined) return 3000;
  const port = parseInt(raw, 10);
  return Number.isFinite(port) && port > 0 ? port : 3000;
}

validateEnv();

const PORT = getPort();

const server = createServer((req, res) => {
  // Envolver en try/catch para capturar errores no esperados
  router(req, res).catch((error: unknown) => {
    console.error('[api] Error no capturado en router:', error);
    // Si la respuesta todavía no fue enviada, mandar 500
    if (!res.headersSent) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Error interno del servidor');
    }
  });
});

server.listen(PORT, () => {
  console.info(`[api] vendedor-ia escuchando en http://localhost:${PORT}`);
  console.info(`[api] Rutas disponibles:
  POST /message         — procesar mensaje de cliente (directo)
  POST /feedback        — registrar corrección al agente
  POST /kommo/webhook   — webhook de mensajes entrantes de Kommo CRM
  GET  /leads           — listar leads (filtros: estado, min_score, limit)
  GET  /health          — healthcheck`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[api] Puerto ${PORT} en uso. Cambiar PORT en .env`);
  } else {
    console.error('[api] Error del servidor:', error);
  }
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.info('[api] SIGTERM recibido, cerrando servidor...');
  server.close(() => {
    console.info('[api] Servidor cerrado.');
    process.exit(0);
  });
});
