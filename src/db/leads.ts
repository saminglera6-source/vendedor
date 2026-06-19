/**
 * Acceso a datos de leads.
 *
 * Toda query a la tabla `leads` pasa por este módulo.
 * El resto de la aplicación nunca importa el cliente de Supabase directamente.
 */

import {
  db,
  assertOne,
  assertDataOrNull,
  assertData,
  toISOString,
} from './client.js';
import {
  ok,
  err,
  clampScore,
  DatabaseError,
  LEAD_ESTADO,
  ESTADOS_ACTIVOS,
  type Lead,
  type LeadEstado,
  type LeadChannel,
  type Result,
} from '../types.js';
import type { LeadUpdate } from './schema.js';

// ---------------------------------------------------------------------------
// Tipos de entrada públicos
// ---------------------------------------------------------------------------

export interface CreateLeadInput {
  phone: string;
  channel?: LeadChannel;
  name?: string | null;
}

export interface UpdateLeadInput {
  name?: string | null;
  channel?: LeadChannel;
  requiere_humano?: boolean;
}

export interface GetHotLeadsOptions {
  /** Score mínimo para considerar un lead "caliente". Default: 60 */
  minScore?: number;
  /** Máximo de resultados. Default: 50 */
  limit?: number;
}

export interface GetLostLeadsOptions {
  /** Score mínimo para intentar recuperación. Default: 30 */
  minScore?: number;
  /** Máximo de resultados. Default: 50 */
  limit?: number;
}

// ---------------------------------------------------------------------------
// createLead
// ---------------------------------------------------------------------------

/**
 * Crea un nuevo lead o devuelve el existente si el teléfono ya está registrado.
 * El agente llama esta función en cada mensaje entrante (paso 1 del pipeline).
 *
 * Semántica: get-or-create por `phone`.
 */
export async function createLead(
  input: CreateLeadInput,
): Promise<Result<Lead>> {
  try {
    const { phone, channel = 'whatsapp', name = null } = input;

    // Buscar lead existente primero para no pisar estado/score
    const existing = assertDataOrNull(
      await db
        .from('leads')
        .select('*')
        .eq('phone', phone)
        .maybeSingle(),
    );

    if (existing) return ok(existing);

    const created = assertOne(
      await db
        .from('leads')
        .insert({ phone, channel, name })
        .select()
        .single(),
    );

    return ok(created);
  } catch (error) {
    return toDbError(error, 'createLead');
  }
}

// ---------------------------------------------------------------------------
// updateLead
// ---------------------------------------------------------------------------

/**
 * Actualiza campos generales del lead (no score ni estado — usar funciones
 * específicas para esos cambios).
 */
export async function updateLead(
  leadId: string,
  input: UpdateLeadInput,
): Promise<Result<Lead>> {
  try {
    const patch: LeadUpdate = {
      ...input,
      updated_at: toISOString(),
    };

    const updated = assertOne(
      await db
        .from('leads')
        .update(patch)
        .eq('id', leadId)
        .select()
        .single(),
    );

    return ok(updated);
  } catch (error) {
    return toDbError(error, 'updateLead');
  }
}

// ---------------------------------------------------------------------------
// updateLeadScore
// ---------------------------------------------------------------------------

/**
 * Actualiza el lead_score con el valor ya calculado por el agente.
 * Clampea automáticamente al rango [0, 100].
 *
 * El agente es responsable de computar el nuevo score (sumar deltas de
 * LEAD_SCORE_DELTA). Esta función solo lo persiste.
 *
 * NOTA: no hay transacción atómica en V1 — si dos requests concurrentes
 * actualizan el score del mismo lead, puede haber race condition.
 * Para alto volumen, reemplazar con una función RPC de PostgreSQL.
 */
export async function updateLeadScore(
  leadId: string,
  newScore: number,
): Promise<Result<Lead>> {
  try {
    const updated = assertOne(
      await db
        .from('leads')
        .update({
          lead_score: clampScore(newScore),
          updated_at: toISOString(),
        })
        .eq('id', leadId)
        .select()
        .single(),
    );

    return ok(updated);
  } catch (error) {
    return toDbError(error, 'updateLeadScore');
  }
}

// ---------------------------------------------------------------------------
// updateLeadEstado
// ---------------------------------------------------------------------------

/**
 * Cambia el estado comercial de un lead.
 * También actualiza `last_contact` para que los cron jobs de detección
 * de leads perdidos calculen bien el tiempo de inactividad.
 */
export async function updateLeadEstado(
  leadId: string,
  estado: LeadEstado,
): Promise<Result<Lead>> {
  try {
    const now = toISOString();

    const updated = assertOne(
      await db
        .from('leads')
        .update({
          estado,
          last_contact: now,
          updated_at: now,
        })
        .eq('id', leadId)
        .select()
        .single(),
    );

    return ok(updated);
  } catch (error) {
    return toDbError(error, 'updateLeadEstado');
  }
}

// ---------------------------------------------------------------------------
// Combinación score + estado + last_contact en una sola query
// ---------------------------------------------------------------------------

/**
 * Actualiza score, estado, requiere_humano y last_contact en una sola query.
 * Usar en el pipeline del agente (paso 11) para minimizar round-trips.
 */
export async function syncLeadAfterMessage(
  leadId: string,
  opts: {
    lead_score: number;
    estado: LeadEstado;
    requiere_humano: boolean;
  },
): Promise<Result<Lead>> {
  try {
    const now = toISOString();

    const updated = assertOne(
      await db
        .from('leads')
        .update({
          lead_score: clampScore(opts.lead_score),
          estado: opts.estado,
          requiere_humano: opts.requiere_humano,
          last_contact: now,
          updated_at: now,
        })
        .eq('id', leadId)
        .select()
        .single(),
    );

    return ok(updated);
  } catch (error) {
    return toDbError(error, 'syncLeadAfterMessage');
  }
}

// ---------------------------------------------------------------------------
// findLeadByContact
// ---------------------------------------------------------------------------

/**
 * Busca un lead por número de teléfono.
 * Retorna null si no existe (no lanza error).
 */
export async function findLeadByContact(
  phone: string,
): Promise<Result<Lead | null>> {
  try {
    const lead = assertDataOrNull(
      await db
        .from('leads')
        .select('*')
        .eq('phone', phone)
        .maybeSingle(),
    );

    return ok(lead);
  } catch (error) {
    return toDbError(error, 'findLeadByContact');
  }
}

// ---------------------------------------------------------------------------
// getHotLeads
// ---------------------------------------------------------------------------

/**
 * Leads activos con score alto que merecen atención inmediata.
 *
 * Criterios:
 * - estado activo (no CLIENTE ni PERDIDO)
 * - lead_score >= minScore
 * - requiere_humano = false (los que requieren humano ya están en otra cola)
 *
 * Ordenados por score DESC, luego por last_contact DESC (más recientes primero).
 */
export async function getHotLeads(
  opts: GetHotLeadsOptions = {},
): Promise<Result<Lead[]>> {
  const { minScore = 60, limit = 50 } = opts;

  try {
    const leads = assertData(
      await db
        .from('leads')
        .select('*')
        .in('estado', ESTADOS_ACTIVOS as unknown as string[])
        .gte('lead_score', minScore)
        .eq('requiere_humano', false)
        .order('lead_score', { ascending: false })
        .order('last_contact', { ascending: false })
        .limit(limit),
    );

    return ok(leads);
  } catch (error) {
    return toDbError(error, 'getHotLeads');
  }
}

// ---------------------------------------------------------------------------
// getLostLeads
// ---------------------------------------------------------------------------

/**
 * Leads en estado PERDIDO que tienen score suficiente para valer un intento
 * de recuperación.
 *
 * El cron `detect-lost-leads.ts` los filtra adicionalmente por tiempo
 * desde el último followup antes de crear uno nuevo.
 */
export async function getLostLeads(
  opts: GetLostLeadsOptions = {},
): Promise<Result<Lead[]>> {
  const { minScore = 30, limit = 50 } = opts;

  try {
    const leads = assertData(
      await db
        .from('leads')
        .select('*')
        .eq('estado', LEAD_ESTADO.PERDIDO)
        .gte('lead_score', minScore)
        .order('lead_score', { ascending: false })
        .order('last_contact', { ascending: false })
        .limit(limit),
    );

    return ok(leads);
  } catch (error) {
    return toDbError(error, 'getLostLeads');
  }
}

// ---------------------------------------------------------------------------
// getLeads — listado con filtros, para la API REST
// ---------------------------------------------------------------------------

export interface GetLeadsOptions {
  /** Filtrar por estado exacto. Si se omite, devuelve todos los estados. */
  estado?: LeadEstado;
  /** Score mínimo inclusivo. Default: 0 */
  minScore?: number;
  /** Máximo de resultados. Default: 50, máximo: 200 */
  limit?: number;
}

/**
 * Lista leads con filtros opcionales por estado y score.
 * Ordenados por lead_score DESC, luego last_contact DESC.
 * Usado por GET /leads de la API REST.
 */
export async function getLeads(
  opts: GetLeadsOptions = {},
): Promise<Result<Lead[]>> {
  const { estado, minScore = 0, limit = 50 } = opts;
  const effectiveLimit = Math.min(limit, 200);

  try {
    // Construir la query base con filtros comunes
    const baseQuery = db
      .from('leads')
      .select('*')
      .gte('lead_score', clampScore(minScore))
      .order('lead_score', { ascending: false })
      .order('last_contact', { ascending: false })
      .limit(effectiveLimit);

    // El filtro de estado se aplica condicionalmente porque Supabase no tiene
    // un método "maybe-filter" nativo — se bifurca la query.
    const leads = assertData(
      estado !== undefined
        ? await baseQuery.eq('estado', estado)
        : await baseQuery,
    );

    return ok(leads);
  } catch (error) {
    return toDbError(error, 'getLeads');
  }
}

// ---------------------------------------------------------------------------
// getLeadById (helper interno, útil para cron jobs)
// ---------------------------------------------------------------------------

export async function getLeadById(
  leadId: string,
): Promise<Result<Lead | null>> {
  try {
    const lead = assertDataOrNull(
      await db
        .from('leads')
        .select('*')
        .eq('id', leadId)
        .maybeSingle(),
    );

    return ok(lead);
  } catch (error) {
    return toDbError(error, 'getLeadById');
  }
}

// ---------------------------------------------------------------------------
// Helper interno de manejo de errores
// ---------------------------------------------------------------------------

function toDbError(error: unknown, context: string): Result<never> {
  if (error instanceof DatabaseError) return err(error);
  return err(
    new DatabaseError(
      `Error en leads.${context}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: String(error) },
    ),
  );
}
