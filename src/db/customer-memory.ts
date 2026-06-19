/**
 * Acceso a datos de customer_memory.
 * Una fila por lead (UNIQUE lead_id). Upsert en cada actualización.
 */

import { db, assertDataOrNull, assertOne, toISOString } from './client.js';
import {
  ok,
  err,
  DatabaseError,
  type CustomerMemory,
  type CustomerMemoryPatch,
  type CustomerRawPreferences,
  type Result,
} from '../types.js';

// ---------------------------------------------------------------------------
// getMemory
// ---------------------------------------------------------------------------

/** Devuelve la memoria comercial de un lead, o null si todavía no existe. */
export async function getMemory(
  leadId: string,
): Promise<Result<CustomerMemory | null>> {
  try {
    const row = assertDataOrNull(
      await db
        .from('customer_memory')
        .select('*')
        .eq('lead_id', leadId)
        .maybeSingle(),
    );

    if (!row) return ok(null);

    return ok({
      ...row,
      raw_preferences: (row.raw_preferences ?? {}) as CustomerRawPreferences,
    });
  } catch (error) {
    return toDbError(error, 'getMemory');
  }
}

// ---------------------------------------------------------------------------
// upsertMemory
// ---------------------------------------------------------------------------

/**
 * Crea o actualiza la memoria comercial de un lead.
 *
 * Para raw_preferences hace merge con el valor existente en la DB, no reemplaza.
 * Así los datos de sesiones anteriores no se pierden al actualizar un campo.
 */
export async function upsertMemory(
  leadId: string,
  patch: CustomerMemoryPatch,
): Promise<Result<CustomerMemory>> {
  try {
    // Si hay raw_preferences en el patch, mergear con lo existente
    let mergedRaw: CustomerRawPreferences | undefined;

    if (patch.raw_preferences !== undefined) {
      const existing = assertDataOrNull(
        await db
          .from('customer_memory')
          .select('raw_preferences')
          .eq('lead_id', leadId)
          .maybeSingle(),
      );

      mergedRaw = {
        ...((existing?.raw_preferences as CustomerRawPreferences) ?? {}),
        ...patch.raw_preferences,
      };
    }

    const row = assertOne(
      await db
        .from('customer_memory')
        .upsert(
          {
            lead_id: leadId,
            ...patch,
            ...(mergedRaw !== undefined ? { raw_preferences: mergedRaw } : {}),
            updated_at: toISOString(),
          },
          { onConflict: 'lead_id' },
        )
        .select()
        .single(),
    );

    return ok({
      ...row,
      raw_preferences: (row.raw_preferences ?? {}) as CustomerRawPreferences,
    });
  } catch (error) {
    return toDbError(error, 'upsertMemory');
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function toDbError(error: unknown, context: string): Result<never> {
  if (error instanceof DatabaseError) return err(error);
  return err(
    new DatabaseError(
      `Error en customer-memory.${context}: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
}
