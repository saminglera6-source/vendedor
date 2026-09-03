/**
 * Handler principal para webhooks de Kommo.
 *
 * Flujo completo por mensaje entrante:
 *  1. Validar firma del webhook (KOMMO_WEBHOOK_SECRET)
 *  2. Ignorar mensajes que no sean del cliente (enviados por nosotros / agentes)
 *  3. Deduplicar por message_id (en memoria, TTL de 5 min)
 *  4. Extraer teléfono y canal del sender_id
 *  5. Llamar al pipeline del agente (processMessage)
 *  6. Guardar respuesta en campo personalizado IA_RESPUESTA
 *  7. Lanzar Salesbot para envío al cliente por WhatsApp
 *  8. Sincronizar estado del lead con Kommo (fire-and-forget)
 */

import { createHmac } from 'node:crypto';

import { processMessage } from '../../agent/index.js';
import { launchSalesbot, updateLeadCustomField, addNote, getTalkMessages, getLead } from './client.js';
import { classifyTipoConsulta, extractPhoneFromSenderId, extractChannelFromSenderId } from './classifier.js';
import { syncToKommo } from './pipeline.js';
import type { KommoMessageWebhook } from './types.js';
import type { Result } from '../../types.js';

// ===========================================================================
// Deduplicación de mensajes
// ===========================================================================

// Map de messageId → timestamp. Evita procesar el mismo mensaje dos veces
// si Kommo reintenta el webhook.
const _processedIds = new Map<string, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutos

function isDuplicate(messageId: string): boolean {
  const now = Date.now();

  // Limpiar entradas expiradas
  for (const [id, ts] of _processedIds) {
    if (now - ts > DEDUP_TTL_MS) _processedIds.delete(id);
  }

  if (_processedIds.has(messageId)) return true;
  _processedIds.set(messageId, now);
  return false;
}

// ===========================================================================
// Verificación de firma
// ===========================================================================

/**
 * Verifica que el webhook viene de Kommo usando HMAC-SHA1.
 * Kommo envía la firma en el header X-Signature como hex.
 *
 * Si KOMMO_WEBHOOK_SECRET no está configurado, se omite la verificación
 * (útil en desarrollo).
 */
export function verifyKommoSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  const secret = process.env['KOMMO_WEBHOOK_SECRET'];
  if (!secret) {
    // Sin secret configurado — skip en dev, loguear advertencia
    console.warn('[kommo] KOMMO_WEBHOOK_SECRET no configurado — verificación de firma desactivada');
    return true;
  }

  if (!signatureHeader) return false;

  const expected = createHmac('sha1', secret)
    .update(rawBody)
    .digest('hex');

  // Comparación en tiempo constante para evitar timing attacks
  return signatureHeader.length === expected.length &&
    createHmac('sha256', 'const').update(signatureHeader).digest('hex') ===
    createHmac('sha256', 'const').update(expected).digest('hex');
}

// ===========================================================================
// Helpers — parseo de application/x-www-form-urlencoded con bracket notation
// ===========================================================================

function parseBracketKey(key: string): string[] {
  // "message[add][0][text]" → ["message", "add", "0", "text"]
  return key.split(/[\[\]]+/).filter(Boolean);
}

function setNestedValue(
  obj: Record<string, unknown>,
  keys: string[],
  value: string,
): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = keys[keys.length - 1];
  if (lastKey !== undefined) current[lastKey] = value;
}

/**
 * Convierte un body application/x-www-form-urlencoded con bracket notation PHP-style
 * a un objeto JavaScript anidado.
 *
 * Ejemplo:
 *   "message[add][0][text]=hola" → { message: { add: { "0": { text: "hola" } } } }
 */
export function parseFormUrlEncoded(raw: string): Record<string, unknown> {
  const params = new URLSearchParams(raw);
  const result: Record<string, unknown> = {};
  for (const [key, value] of params) {
    setNestedValue(result, parseBracketKey(key), value);
  }
  return result;
}

// ===========================================================================
// Parseo del webhook
// ===========================================================================

/**
 * Parsea el body del webhook de Kommo.
 * Soporta dos formatos:
 *  - Formato Kommo real (form-urlencoded parseado): body.message.add["0"] contiene el mensaje
 *  - Formato JSON legacy (testing / futuro): body.message contiene el mensaje directamente
 */
export function parseKommoWebhook(body: unknown): KommoMessageWebhook | null {
  if (!body || typeof body !== 'object') {
    console.warn('[kommo:parse] null #1 — body vacío o no-objeto. tipo:', typeof body);
    return null;
  }

  const b = body as Record<string, unknown>;

  if (!b['message'] || typeof b['message'] !== 'object') {
    console.warn('[kommo:parse] null #2 — falta .message. keys recibidas:', Object.keys(b).join(', '));
    return null;
  }

  const msgRoot = b['message'] as Record<string, unknown>;

  // Formato Kommo real (form-urlencoded): message.add["0"] contiene el mensaje
  if (msgRoot['add'] && typeof msgRoot['add'] === 'object') {
    return parseKommoFormFormat(b, msgRoot);
  }

  // Formato JSON legacy: message.author existe directamente
  if (msgRoot['author'] && typeof msgRoot['author'] === 'object') {
    return parseKommoJsonFormat(b, msgRoot);
  }

  console.warn('[kommo:parse] null — estructura no reconocida. keys en .message:', Object.keys(msgRoot).join(', '));
  return null;
}

// ── Formato Kommo real (form-urlencoded parseado) ────────────────────────────

function parseKommoFormFormat(
  b: Record<string, unknown>,
  msgRoot: Record<string, unknown>,
): KommoMessageWebhook | null {
  const addObj = msgRoot['add'] as Record<string, unknown>;

  // Tomar el primer ítem (clave numérica más baja: "0", "1", …)
  const firstKey = Object.keys(addObj).sort((a, k) => Number(a) - Number(k))[0];
  if (firstKey === undefined) {
    console.warn('[kommo:parse] null — message.add vacío');
    return null;
  }

  const item = addObj[firstKey] as Record<string, unknown>;

  const text = typeof item['text'] === 'string' ? item['text'].trim() : '';
  if (!text) {
    console.warn('[kommo:parse] null — message.add[0].text ausente o vacío. keys en item:', Object.keys(item).join(', '));
    return null;
  }

  const authorRaw = typeof item['author'] === 'object' && item['author'] !== null
    ? item['author'] as Record<string, unknown>
    : {} as Record<string, unknown>;

  const authorName = typeof authorRaw['name'] === 'string' ? authorRaw['name'] : undefined;

  // En webhooks form-urlencoded, Kommo envía author.type="user" para TODOS los mensajes
  // (tanto del cliente de WhatsApp como del agente/bot). El discriminador correcto es
  // message[add][0][type]: "incoming" → cliente, "outgoing" → bot/agente.
  // Se acepta también la variante larga por compatibilidad futura.
  const messageEventType = typeof item['type'] === 'string' ? item['type'] : '';
  const rawAuthorType = authorRaw['type'];
  const authorType: 'client' | 'user' =
    (messageEventType === 'incoming'
      || messageEventType === 'incoming_chat_message'
      || rawAuthorType === 'client'
      || rawAuthorType === 'contact')
    ? 'client'
    : 'user';

  const chatId   = typeof item['chat_id'] === 'string' ? item['chat_id'] : '';
  const entityId = item['entity_id'] !== undefined ? Number(item['entity_id']) : NaN;

  // Canal: preferir prefix en author.id, fallback a origin.platform
  const originRaw = typeof item['origin'] === 'object' && item['origin'] !== null
    ? item['origin'] as Record<string, unknown>
    : {} as Record<string, unknown>;
  const originPlatform = typeof originRaw['platform'] === 'string' ? originRaw['platform'].toLowerCase() : '';

  const rawAuthorId = typeof authorRaw['id'] === 'string' ? authorRaw['id'] : '';
  const channelType = rawAuthorId.startsWith('whatsapp:') ? 'whatsapp'
    : rawAuthorId.startsWith('instagram:')              ? 'instagram'
    : rawAuthorId.startsWith('facebook:')               ? 'facebook'
    : rawAuthorId.startsWith('telegram:')               ? 'telegram'
    : (originPlatform || 'whatsapp');

  // Si author.id no tiene prefijo channel:phone (es un ID interno de Kommo),
  // construir el sender_id desde contact.phones[0] + canal detectado.
  let authorId = rawAuthorId;
  if (!rawAuthorId.includes(':')) {
    const contactRaw = typeof item['contact'] === 'object' && item['contact'] !== null
      ? item['contact'] as Record<string, unknown>
      : {} as Record<string, unknown>;
    const phonesRaw = typeof contactRaw['phones'] === 'object' && contactRaw['phones'] !== null
      ? contactRaw['phones'] as Record<string, unknown>
      : {} as Record<string, unknown>;
    const rawPhone = typeof phonesRaw['0'] === 'string' ? phonesRaw['0'].replace(/\D/g, '') : '';
    if (rawPhone) {
      authorId = `${channelType}:${rawPhone}`;
      console.info('[kommo:parse] author.id construido desde contact.phones:', authorId);
    }
  }

  const accountRaw = typeof b['account'] === 'object' && b['account'] !== null
    ? b['account'] as Record<string, unknown>
    : {} as Record<string, unknown>;
  const accountId = Number(accountRaw['id']) || 0;

  console.info(
    '[kommo:parse] formato form OK — author:', authorId,
    '| type:', authorType,
    '| chat_id:', chatId,
    '| entity_id:', entityId,
    '| text:', text.slice(0, 80),
  );

  return {
    account_id: accountId,
    time: Math.floor(Date.now() / 1000),
    message: {
      id: typeof item['id'] === 'string' ? item['id'] : '',
      type: 'text',
      text,
      author: {
        id: authorId,
        ...(authorName !== undefined && { name: authorName }),
        type: authorType,
      },
      conversation: {
        id: chatId,
        ...(Number.isFinite(entityId) && { lead_id: entityId }),
      },
      channel: {
        id: typeof item['talk_id'] === 'string' ? item['talk_id'] : '',
        type: channelType as KommoMessageWebhook['message']['channel']['type'],
      },
    },
  };
}

// ── Formato JSON legacy ───────────────────────────────────────────────────────

function parseKommoJsonFormat(
  b: Record<string, unknown>,
  msg: Record<string, unknown>,
): KommoMessageWebhook | null {
  const author = msg['author'] as Record<string, unknown>;

  if (msg['type'] !== 'text' || typeof msg['text'] !== 'string') {
    console.warn('[kommo:parse] null — JSON: tipo no es texto. type:', msg['type'], '| text type:', typeof msg['text']);
    return null;
  }

  if (!msg['conversation'] || typeof msg['conversation'] !== 'object') {
    console.warn('[kommo:parse] null — JSON: falta .message.conversation');
    return null;
  }
  const conv = msg['conversation'] as Record<string, unknown>;

  if (!msg['channel'] || typeof msg['channel'] !== 'object') {
    console.warn('[kommo:parse] null — JSON: falta .message.channel');
    return null;
  }
  const channel = msg['channel'] as Record<string, unknown>;

  console.info('[kommo:parse] formato JSON OK — author:', author['id'], '| conv:', String(conv['id']).slice(0, 8));

  return {
    account_id: typeof b['account_id'] === 'number' ? b['account_id'] : 0,
    time: typeof b['time'] === 'number' ? b['time'] : 0,
    message: {
      id: typeof msg['id'] === 'string' ? msg['id'] : '',
      type: 'text',
      text: msg['text'] as string,
      author: {
        id: typeof author['id'] === 'string' ? author['id'] : '',
        ...(typeof author['name'] === 'string' && { name: author['name'] }),
        type: author['type'] === 'client' ? 'client' : 'user',
      },
      conversation: {
        id: typeof conv['id'] === 'string' ? conv['id'] : '',
        ...(typeof conv['lead_id'] === 'number' && { lead_id: conv['lead_id'] }),
        ...(typeof conv['contact_id'] === 'number' && { contact_id: conv['contact_id'] }),
      },
      channel: {
        id: typeof channel['id'] === 'string' ? channel['id'] : '',
        type: (['whatsapp', 'instagram', 'facebook', 'telegram', 'vk'].includes(channel['type'] as string)
          ? channel['type']
          : 'whatsapp') as KommoMessageWebhook['message']['channel']['type'],
      },
    },
  };
}

// ===========================================================================
// Helpers de timing
// ===========================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const rand = (min: number, max: number): number => min + Math.random() * (max - min);

/**
 * Ventana de espera tras el último mensaje del cliente antes de empezar a
 * responder. No es solo para coalescer mensajes: es tiempo real de reacción.
 * Una persona no contesta al segundo — mira el celular cuando puede.
 * Default: 5 minutos. Cada mensaje nuevo del cliente reinicia la ventana.
 */
const DEBOUNCE_MS = Number(process.env['KOMMO_DEBOUNCE_MS'] ?? 5 * 60_000);

/** Pequeña pausa natural después de la ventana de espera, antes del primer fragmento. */
function computeInitialDelay(): number {
  return rand(1_500, 4_000);
}

/**
 * ¿Cuántos "renglones" ocupa un mensaje? Cuenta los saltos de línea explícitos
 * y además parte los renglones largos cada ~42 caracteres (como al escribir en
 * el teléfono). Mínimo 1.
 */
function contarRenglones(texto: string): number {
  return texto
    .split('\n')
    .reduce((n, linea) => n + Math.max(1, Math.ceil(linea.trim().length / 42)), 0);
}

/**
 * Tiempo de "tipeo" de un mensaje antes de enviarlo. ~2 segundos por renglón,
 * con jitter, para que un mensaje de 3 renglones tarde ~6s y uno de 1 renglón
 * ~2s — como si lo escribiera una persona. Acotado a [2s, 22s].
 */
function computeTypingDelay(texto: string): number {
  const base = contarRenglones(texto) * 2_000;
  const jitter = rand(0.85, 1.2);
  return Math.min(22_000, Math.max(2_000, base * jitter));
}

// ===========================================================================
// Handler principal
// ===========================================================================

/**
 * Procesa un webhook entrante de Kommo.
 *
 * Diseñado para ser llamado desde routes.ts y retornar rápido (< 1 seg antes de
 * que Claude responda). El sync de Kommo se hace fire-and-forget.
 */
interface LeadBuffer {
  texts: string[];
  timer: ReturnType<typeof setTimeout>;
  leadId: number | undefined;
  channel: string;
  /** talk_id de Kommo — para traer el historial de la conversación */
  talkId: string | undefined;
}

// Buffer de mensajes por lead mientras corre la ventana de debounce.
const _pending = new Map<string, LeadBuffer>();

export async function handleKommoMessage(
  payload: KommoMessageWebhook,
): Promise<Result<{ respuesta: string; escalated: boolean }>> {
  const { message } = payload;
  const { author, conversation } = message;
  const messageText = (message.text ?? '').trim();

  // ── 1. Solo procesar mensajes del cliente (no los propios del bot) ────────
  if (author.type !== 'client') {
    return { ok: true, value: { respuesta: '', escalated: false } };
  }

  // ── 2. Deduplicar ─────────────────────────────────────────────────────────
  if (!message.id || isDuplicate(message.id)) {
    console.info('[kommo] Mensaje duplicado ignorado:', message.id);
    return { ok: true, value: { respuesta: '', escalated: false } };
  }

  // ── 3. Extraer datos del cliente ──────────────────────────────────────────
  // author.id puede ser "whatsapp:5491155550001" (ideal) o un UUID interno de Kommo.
  // Si es UUID, usar conversation.id (chat UUID) como identificador estable del lead.
  const extractedPhone = extractPhoneFromSenderId(author.id);
  if (!extractedPhone && !conversation.id) {
    return {
      ok: false,
      error: Object.assign(
        new Error(`No se pudo extraer teléfono ni chat_id para sender: ${author.id}`),
        { code: 'KOMMO_INVALID_SENDER' as const }
      ),
    };
  }
  const phone = extractedPhone ?? `kommo_${conversation.id.replace(/-/g, '').slice(0, 24)}`;
  if (!extractedPhone) {
    console.warn(`[kommo] author.id sin teléfono (${author.id}) — identificador fallback: ${phone}`);
  }

  // Canal: del prefijo de author.id si lo tiene, si no del campo channel del payload
  const channelFromId = extractChannelFromSenderId(author.id);
  const channel = channelFromId !== 'web' ? channelFromId : message.channel.type;

  console.info(`[kommo] Mensaje de ${phone} vía ${channel}: "${messageText.slice(0, 80)}"`);

  // ── 3b. Allowlist de pruebas ─────────────────────────────────────────────
  // Si KOMMO_ALLOWLIST está seteada (lista separada por comas), el agente SOLO
  // responde si el phone, el id del autor o el nombre del autor contiene alguno
  // de esos textos. Vacía / sin setear = responde a todos (producción).
  const allow = (process.env['KOMMO_ALLOWLIST'] ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length > 0) {
    const huella = `${phone} ${author.id} ${author.name ?? ''}`.toLowerCase();
    if (!allow.some((a) => huella.includes(a))) {
      console.info(`[kommo] ⛔ ${phone} no está en KOMMO_ALLOWLIST — se ignora (modo prueba)`);
      return { ok: true, value: { respuesta: '', escalated: false } };
    }
  }

  // ── 3c. Filtro por etapa del lead en Kommo ────────────────────────────────
  // BLOQUEADAS SIEMPRE (pase lo que pase con la allowlist): postventa, reclamo
  // pendiente, venta cerrada. El agente NUNCA le habla a alguien ahí — evita
  // exactamente el caso "ya encargó / está reclamando" a nivel Kommo, no solo prompt.
  // KOMMO_ALLOWED_STATUS_IDS (opcional): si está seteada, solo responde a leads
  // en esas etapas (ej. "143" = Venta Perdida, para la campaña de recuperación).
  const BLOCKED_STATUS_IDS = new Set(
    (process.env['KOMMO_BLOCKED_STATUS_IDS'] ?? '142,110921483,110921487')
      .split(',').map((s) => s.trim()).filter(Boolean),
  );
  const allowedStatusIds = (process.env['KOMMO_ALLOWED_STATUS_IDS'] ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (conversation.lead_id && (BLOCKED_STATUS_IDS.size > 0 || allowedStatusIds.length > 0)) {
    const leadResult = await getLead(conversation.lead_id);
    if (leadResult.ok) {
      const statusId = String(leadResult.value.status_id);
      if (BLOCKED_STATUS_IDS.has(statusId)) {
        console.info(`[kommo] ⛔ lead ${conversation.lead_id} en etapa bloqueada (${statusId}) — se ignora`);
        return { ok: true, value: { respuesta: '', escalated: false } };
      }
      if (allowedStatusIds.length > 0 && !allowedStatusIds.includes(statusId)) {
        console.info(`[kommo] ⛔ lead ${conversation.lead_id} fuera de KOMMO_ALLOWED_STATUS_IDS (etapa ${statusId}) — se ignora`);
        return { ok: true, value: { respuesta: '', escalated: false } };
      }
    } else {
      console.warn(`[kommo] no se pudo leer etapa del lead ${conversation.lead_id}: ${leadResult.error.message}`);
    }
  }

  // ── 4. Debounce: esperar ~10s por si el cliente manda más mensajes ────────
  const talkId = message.channel.id || undefined;
  const existing = _pending.get(phone);
  if (existing) {
    clearTimeout(existing.timer);
    if (messageText) existing.texts.push(messageText);
    if (conversation.lead_id) existing.leadId = conversation.lead_id;
    if (talkId) existing.talkId = talkId;
    existing.timer = setTimeout(() => { void flushLeadTurn(phone); }, DEBOUNCE_MS);
    console.info(`[kommo] +mensaje al buffer de ${phone} (${existing.texts.length}) — reinicia ventana ${DEBOUNCE_MS}ms`);
    return { ok: true, value: { respuesta: '', escalated: false } };
  }

  _pending.set(phone, {
    texts: messageText ? [messageText] : [],
    leadId: conversation.lead_id,
    channel,
    talkId,
    timer: setTimeout(() => { void flushLeadTurn(phone); }, DEBOUNCE_MS),
  });
  console.info(`[kommo] buffer nuevo para ${phone} — ventana ${DEBOUNCE_MS}ms`);
  return { ok: true, value: { respuesta: '', escalated: false } };
}

/**
 * Se dispara cuando pasó la ventana de debounce sin mensajes nuevos.
 * Toma todo lo que el cliente escribió y lo procesa como un solo turno.
 */
async function flushLeadTurn(phone: string): Promise<void> {
  const buf = _pending.get(phone);
  _pending.delete(phone);
  if (!buf || buf.texts.length === 0) return;

  const messageText = buf.texts.join('\n');
  const { channel } = buf;
  const leadId = buf.leadId;
  console.info(`[kommo] flush ${phone}: ${buf.texts.length} mensaje(s) → 1 turno`);

  // Historial de la conversación en Kommo (lo que hablaron con los chicos ANTES
  // del bot). Clave para no responderle a alguien que ya encargó o está reclamando.
  let priorHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  if (buf.talkId) {
    const talkNum = Number(buf.talkId);
    if (Number.isFinite(talkNum)) {
      const hist = await getTalkMessages(talkNum);
      if (hist.ok) {
        priorHistory = hist.value
          .map((m) => ({
            role: (m.direction === 'incoming' ? 'user' : 'assistant') as 'user' | 'assistant',
            content: m.text.trim(),
          }))
          .filter((m) => m.content && !buf.texts.includes(m.content))
          .slice(-16);
        console.info(`[kommo] historial Kommo talk ${talkNum}: ${priorHistory.length} mensajes`);
      } else {
        console.warn(`[kommo] no se pudo traer historial del talk ${talkNum}: ${hist.error.message}`);
      }
    }
  }

  const processResult = await processMessage({
    phone,
    priorHistory,
    message: messageText,
    channel: (['whatsapp', 'instagram', 'facebook', 'web'].includes(channel)
      ? channel
      : 'web') as 'whatsapp' | 'instagram' | 'facebook' | 'web',
  });

  if (!processResult.ok) {
    console.error('[kommo] processMessage falló:', processResult.error);
    if (leadId) {
      addNote(leadId, `⚠️ Error técnico procesando mensaje: ${processResult.error.message}`)
        .catch(() => void 0);
    }
    return;
  }

  const { respuesta, agentResponse, escalated } = processResult.value;
  const fragmentos = agentResponse.fragmentos;

  // ── Modo B: el agente se calló — NO enviar nada, avisar al equipo ────────
  if (agentResponse.pasar_a_humano || !respuesta.trim()) {
    console.warn(`[kommo] 🟡 SIN RESPUESTA — ${phone}: el agente derivó a un asesor. "${messageText.slice(0, 80)}"`);
    if (leadId) {
      const esSeña = /comprobante|transferenc|transferi|se[ñn][aé]|alias|ya te pas|ac[aá] va|adjunt/i.test(messageText);
      const nota = esSeña
        ? `🔥 SEÑA / COMPROBANTE — atender YA para confirmar la reserva\nMensaje del cliente:\n"${messageText}"`
        : `🟡 El agente no respondió este mensaje (necesita un asesor):\n"${messageText}"`;
      addNote(leadId, nota).catch(() => void 0);
      const tipo = classifyTipoConsulta(messageText, agentResponse);
      syncToKommo(leadId, agentResponse, tipo, channel)
        .catch((err: unknown) => { console.error('[kommo] syncToKommo falló:', err); });
    }
    return;
  }

  // ── Fragmentación + tipeo humano + Salesbot ──────────────────────────────
  if (leadId) {
    const fieldId = Number(process.env['KOMMO_FIELD_IA_RESPUESTA'] ?? '0');
    if (fieldId > 0) {
      const parts = fragmentos ?? [respuesta];

      // Pausa natural corta tras la ventana de debounce (la espera larga ya pasó).
      const initialDelay = computeInitialDelay();
      console.info(`[FRAGMENTED] lead=${leadId} parts=${parts.length} initial_delay=${Math.round(initialDelay)}ms`);
      await sleep(initialDelay);

      // Cada fragmento se envía tras su propio tiempo de tipeo (∝ largo),
      // así los mensajes van de a poco y no los 3 de golpe.
      for (let i = 0; i < parts.length; i++) {
        const typing = computeTypingDelay(parts[i]!);
        await sleep(typing);
        console.info(`[FRAGMENT] lead=${leadId} part=${i + 1}/${parts.length} typing=${Math.round(typing)}ms`);
        const fieldResult = await updateLeadCustomField(leadId, fieldId, parts[i]!);
        if (!fieldResult.ok) console.error('[kommo] updateLeadCustomField falló:', fieldResult.error.message);
        const botResult = await launchSalesbot(leadId);
        if (!botResult.ok) console.error('[kommo] launchSalesbot falló:', botResult.error.message);
      }
    } else {
      console.warn('[kommo] KOMMO_FIELD_IA_RESPUESTA no configurado — no se puede enviar respuesta');
    }
  } else {
    console.warn('[kommo] Sin lead_id — no se puede lanzar Salesbot');
  }

  // ── Nota de atención humana (Modo A: el bot sigue hablando pero el equipo
  //    tiene que entrar) — cierre en curso, seña, comprobante, lead caliente ──
  if (leadId && agentResponse.requiere_humano) {
    const cierre = agentResponse.accion_venta === 'cierre_propuesto';
    const textoLower = messageText.toLowerCase();
    const seña = /comprobante|transfer|se[ñn][aé]|alias|ya te pas|pas[eé] la/i.test(textoLower);
    const cabecera = seña
      ? '🔥 SEÑA / COMPROBANTE — atender lo antes posible'
      : cierre
        ? '🔥 CIERRE EN CURSO — atender lo antes posible'
        : '⚠️ Lead caliente — conviene que un asesor entre';
    addNote(
      leadId,
      `${cabecera}\nÚltimo mensaje del cliente:\n"${messageText}"\n` +
      `Score: ${agentResponse.lead_score} · Estado: ${agentResponse.estado}`,
    ).catch(() => void 0);
  }

  // ── Sync con Kommo (fire-and-forget) ─────────────────────────────────────
  if (leadId) {
    const tipo = classifyTipoConsulta(messageText, agentResponse);
    syncToKommo(leadId, agentResponse, tipo, channel)
      .catch((err: unknown) => { console.error('[kommo] syncToKommo falló (no crítico):', err); });
  }

  if (escalated) {
    console.warn(`[kommo] 🔴 Lead escalado — phone: ${phone} score: ${agentResponse.lead_score}`);
  }
}
