/**
 * Acceso a datos de conversaciones.
 *
 * Las conversaciones son inmutables: se insertan mensajes, nunca se editan.
 * Cada fila en `conversations` es un mensaje individual (user o assistant).
 *
 * El historial se carga en orden cronológico (más antiguo primero) para
 * pasarlo directamente como `messages` en la API de Claude.
 */

import { db, assertOne, assertDataOrNull, assertData } from './client.js';
import {
  ok,
  err,
  DatabaseError,
  type ConversationMetadata,
  type Result,
} from '../types.js';
import type { ConversationRow } from './schema.js';

// ---------------------------------------------------------------------------
// Tipos de entrada públicos
// ---------------------------------------------------------------------------

export interface AppendMessageInput {
  lead_id: string;
  role: 'user' | 'assistant';
  content: string;
  metadata?: ConversationMetadata;
}

/**
 * Formato mínimo para pasar el historial al prompt de Claude.
 * Ver AgentContext.history en types.ts.
 */
export interface MessageForPrompt {
  role: 'user' | 'assistant';
  content: string;
}

// ---------------------------------------------------------------------------
// createConversation
// ---------------------------------------------------------------------------

/**
 * Registra el primer mensaje de una nueva conversación (siempre del usuario).
 * Equivalent a `appendMessage` con role: 'user', pero semánticamente indica
 * el inicio de un nuevo intercambio.
 *
 * El pipeline del agente llama a esta función cuando es el primer mensaje
 * del lead, o usa `appendMessage` para los mensajes siguientes.
 */
export async function createConversation(
  leadId: string,
  userMessage: string,
  metadata: ConversationMetadata = {},
): Promise<Result<ConversationRow>> {
  return appendMessage({
    lead_id: leadId,
    role: 'user',
    content: userMessage,
    metadata,
  });
}

// ---------------------------------------------------------------------------
// appendMessage
// ---------------------------------------------------------------------------

/**
 * Agrega un mensaje al historial de un lead.
 *
 * El pipeline del agente lo llama dos veces por turno:
 *   1. role: 'user'      — con el mensaje del cliente
 *   2. role: 'assistant' — con la respuesta generada y metadata (intencion, accion_venta, etc.)
 */
export async function appendMessage(
  input: AppendMessageInput,
): Promise<Result<ConversationRow>> {
  try {
    const row = assertOne(
      await db
        .from('conversations')
        .insert({
          lead_id: input.lead_id,
          role: input.role,
          content: input.content,
          metadata: (input.metadata ?? {}) as Record<string, unknown>,
        })
        .select()
        .single(),
    );

    return ok(row);
  } catch (error) {
    return toDbError(error, 'appendMessage');
  }
}

// ---------------------------------------------------------------------------
// getConversation
// ---------------------------------------------------------------------------

/**
 * Obtiene un mensaje individual por ID.
 * Útil para recuperar el conversation_id al registrar ai_feedback.
 */
export async function getConversation(
  conversationId: string,
): Promise<Result<ConversationRow | null>> {
  try {
    const row = assertDataOrNull(
      await db
        .from('conversations')
        .select('*')
        .eq('id', conversationId)
        .maybeSingle(),
    );

    return ok(row);
  } catch (error) {
    return toDbError(error, 'getConversation');
  }
}

// ---------------------------------------------------------------------------
// getConversationHistory
// ---------------------------------------------------------------------------

/**
 * Devuelve los últimos N mensajes de un lead, ordenados de más antiguo a
 * más reciente (cronológico), listos para pasarlos como contexto a Claude.
 *
 * @param leadId   - ID del lead
 * @param limit    - Cuántos mensajes traer. Default: 20 (ver CLAUDE.md pipeline paso 4)
 * @param asPrompt - Si true, devuelve solo { role, content } para el prompt
 */
export async function getConversationHistory(
  leadId: string,
  limit = 20,
): Promise<Result<ConversationRow[]>> {
  try {
    // Traer los últimos `limit` mensajes en orden DESCENDENTE
    // y luego revertir para obtener orden cronológico
    const rows = assertData(
      await db
        .from('conversations')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false })
        .limit(limit),
    );

    // Revertir: la DB devuelve [más reciente, ..., más antiguo]
    // El prompt de Claude necesita [más antiguo, ..., más reciente]
    return ok(rows.reverse());
  } catch (error) {
    return toDbError(error, 'getConversationHistory');
  }
}

/**
 * Variante que devuelve solo { role, content } para inyectar directamente
 * en el array `messages` de la API de Claude.
 */
export async function getHistoryForPrompt(
  leadId: string,
  limit = 20,
): Promise<Result<MessageForPrompt[]>> {
  const result = await getConversationHistory(leadId, limit);
  if (!result.ok) return result;

  return ok(
    result.value.map((row) => ({
      role: row.role as 'user' | 'assistant',
      content: row.content,
    })),
  );
}

// ---------------------------------------------------------------------------
// getRecentConversations
// ---------------------------------------------------------------------------

/**
 * Devuelve los mensajes más recientes de todos los leads.
 * Diseñado para monitoreo operativo: ver qué leads están activos ahora mismo.
 *
 * @param limit - Cuántos mensajes traer. Default: 30
 */
export async function getRecentConversations(
  limit = 30,
): Promise<Result<ConversationRow[]>> {
  try {
    const rows = assertData(
      await db
        .from('conversations')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit),
    );

    return ok(rows);
  } catch (error) {
    return toDbError(error, 'getRecentConversations');
  }
}

// ---------------------------------------------------------------------------
// getLastMessage (helper para cron jobs)
// ---------------------------------------------------------------------------

/**
 * Devuelve el mensaje más reciente de un lead.
 * Usado por el cron detect-lost-leads para revisar actividad reciente.
 */
export async function getLastMessage(
  leadId: string,
): Promise<Result<ConversationRow | null>> {
  try {
    const row = assertDataOrNull(
      await db
        .from('conversations')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    );

    return ok(row);
  } catch (error) {
    return toDbError(error, 'getLastMessage');
  }
}

// ---------------------------------------------------------------------------
// countMessages (helper para decidir cuándo regenerar resumen_comercial)
// ---------------------------------------------------------------------------

/**
 * Cuenta mensajes de un lead desde una fecha dada.
 * El agente usa esto para saber cuándo regenerar resumen_comercial (cada 5 mensajes).
 */
export async function countMessagesSince(
  leadId: string,
  since: string,
): Promise<Result<number>> {
  try {
    const { count, error } = await db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('lead_id', leadId)
      .gte('created_at', since);

    if (error) {
      throw new DatabaseError(error.message, { code: error.code });
    }

    return ok(count ?? 0);
  } catch (error) {
    return toDbError(error, 'countMessagesSince');
  }
}

// ---------------------------------------------------------------------------
// Helper interno
// ---------------------------------------------------------------------------

function toDbError(error: unknown, context: string): Result<never> {
  if (error instanceof DatabaseError) return err(error);
  return err(
    new DatabaseError(
      `Error en conversations.${context}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: String(error) },
    ),
  );
}
