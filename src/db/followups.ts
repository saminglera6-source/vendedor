/**
 * Acceso a datos de followups.
 *
 * Cola de seguimientos programados. Regla central (CLAUDE.md §15):
 * un lead nunca tiene más de 1 followup pending simultáneo.
 * `createFollowup` cancela el anterior antes de insertar el nuevo.
 */

import {
  db,
  assertData,
  assertOne,
  assertDataOrNull,
  toISOString,
  nowPlusHours,
} from './client.js';
import { ok, err, DatabaseError, type Result } from '../types.js';
import type { FollowupRow, FollowupInsert } from './schema.js';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type FollowupTipo = FollowupRow['tipo'];
export type FollowupStatus = FollowupRow['status'];

export interface CreateFollowupInput {
  lead_id: string;
  tipo: FollowupTipo;
  /** Horas desde ahora para calcular scheduled_at */
  delay_hours: number;
  /** Contexto que el cron usa para personalizar el mensaje — nunca se envía crudo */
  mensaje_base?: string | null;
}

// ---------------------------------------------------------------------------
// createFollowup
// ---------------------------------------------------------------------------

/**
 * Crea un followup para el lead, cancelando cualquier pending previo.
 *
 * La cancelación y la inserción son dos queries separadas (sin transacción
 * explícita en V1). Si la inserción falla después de la cancelación, el lead
 * queda sin followup activo — el cron de detect-lost-leads lo recuperará.
 * Trade-off aceptable para la complejidad que agrega una transacción explícita.
 */
export async function createFollowup(
  input: CreateFollowupInput,
): Promise<Result<FollowupRow>> {
  try {
    const { lead_id, tipo, delay_hours, mensaje_base = null } = input;

    // Cancelar pending existentes en línea — mantiene todos los errores
    // en el mismo try/catch sin anidar Result<T> de otra función exportada.
    const { error: cancelError } = await db
      .from('followups')
      .update({ status: 'cancelled' })
      .eq('lead_id', lead_id)
      .eq('status', 'pending');

    if (cancelError) {
      throw new DatabaseError(cancelError.message, {
        code: cancelError.code,
        details: cancelError.details,
        hint: cancelError.hint,
      });
    }

    const scheduled_at = nowPlusHours(delay_hours);

    const insert: FollowupInsert = {
      lead_id,
      tipo,
      mensaje_base,
      scheduled_at,
      status: 'pending',
    };

    const row = assertOne(
      await db.from('followups').insert(insert).select().single(),
    );

    return ok(row);
  } catch (error) {
    return toDbError(error, 'createFollowup');
  }
}

// ---------------------------------------------------------------------------
// markFollowupSent
// ---------------------------------------------------------------------------

/**
 * Marca un followup como enviado y registra el timestamp de ejecución.
 * El cron `send-followups.ts` llama esta función tras enviar el mensaje.
 */
export async function markFollowupSent(
  followupId: string,
): Promise<Result<FollowupRow>> {
  try {
    const now = toISOString();

    const row = assertOne(
      await db
        .from('followups')
        .update({ status: 'sent', executed_at: now })
        .eq('id', followupId)
        .select()
        .single(),
    );

    return ok(row);
  } catch (error) {
    return toDbError(error, 'markFollowupSent');
  }
}

// ---------------------------------------------------------------------------
// markFollowupFailed
// ---------------------------------------------------------------------------

/**
 * Marca un followup como fallido sin reintento automático.
 * Los registros 'failed' quedan disponibles para auditoría en el dashboard.
 */
export async function markFollowupFailed(
  followupId: string,
): Promise<Result<FollowupRow>> {
  try {
    const now = toISOString();

    const row = assertOne(
      await db
        .from('followups')
        .update({ status: 'failed', executed_at: now })
        .eq('id', followupId)
        .select()
        .single(),
    );

    return ok(row);
  } catch (error) {
    return toDbError(error, 'markFollowupFailed');
  }
}

// ---------------------------------------------------------------------------
// cancelPendingFollowups
// ---------------------------------------------------------------------------

/**
 * Cancela todos los followups pending de un lead.
 *
 * Llamar cuando el lead responde — su respuesta activa reemplaza
 * cualquier seguimiento programado (CLAUDE.md §15).
 *
 * Retorna la cantidad de followups cancelados (0 es válido).
 */
export async function cancelPendingFollowups(
  leadId: string,
): Promise<Result<number>> {
  try {
    const rows = assertData(
      await db
        .from('followups')
        .update({ status: 'cancelled' })
        .eq('lead_id', leadId)
        .eq('status', 'pending')
        .select(),
    );

    return ok(rows.length);
  } catch (error) {
    return toDbError(error, 'cancelPendingFollowups');
  }
}

// ---------------------------------------------------------------------------
// getPendingDueFollowups
// ---------------------------------------------------------------------------

/**
 * Devuelve followups pendientes con scheduled_at en el pasado.
 * Llamado por el cron `send-followups.ts` cada 15 minutos.
 *
 * Ordenados ASC por scheduled_at para procesar los más viejos primero
 * y evitar que un backlog invierta el orden cronológico de seguimientos.
 */
export async function getPendingDueFollowups(
  limit = 50,
): Promise<Result<FollowupRow[]>> {
  try {
    const now = toISOString();

    const rows = assertData(
      await db
        .from('followups')
        .select('*')
        .eq('status', 'pending')
        .lte('scheduled_at', now)
        .order('scheduled_at', { ascending: true })
        .limit(limit),
    );

    return ok(rows);
  } catch (error) {
    return toDbError(error, 'getPendingDueFollowups');
  }
}

// ---------------------------------------------------------------------------
// getPendingFollowupForLead
// ---------------------------------------------------------------------------

/**
 * Devuelve el followup pending activo del lead, o null si no tiene.
 * Útil en el pipeline para inspeccionar el estado antes de crear uno nuevo,
 * aunque `createFollowup` siempre cancela el anterior de todos modos.
 */
export async function getPendingFollowupForLead(
  leadId: string,
): Promise<Result<FollowupRow | null>> {
  try {
    // limit(1) + maybeSingle() — ORDER BY garantiza que si hay varios (no debería)
    // se retorna el que está por vencer primero.
    const row = assertDataOrNull(
      await db
        .from('followups')
        .select('*')
        .eq('lead_id', leadId)
        .eq('status', 'pending')
        .order('scheduled_at', { ascending: true })
        .maybeSingle(),
    );

    return ok(row);
  } catch (error) {
    return toDbError(error, 'getPendingFollowupForLead');
  }
}

// ---------------------------------------------------------------------------
// Helper interno
// ---------------------------------------------------------------------------

function toDbError(error: unknown, context: string): Result<never> {
  if (error instanceof DatabaseError) return err(error);
  return err(
    new DatabaseError(
      `Error en followups.${context}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: String(error) },
    ),
  );
}
