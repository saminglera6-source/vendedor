/**
 * Acceso a datos de ai_feedback.
 *
 * Registro inmutable de correcciones humanas al agente.
 * Insert-only — no hay Update ni Delete (schema.ts lo enforza con `Update: never`).
 * Cada fila es evidencia de un error del agente que debe preservarse para auditoría
 * y para entrenar al agente en iteraciones futuras.
 *
 * Dos escritores principales:
 * 1. `language-guard.ts` — detecta frase prohibida post-generación → motivo: 'lenguaje_prohibido'
 * 2. `POST /feedback` — operador humano corrige una respuesta enviada
 */

import { db, assertOne } from './client.js';
import { ok, err, DatabaseError, type Result } from '../types.js';
import type { AiFeedbackRow, AiFeedbackInsert } from './schema.js';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

/** Motivos válidos para una corrección. Mapean 1:1 con el ENUM de la BD. */
export type AiFeedbackMotivo = NonNullable<AiFeedbackRow['motivo']>;

export interface CreateAiFeedbackInput {
  respuesta_original: string;
  respuesta_corregida: string;
  motivo: AiFeedbackMotivo;
  /** ID del mensaje específico donde ocurrió el error (si se conoce) */
  conversation_id?: string | null;
  /** ID del lead para poder cruzar con customer_memory en análisis futuros */
  lead_id?: string | null;
  /** Identificador del operador que hizo la corrección ('system' para correcciones automáticas) */
  corregido_por?: string | null;
}

// ---------------------------------------------------------------------------
// createAiFeedback
// ---------------------------------------------------------------------------

/**
 * Registra una corrección al agente.
 *
 * No lanzar esta función en el camino crítico del pipeline si puede evitarse:
 * la corrección es un efecto secundario. Si falla, el agente debe seguir
 * respondiendo. El caller decide si propagar el error o ignorarlo.
 *
 * @example
 * // En language-guard.ts, tras detectar frase prohibida:
 * await createAiFeedback({
 *   respuesta_original: generated,
 *   respuesta_corregida: regenerated,
 *   motivo: 'lenguaje_prohibido',
 *   conversation_id: convId,
 *   lead_id: leadId,
 *   corregido_por: 'system',
 * });
 */
export async function createAiFeedback(
  input: CreateAiFeedbackInput,
): Promise<Result<AiFeedbackRow>> {
  try {
    const {
      respuesta_original,
      respuesta_corregida,
      motivo,
      conversation_id = null,
      lead_id = null,
      corregido_por = null,
    } = input;

    const insert: AiFeedbackInsert = {
      respuesta_original,
      respuesta_corregida,
      motivo,
      conversation_id,
      lead_id,
      corregido_por,
    };

    const row = assertOne(
      await db.from('ai_feedback').insert(insert).select().single(),
    );

    return ok(row);
  } catch (error) {
    return toDbError(error, 'createAiFeedback');
  }
}

// ---------------------------------------------------------------------------
// Helper interno
// ---------------------------------------------------------------------------

function toDbError(error: unknown, context: string): Result<never> {
  if (error instanceof DatabaseError) return err(error);
  return err(
    new DatabaseError(
      `Error en ai-feedback.${context}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: String(error) },
    ),
  );
}
