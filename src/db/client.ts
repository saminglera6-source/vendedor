/**
 * Cliente Supabase singleton para vendedor-ia.
 *
 * Usa SUPABASE_SERVICE_KEY (service_role) que bypasea RLS.
 * NUNCA usar la anon key en el servidor — expone datos de todos los leads.
 *
 * Exporta:
 * - `db` — cliente tipado listo para usar
 * - `assertData` / `assertOne` — helpers para manejar errores de Supabase
 * - `toISOString` — normalizar fechas para columnas TIMESTAMPTZ
 *
 * Dependencias: @supabase/supabase-js ^2.0.0
 */

import { createClient, type SupabaseClient, type PostgrestError } from '@supabase/supabase-js';
import type { Database } from './schema.js';
import { DatabaseError } from '../types.js';

// ---------------------------------------------------------------------------
// Validación de entorno — falla rápido en lugar de errores crípticos en runtime
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Variable de entorno requerida no definida: ${name}\n` +
        'Asegurate de que el archivo .env esté cargado correctamente.',
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Singleton del cliente
// ---------------------------------------------------------------------------

let _client: SupabaseClient<Database> | null = null;

/**
 * Retorna el cliente Supabase tipado.
 * Inicializado en el primer uso (lazy singleton).
 */
export function getClient(): SupabaseClient<Database> {
  if (_client) return _client;

  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_KEY');

  _client = createClient<Database>(url, key, {
    auth: {
      // El service_role no necesita sesión de usuario
      persistSession: false,
      autoRefreshToken: false,
    },
    db: {
      schema: 'public',
    },
  });

  return _client;
}

/**
 * Alias corto para uso en módulos db/*.
 * `db.from('leads').select(...)` en lugar de `getClient().from(...)`
 */
export const db: SupabaseClient<Database> = new Proxy({} as SupabaseClient<Database>, {
  get(_target, prop) {
    return (getClient() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

// ---------------------------------------------------------------------------
// Helpers de manejo de errores
// ---------------------------------------------------------------------------

/**
 * Lanza DatabaseError si Supabase devolvió un error.
 * Retorna el data tipado si todo está bien.
 *
 * @example
 * const leads = assertData(await db.from('leads').select('*'))
 */
export function assertData<T>(result: {
  data: T | null;
  error: PostgrestError | null;
}): T {
  if (result.error) {
    throw new DatabaseError(result.error.message, {
      code: result.error.code,
      details: result.error.details,
      hint: result.error.hint,
    });
  }
  if (result.data === null) {
    throw new DatabaseError('La query devolvió null inesperadamente');
  }
  return result.data;
}

/**
 * Como assertData pero además verifica que haya exactamente un resultado.
 * Útil para queries por PK o UNIQUE.
 *
 * @example
 * const lead = assertOne(await db.from('leads').select('*').eq('phone', phone).single())
 */
export function assertOne<T>(result: {
  data: T | null;
  error: PostgrestError | null;
}): T {
  if (result.error) {
    throw new DatabaseError(result.error.message, {
      code: result.error.code,
      details: result.error.details,
    });
  }
  if (result.data === null) {
    throw new DatabaseError('Registro no encontrado');
  }
  return result.data;
}

/**
 * Como assertData pero retorna null si no se encontró el registro
 * en lugar de lanzar error. Para queries que pueden devolver 0 resultados.
 *
 * @example
 * const memory = assertDataOrNull(
 *   await db.from('customer_memory').select('*').eq('lead_id', id).maybeSingle()
 * )
 */
export function assertDataOrNull<T>(result: {
  data: T | null;
  error: PostgrestError | null;
}): T | null {
  if (result.error) {
    throw new DatabaseError(result.error.message, {
      code: result.error.code,
    });
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Helpers de fecha
// ---------------------------------------------------------------------------

/** Convierte Date a string ISO 8601 para columnas TIMESTAMPTZ de Supabase */
export function toISOString(date: Date = new Date()): string {
  return date.toISOString();
}

/**
 * Suma horas a la fecha actual y devuelve string para TIMESTAMPTZ.
 * Usado para calcular scheduled_at en followups.
 */
export function nowPlusHours(hours: number): string {
  const date = new Date();
  date.setTime(date.getTime() + hours * 60 * 60 * 1000);
  return date.toISOString();
}

/**
 * Suma días a la fecha actual.
 * Usado para calcular intervalos de recuperación de leads.
 */
export function nowPlusDays(days: number): string {
  return nowPlusHours(days * 24);
}

/** Parsea un string ISO de Supabase a Date */
export function parseDate(isoString: string): Date {
  return new Date(isoString);
}

/** Retorna true si la fecha ISO está en el pasado */
export function isPast(isoString: string): boolean {
  return new Date(isoString) < new Date();
}

/**
 * Horas transcurridas desde una fecha ISO hasta ahora.
 * Valor negativo si la fecha es futura.
 */
export function hoursSince(isoString: string): number {
  const ms = Date.now() - new Date(isoString).getTime();
  return ms / (1000 * 60 * 60);
}

// ---------------------------------------------------------------------------
// Helper para vectores pgvector
// ---------------------------------------------------------------------------

/**
 * Convierte un array de floats al formato string que acepta pgvector.
 * Usar al insertar embeddings en knowledge_chunks.
 *
 * @example
 * const embedding = await embed(text);
 * const pgVector = toVectorString(embedding); // "[0.1,0.2,...]"
 */
export function toVectorString(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
