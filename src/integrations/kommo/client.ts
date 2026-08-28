/**
 * Cliente HTTP para la API de Kommo CRM.
 *
 * Maneja autenticación OAuth 2.0 con refresh automático de tokens.
 * Los tokens se mantienen en memoria con TTL de 24h (- 5 min de margen).
 *
 * Todas las funciones retornan Result<T> — nunca lanzan excepciones al caller.
 */

import type { Result } from '../../types.js';
import type {
  KommoContact,
  KommoLead,
  KommoCustomFieldValue,
  KommoTokenResponse,
} from './types.js';

// ===========================================================================
// Auth — OAuth tokens en memoria
// ===========================================================================

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  /** Unix timestamp en segundos de cuando expira el access token. */
  expires_at: number;
}

let _tokens: StoredTokens | null = null;

function loadTokensFromEnv(): StoredTokens {
  return {
    access_token: process.env['KOMMO_ACCESS_TOKEN'] ?? '',
    refresh_token: process.env['KOMMO_REFRESH_TOKEN'] ?? '',
    expires_at: parseInt(process.env['KOMMO_TOKEN_EXPIRES_AT'] ?? '0', 10),
  };
}

async function refreshAccessToken(): Promise<Result<string>> {
  const tokens = _tokens ?? loadTokensFromEnv();

  const clientId = process.env['KOMMO_CLIENT_ID'];
  const clientSecret = process.env['KOMMO_CLIENT_SECRET'];
  const redirectUri = process.env['KOMMO_REDIRECT_URI'];

  if (!clientId || !clientSecret || !redirectUri) {
    return {
      ok: false,
      error: Object.assign(new Error('Kommo OAuth config incompleta — verificar KOMMO_CLIENT_ID, KOMMO_CLIENT_SECRET, KOMMO_REDIRECT_URI'), { code: 'KOMMO_CONFIG_MISSING' as const }),
    };
  }

  if (!tokens.refresh_token) {
    return {
      ok: false,
      error: Object.assign(new Error('KOMMO_REFRESH_TOKEN no configurado'), { code: 'KOMMO_TOKEN_MISSING' as const }),
    };
  }

  try {
    const res = await fetch('https://www.kommo.com/oauth2/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        redirect_uri: redirectUri,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error: Object.assign(new Error(`Kommo token refresh falló (${res.status}): ${text}`), { code: 'KOMMO_TOKEN_REFRESH_FAILED' as const }),
      };
    }

    const data = (await res.json()) as KommoTokenResponse;
    const now = Math.floor(Date.now() / 1000);

    _tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: now + data.expires_in,
    };

    console.info('[kommo] Token renovado — expira en', data.expires_in, 'seg');
    return { ok: true, value: _tokens.access_token };
  } catch (err) {
    return {
      ok: false,
      error: Object.assign(
        err instanceof Error ? err : new Error(String(err)),
        { code: 'KOMMO_TOKEN_FETCH_ERROR' as const }
      ),
    };
  }
}

async function getAccessToken(): Promise<Result<string>> {
  const tokens = _tokens ?? loadTokensFromEnv();
  const now = Math.floor(Date.now() / 1000);
  const BUFFER_SECS = 300;

  if (tokens.access_token && tokens.expires_at > now + BUFFER_SECS) {
    return { ok: true, value: tokens.access_token };
  }

  // Modo token de larga duración: si no hay refresh_token configurado,
  // usar el access_token directamente sin intentar renovarlo.
  if (!tokens.refresh_token) {
    if (!tokens.access_token) {
      return {
        ok: false,
        error: Object.assign(
          new Error('KOMMO_ACCESS_TOKEN no configurado'),
          { code: 'KOMMO_TOKEN_MISSING' as const },
        ),
      };
    }
    return { ok: true, value: tokens.access_token };
  }

  return refreshAccessToken();
}

// ===========================================================================
// Fetch base
// ===========================================================================

function getBaseUrl(): string {
  const subdomain = process.env['KOMMO_SUBDOMAIN'];
  if (!subdomain) throw new Error('KOMMO_SUBDOMAIN no configurado');
  return `https://${subdomain}.kommo.com`;
}

async function kommoFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<Result<T>> {
  const tokenResult = await getAccessToken();
  if (!tokenResult.ok) return tokenResult;

  let baseUrl: string;
  try {
    baseUrl = getBaseUrl();
  } catch (err) {
    return {
      ok: false,
      error: Object.assign(
        err instanceof Error ? err : new Error(String(err)),
        { code: 'KOMMO_CONFIG_MISSING' as const }
      ),
    };
  }

  const url = `${baseUrl}${path}`;

  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenResult.value}`,
        ...options.headers,
      },
    });

    // 204 No Content — operaciones sin cuerpo (typing, etc.)
    if (res.status === 204) {
      return { ok: true, value: undefined as T };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error: Object.assign(
          new Error(`Kommo API ${res.status} en ${path}: ${text}`),
          { code: 'KOMMO_API_ERROR' as const }
        ),
      };
    }

    const data = (await res.json()) as T;
    return { ok: true, value: data };
  } catch (err) {
    return {
      ok: false,
      error: Object.assign(
        err instanceof Error ? err : new Error(String(err)),
        { code: 'KOMMO_FETCH_ERROR' as const }
      ),
    };
  }
}

// ===========================================================================
// Salesbot
// ===========================================================================

/**
 * Escribe la respuesta del agente en un campo personalizado del lead.
 * El Salesbot lee el campo IA_RESPUESTA y lo envía al cliente por WhatsApp.
 */
export async function updateLeadCustomField(
  leadId: number,
  fieldId: number,
  value: string,
): Promise<Result<void>> {
  return updateLead(leadId, {
    custom_fields_values: [textField(fieldId, value)],
  });
}

/**
 * Lanza el Salesbot sobre el lead para que envíe la respuesta almacenada
 * en IA_RESPUESTA al cliente por WhatsApp.
 *
 * BOT_ID se lee de KOMMO_BOT_ID en el entorno.
 */
export async function launchSalesbot(leadId: number): Promise<Result<void>> {
  const botId = process.env['KOMMO_BOT_ID'];
  if (!botId) {
    return {
      ok: false,
      error: Object.assign(
        new Error('KOMMO_BOT_ID no configurado'),
        { code: 'KOMMO_CONFIG_MISSING' as const },
      ),
    };
  }

  const result = await kommoFetch<unknown>(`/api/v4/bots/${botId}/run`, {
    method: 'POST',
    body: JSON.stringify({ entity_id: leadId, entity_type: 'leads' }),
  });

  if (!result.ok) return result;
  return { ok: true, value: undefined };
}

// ===========================================================================
// Contactos
// ===========================================================================

export async function getContact(contactId: number): Promise<Result<KommoContact>> {
  return kommoFetch<KommoContact>(
    `/api/v4/contacts/${contactId}?with=custom_fields`,
  );
}

// ===========================================================================
// Leads
// ===========================================================================

export async function getLead(leadId: number): Promise<Result<KommoLead>> {
  return kommoFetch<KommoLead>(`/api/v4/leads/${leadId}`);
}

/**
 * Actualiza pipeline, etapa y campos personalizados de un lead.
 * Usa PATCH en lote (array de 1 elemento) que es la forma correcta de la API.
 */
export async function updateLead(
  leadId: number,
  data: {
    pipeline_id?: number;
    status_id?: number;
    custom_fields_values?: KommoCustomFieldValue[];
  },
): Promise<Result<void>> {
  const result = await kommoFetch<unknown>('/api/v4/leads', {
    method: 'PATCH',
    body: JSON.stringify([{ id: leadId, ...data }]),
  });

  if (!result.ok) return result;
  return { ok: true, value: undefined };
}

/**
 * Agrega una nota interna a un lead (visible solo para el equipo, no para el cliente).
 */
export async function addNote(leadId: number, text: string): Promise<Result<void>> {
  const result = await kommoFetch<unknown>(`/api/v4/leads/${leadId}/notes`, {
    method: 'POST',
    body: JSON.stringify([
      {
        entity_id: leadId,
        note_type: 'common',
        params: { text },
      },
    ]),
  });

  if (!result.ok) return result;
  return { ok: true, value: undefined };
}

/**
 * Crea una tarea en Kommo para el equipo humano.
 *
 * @param leadId            - Lead al que se asocia la tarea
 * @param text              - Descripción de la tarea
 * @param dueDateOffsetHours - Cuántas horas desde ahora tiene el deadline (default: 4)
 * @param responsibleUserId  - ID del usuario de Kommo responsable (opcional)
 */
export async function createTask(
  leadId: number,
  text: string,
  dueDateOffsetHours: number = 4,
  responsibleUserId?: number,
): Promise<Result<void>> {
  const completeTill = Math.floor(Date.now() / 1000) + Math.round(dueDateOffsetHours * 3600);

  const task = {
    entity_id: leadId,
    entity_type: 'leads',
    task_type_id: 1, // 1 = Llamada / Contacto (tipo más común en Kommo)
    text,
    complete_till: completeTill,
    ...(responsibleUserId !== undefined && { responsible_user_id: responsibleUserId }),
  };

  const result = await kommoFetch<unknown>('/api/v4/tasks', {
    method: 'POST',
    body: JSON.stringify([task]),
  });

  if (!result.ok) return result;
  return { ok: true, value: undefined };
}

// ===========================================================================
// Historial de conversaciones — para importación RAG
// ===========================================================================

/** GET genérico a la API de Kommo. Expuesto para scripts de importación / debug. */
export async function kommoGet<T = unknown>(path: string): Promise<Result<T>> {
  return kommoFetch<T>(path, { method: 'GET' });
}

export interface KommoTalkRef {
  talkId: number;
  /** Lead asociado a la conversación */
  leadId: number | null;
  /** Canal: instagram_business, waba, telegram, etc. */
  origin: string;
}

export interface KommoChatMessage {
  /** 'incoming' = mensaje del cliente · 'outgoing' = respuesta nuestra */
  direction: 'incoming' | 'outgoing';
  /** Texto del mensaje (vacío para adjuntos sin texto) */
  text: string;
  /** Unix timestamp en segundos */
  createdAt: number;
}

interface TalksResponse {
  _embedded?: { talks?: Array<Record<string, unknown>> };
  _links?: { next?: { href?: string } };
}

interface TalkMessagesResponse {
  _embedded?: { messages?: Array<Record<string, unknown>> };
  _links?: { next?: { href?: string } };
}

/**
 * Descarga una página de conversaciones (talks) de la cuenta.
 *
 * @param page  - número de página (1-based)
 * @param limit - talks por página (máx 250)
 */
export async function listTalksPage(
  page: number,
  limit = 250,
): Promise<Result<{ talks: KommoTalkRef[]; hasNext: boolean }>> {
  const result = await kommoFetch<TalksResponse>(
    `/api/v4/talks?page=${page}&limit=${limit}`,
    { method: 'GET' },
  );
  if (!result.ok) return result;
  if (!result.value) return { ok: true, value: { talks: [], hasNext: false } };

  const raw = result.value._embedded?.talks ?? [];
  const talks: KommoTalkRef[] = raw.map((t) => {
    const entityType = typeof t['entity_type'] === 'string' ? t['entity_type'] : '';
    const entityId = Number(t['entity_id']);
    return {
      talkId: Number(t['talk_id']),
      leadId: entityType === 'lead' && Number.isFinite(entityId) ? entityId : null,
      origin: typeof t['origin'] === 'string' ? t['origin'] : 'unknown',
    };
  }).filter((t) => Number.isFinite(t.talkId));

  const hasNext = Boolean(result.value._links?.next?.href) || raw.length === limit;
  return { ok: true, value: { talks, hasNext } };
}

/**
 * Descarga todos los mensajes de una conversación (talk), paginando internamente.
 * Devuelve los mensajes de texto en orden cronológico ascendente.
 */
export async function getTalkMessages(
  talkId: number,
  maxPages = 20,
): Promise<Result<KommoChatMessage[]>> {
  const out: KommoChatMessage[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const result = await kommoFetch<TalkMessagesResponse>(
      `/api/v4/talks/${talkId}/messages?page=${page}&limit=250`,
      { method: 'GET' },
    );
    if (!result.ok) return result;
    if (!result.value) break;

    const raw = result.value._embedded?.messages ?? [];
    for (const m of raw) {
      const messageType = typeof m['message_type'] === 'string' ? m['message_type'] : '';
      const text = typeof m['text'] === 'string' ? m['text'].trim() : '';
      if (messageType !== 'text' || !text) continue;
      // Placeholder de Kommo para mensajes previos a conectar el canal
      if (text.startsWith('This message contains media and was received')) continue;

      const type = typeof m['type'] === 'string' ? m['type'] : '';
      const createdAt = Number(m['created_at']);
      out.push({
        direction: type === 'outgoing' ? 'outgoing' : 'incoming',
        text,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      });
    }

    if (!result.value._links?.next?.href && raw.length < 250) break;
  }

  out.sort((a, b) => a.createdAt - b.createdAt);
  return { ok: true, value: out };
}

// ===========================================================================
// Helpers para campos personalizados
// ===========================================================================

/**
 * Construye un KommoCustomFieldValue para un campo de tipo texto.
 */
export function textField(fieldId: number, value: string): KommoCustomFieldValue {
  return { field_id: fieldId, values: [{ value }] };
}

/**
 * Construye un KommoCustomFieldValue para un campo de tipo número.
 */
export function numberField(fieldId: number, value: number): KommoCustomFieldValue {
  return { field_id: fieldId, values: [{ value }] };
}

/**
 * Construye un KommoCustomFieldValue para un campo de tipo checkbox.
 */
export function boolField(fieldId: number, value: boolean): KommoCustomFieldValue {
  return { field_id: fieldId, values: [{ value }] };
}
