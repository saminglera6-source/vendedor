/**
 * Carga y caché de business_rules.
 *
 * Las reglas operativas del negocio viven en la tabla `business_rules`
 * para ser editables sin redeploy. Este módulo las carga una vez y las
 * cachea en proceso por BUSINESS_RULES_CACHE_TTL_MINUTES minutos.
 *
 * Si alguna clave requerida falta en la tabla, `getBusinessRules()` falla
 * con DatabaseError — preferimos fallar rápido a que el agente opere con
 * configuración parcial e inventada.
 *
 * Inicializar ejecutando: supabase/migrations/002_seed_rules.sql
 */

import { db, assertData } from './client.js';
import {
  ok,
  err,
  DatabaseError,
  type Result,
  type BusinessRulesMap,
} from '../types.js';
import type { BusinessRuleRow } from './schema.js';

// ---------------------------------------------------------------------------
// Caché en proceso
// ---------------------------------------------------------------------------

interface RulesCacheEntry {
  rules: BusinessRulesMap;
  expiresAt: number; // marca en ms de Date.now()
}

let _cache: RulesCacheEntry | null = null;

/** Lee el TTL del entorno en cada uso para respetar cambios sin reiniciar. */
function getTtlMs(): number {
  const raw = process.env['BUSINESS_RULES_CACHE_TTL_MINUTES'];
  const minutes = raw !== undefined ? parseInt(raw, 10) : 60;
  // Fallback a 60 si el valor es inválido o negativo
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Claves que deben existir en la tabla — si alguna falta, falla rápido
// ---------------------------------------------------------------------------

const REQUIRED_KEYS: readonly (keyof BusinessRulesMap)[] = [
  'escalation_threshold',
  'business_hours',
  'followup_messages',
  'max_no_response_hours',
  'recovery_interval_days',
  'rag_top_k',
  'delivery_time_labels',
  'prohibited_phrases',
  'approved_availability_phrases',
  'financing_plans',
  'agent_sales_priority',
] as const;

// ---------------------------------------------------------------------------
// getBusinessRules
// ---------------------------------------------------------------------------

/**
 * Retorna todas las business_rules tipadas como BusinessRulesMap.
 *
 * Usa la caché en proceso si está vigente; de lo contrario carga desde DB
 * y refresca la caché. Llamar en el paso 2 del pipeline de cada mensaje.
 */
export async function getBusinessRules(): Promise<Result<BusinessRulesMap>> {
  try {
    const now = Date.now();

    if (_cache !== null && now < _cache.expiresAt) {
      return ok(_cache.rules);
    }

    const rows = assertData(
      await db.from('business_rules').select('key, value'),
    );

    const rules = parseRulesRows(rows as Pick<BusinessRuleRow, 'key' | 'value'>[]);

    _cache = { rules, expiresAt: now + getTtlMs() };

    return ok(rules);
  } catch (error) {
    return toDbError(error, 'getBusinessRules');
  }
}

// ---------------------------------------------------------------------------
// invalidateRulesCache
// ---------------------------------------------------------------------------

/**
 * Invalida la caché sin tocar la DB.
 * El próximo `getBusinessRules()` hará un SELECT fresco.
 *
 * Útil en tests y para aplicar cambios en `business_rules` sin esperar el TTL.
 */
export function invalidateRulesCache(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// Helper de parseo
// ---------------------------------------------------------------------------

/**
 * Reduce las filas de la tabla a un mapa clave → valor y valida que
 * estén todas las claves requeridas.
 *
 * El cast final a BusinessRulesMap es seguro porque:
 * 1. La BD almacena JSONB — mismo árbol de tipos que nuestras interfaces.
 * 2. Las claves requeridas están verificadas antes del cast.
 * Validación estricta campo a campo puede agregarse con Zod si se necesita.
 */
function parseRulesRows(
  rows: Pick<BusinessRuleRow, 'key' | 'value'>[],
): BusinessRulesMap {
  const map: Record<string, unknown> = {};

  for (const row of rows) {
    map[row.key] = row.value;
  }

  const missing = REQUIRED_KEYS.filter((key) => !(key in map));

  if (missing.length > 0) {
    throw new DatabaseError(
      `business_rules: claves requeridas faltantes en la tabla: [${missing.join(', ')}]. ` +
        'Ejecutar supabase/migrations/002_seed_rules.sql para inicializar los valores.',
      { missing_keys: missing },
    );
  }

  return map as unknown as BusinessRulesMap;
}

// ---------------------------------------------------------------------------
// Helper interno
// ---------------------------------------------------------------------------

function toDbError(error: unknown, context: string): Result<never> {
  if (error instanceof DatabaseError) return err(error);
  return err(
    new DatabaseError(
      `Error en business-rules.${context}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: String(error) },
    ),
  );
}
