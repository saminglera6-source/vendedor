/**
 * Servicio de memoria comercial del cliente.
 *
 * Responsabilidades:
 * - Extraer preferencias del cliente desde texto de conversación
 * - Detectar cambios de interés (cambió de modelo, color, presupuesto)
 * - Actualizar customer_memory en la DB vía upsert incremental
 * - Generar resumen_comercial estructurado (sin IA en esta capa)
 * - Decidir cuándo regenerar el resumen
 *
 * La versión IA del resumen_comercial (más rica) la genera el agent layer.
 * Este servicio genera el resumen estructurado de bootstrap cuando el agente
 * todavía no tuvo oportunidad de generar uno.
 */

import { getMemory, upsertMemory } from '../db/customer-memory.js';
import {
  ok,
  type CustomerMemory,
  type CustomerMemoryPatch,
  type CustomerRawPreferences,
  type Result,
} from '../types.js';
import {
  normalizeModel,
  normalizeColor,
  normalizeStorage,
  detectBudgetFromText,
  normalizeText,
  formatPrice,
} from './product-matching.service.js';

// ===========================================================================
// Extracción de preferencias desde texto
// ===========================================================================

/**
 * Analiza un mensaje del cliente y extrae todos los campos de preferencia
 * que pueden actualizarse en customer_memory.
 *
 * Función pura — no hace IO. Los cambios se aplican con `applyPatch`.
 */
export function extractPreferences(
  message: string,
  existing: CustomerMemory | null,
): CustomerMemoryPatch {
  const patch: CustomerMemoryPatch = {};

  // ── Producto de interés ────────────────────────────────────────────────
  const modelo = normalizeModel(message);
  if (modelo) patch.producto_interes = modelo;

  // ── Color ──────────────────────────────────────────────────────────────
  const color = normalizeColor(message);
  if (color) patch.color_preferido = color;

  // ── Almacenamiento ─────────────────────────────────────────────────────
  const almacenamiento = normalizeStorage(message);
  if (almacenamiento) patch.almacenamiento = almacenamiento;

  // ── Presupuesto ────────────────────────────────────────────────────────
  const budget = detectBudgetFromText(message);
  if (budget) {
    if (budget.min !== undefined) patch.presupuesto_min = budget.min;
    if (budget.max !== undefined) patch.presupuesto_max = budget.max;
  }

  // ── Fecha estimada de compra ───────────────────────────────────────────
  const fechaISO = extractDateFromText(message);
  if (fechaISO) patch.fecha_estimada_compra = fechaISO;

  // ── Preferencias libres (raw_preferences) ─────────────────────────────
  const rawPatch = extractRawPreferences(message, existing?.raw_preferences ?? {});
  if (Object.keys(rawPatch).length > 0) {
    patch.raw_preferences = rawPatch;
  }

  return patch;
}

// ===========================================================================
// Extracción de fecha de compra
// ===========================================================================

/**
 * Detecta la fecha estimada de compra mencionada en el mensaje.
 * Devuelve ISO date "YYYY-MM-DD" o null.
 *
 * Soporta:
 * - Días de la semana: "para el viernes"
 * - Relativos: "mañana", "esta semana", "semana que viene", "mes que viene"
 * - Fechas especiales: "día de la madre", "navidad", "año nuevo"
 * - Día del mes: "para el 15"
 */
export function extractDateFromText(
  message: string,
  referenceDate: Date = new Date(),
): string | null {
  const normalized = normalizeText(message);
  const today = new Date(referenceDate);
  today.setHours(0, 0, 0, 0);

  // ── Mañana ───────────────────────────────────────────────────────────
  if (/\b(mañana|manana)\b/.test(normalized)) {
    return addDays(today, 1).toISOString().slice(0, 10);
  }

  // ── Hoy / ya mismo ───────────────────────────────────────────────────
  if (/\b(hoy|ya mismo|ahora mismo)\b/.test(normalized)) {
    return today.toISOString().slice(0, 10);
  }

  // ── Esta semana ──────────────────────────────────────────────────────
  if (/esta semana|fin de semana/.test(normalized)) {
    const sunday = getNextDayOfWeek(today, 0); // domingo
    return sunday.toISOString().slice(0, 10);
  }

  // ── Semana que viene ─────────────────────────────────────────────────
  if (/semana que viene|proxima semana|próxima semana/.test(normalized)) {
    return addDays(today, 7).toISOString().slice(0, 10);
  }

  // ── Mes que viene ────────────────────────────────────────────────────
  if (/mes que viene|proximo mes|próximo mes/.test(normalized)) {
    const nextMonth = new Date(today);
    nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
    return nextMonth.toISOString().slice(0, 10);
  }

  // ── Días de la semana: "para el viernes" ─────────────────────────────
  const dayNames: Record<string, number> = {
    lunes: 1, martes: 2, miercoles: 3, miércoles: 3,
    jueves: 4, viernes: 5, sabado: 6, sábado: 6, domingo: 0,
  };

  for (const [name, dayNum] of Object.entries(dayNames)) {
    if (normalized.includes(name)) {
      return getNextDayOfWeek(today, dayNum).toISOString().slice(0, 10);
    }
  }

  // ── Fechas especiales (Argentina) ────────────────────────────────────
  const year = today.getFullYear();

  if (/dia de la madre|día de la madre/.test(normalized)) {
    // Tercer domingo de octubre en Argentina
    return getNthDayOfMonth(year, 9, 0, 3).toISOString().slice(0, 10);
  }
  if (/navidad/.test(normalized)) {
    const xmas = new Date(year, 11, 25);
    if (xmas < today) xmas.setFullYear(year + 1);
    return xmas.toISOString().slice(0, 10);
  }
  if (/dia del padre|día del padre/.test(normalized)) {
    // Tercer domingo de junio en Argentina
    return getNthDayOfMonth(year, 5, 0, 3).toISOString().slice(0, 10);
  }

  // ── Día del mes: "para el 15", "el 20" ───────────────────────────────
  const dayOfMonthMatch = normalized.match(
    /(?:para el|el dia|el día)?\s+(\d{1,2})(?:\s*de\s*(\w+))?/,
  );
  if (dayOfMonthMatch?.[1]) {
    const day = parseInt(dayOfMonthMatch[1], 10);
    if (day >= 1 && day <= 31) {
      const monthNames: Record<string, number> = {
        enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
        julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
      };
      const monthStr = dayOfMonthMatch[2];
      const month =
        monthStr !== undefined ? (monthNames[monthStr] ?? today.getMonth()) : today.getMonth();

      const target = new Date(year, month, day);
      // Si la fecha ya pasó este mes, poner el mes siguiente
      if (target < today) target.setMonth(target.getMonth() + 1);
      return target.toISOString().slice(0, 10);
    }
  }

  return null;
}

// ===========================================================================
// Extracción de preferencias libres (raw_preferences)
// ===========================================================================

/**
 * Detecta preferencias no estructuradas: ciudad, uso, si es regalo, etc.
 * Solo incluye en el patch los campos que se detectaron (no sobreescribe nada).
 */
export function extractRawPreferences(
  message: string,
  existing: CustomerRawPreferences,
): Partial<CustomerRawPreferences> {
  const normalized = normalizeText(message);
  const patch: Partial<CustomerRawPreferences> = {};

  // ── Ciudad ────────────────────────────────────────────────────────────
  const cityPatterns: Array<[regex: RegExp, city: string]> = [
    [/\bbuenos aires\b|\bcaba\b|\bcapital federal\b/, 'Buenos Aires'],
    [/\bcordoba\b|\bcórdoba\b/, 'Córdoba'],
    [/\brosario\b/, 'Rosario'],
    [/\bmendoza\b/, 'Mendoza'],
    [/\btucuman\b|\btucumán\b/, 'Tucumán'],
    [/\bla plata\b/, 'La Plata'],
    [/\bmar del plata\b/, 'Mar del Plata'],
    [/\bsalta\b/, 'Salta'],
    [/\bsanta fe\b/, 'Santa Fe'],
    [/\bneuquen\b|\bneuquén\b/, 'Neuquén'],
    [/\bbariloche\b/, 'Bariloche'],
    [/\bposadas\b/, 'Posadas'],
    [/\bresistencia\b/, 'Resistencia'],
  ];

  if (!existing.ciudad) {
    for (const [regex, city] of cityPatterns) {
      if (regex.test(normalized)) {
        patch.ciudad = city;
        break;
      }
    }
  }

  // ── Uso principal ─────────────────────────────────────────────────────
  if (!existing.uso_principal) {
    if (/\b(foto|camara|cámara|sacar fotos)\b/.test(normalized)) {
      patch.uso_principal = 'fotos';
    } else if (
      /\b(jugar|gaming|juego|fortnite|free fire|pubg|call of duty)\b/.test(
        normalized,
      )
    ) {
      patch.uso_principal = 'gaming';
    } else if (/\b(trabajo|laburo|empresa|negocio|zoom|teams|correo)\b/.test(normalized)) {
      patch.uso_principal = 'trabajo';
    } else if (/\b(instagram|tiktok|redes|stories|reels)\b/.test(normalized)) {
      patch.uso_principal = 'redes';
    }
  }

  // ── Es regalo ─────────────────────────────────────────────────────────
  if (!existing.es_regalo) {
    if (
      /\b(regalo|regalar|regalarle|de regalo|cumpleanos|cumpleaños|sorpresa)\b/.test(
        normalized,
      )
    ) {
      patch.es_regalo = true;
    }
  }

  // ── Para quién ────────────────────────────────────────────────────────
  if (!existing.para_quien) {
    const paraMatch = normalized.match(
      /para\s+(mi\s+)?(hija|hijo|mama|mamá|papa|papá|novio|novia|esposo|esposa|hermano|hermana)\b/,
    );
    if (paraMatch?.[2]) {
      patch.para_quien = paraMatch[2];
    }
  }

  // ── Permuta ───────────────────────────────────────────────────────────
  // Detecta cuando el cliente menciona un equipo propio para entregar.
  // Solo se ejecuta si no hay datos previos de permuta para no sobreescribir.
  const PERMUTA_SIGNALS = [
    /tengo (un|una) (iphone|i ?phone)/,
    /entrego (mi|el) (iphone|i ?phone)/,
    /tomo en parte de pago/,
    /tengo (un|una) (1[1-7]|pro max)/,
    /cuanto me toman/,
    /me toman el (mio|mío)/,
    /recibis mi (iphone|i ?phone)/,
    /doy a cuenta/,
    /entrego como parte de pago/,
    /cambio mi/,
    /en permuta/,
    /hacen permuta/,
    /toman iphone/,
  ];

  const hasPermutaSignal = PERMUTA_SIGNALS.some((p) => p.test(normalized));

  if (hasPermutaSignal) {
    if (!existing.interesado_en_permuta) {
      patch.interesado_en_permuta = true;
    }

    // Modelo del equipo a permutar — solo si no fue capturado antes
    if (!existing.modelo_actual) {
      const modeloDetectado = normalizeModel(message);
      if (modeloDetectado) {
        patch.modelo_actual = modeloDetectado;
      }
    }

    // Almacenamiento del equipo a permutar
    if (!existing.almacenamiento_actual) {
      const storageDetectado = normalizeStorage(message);
      if (storageDetectado) {
        patch.almacenamiento_actual = storageDetectado;
      }
    }

    // Estado del equipo (declarado por el cliente)
    if (!existing.estado_equipo) {
      if (/\b(roto|rota|no enciende|no prende|pantalla rota|caido|caída|golpeado|con falla|falla|no funciona)\b/.test(normalized)) {
        patch.estado_equipo = 'con falla';
      } else if (/\b(rayado|rayada|rayones|detalle|con detalles|golpe)\b/.test(normalized)) {
        patch.estado_equipo = 'con detalles';
      } else if (/\b(buen estado|impecable|como nuevo|sin detalles|perfecto|10 puntos)\b/.test(normalized)) {
        patch.estado_equipo = 'buen estado';
      }
    }
  }

  return patch;
}

// ===========================================================================
// Detección de cambio de interés
// ===========================================================================

export interface InterestChangeResult {
  changed: boolean;
  /** Campos que cambiaron de valor */
  changedFields: Array<keyof CustomerMemoryPatch>;
}

/**
 * Detecta si el cliente cambió de opinión comparando memoria existente
 * con el patch que se va a aplicar.
 *
 * Un cambio de producto_interes o marca es la señal más importante
 * (puede indicar que la conversación cambió de dirección).
 */
export function detectInterestChange(
  existing: CustomerMemory | null,
  patch: CustomerMemoryPatch,
): InterestChangeResult {
  if (!existing) return { changed: false, changedFields: [] };

  const changedFields: Array<keyof CustomerMemoryPatch> = [];

  const fields: Array<keyof CustomerMemoryPatch> = [
    'producto_interes',
    'color_preferido',
    'almacenamiento',
    'presupuesto_max',
    'presupuesto_min',
    'fecha_estimada_compra',
  ];

  for (const field of fields) {
    const oldValue = existing[field as keyof CustomerMemory];
    const newValue = patch[field];

    if (newValue !== undefined && oldValue !== null && oldValue !== undefined) {
      if (String(oldValue).toLowerCase() !== String(newValue).toLowerCase()) {
        changedFields.push(field);
      }
    }
  }

  return {
    changed: changedFields.length > 0,
    changedFields,
  };
}

// ===========================================================================
// Generación de resumen comercial (sin IA — versión estructurada)
// ===========================================================================

/**
 * Genera un párrafo de resumen de la memoria comercial sin IA.
 * Sirve como resumen de bootstrap hasta que el agent layer genere
 * el resumen con IA (más rico en contexto de conversación).
 *
 * Ejemplo de salida:
 *   "Lead interesado en iPhone 15 Pro (negro, 256 GB).
 *    Presupuesto hasta $1.200.000. Quiere para esta semana.
 *    Uso: fotos. Es un regalo."
 */
export function buildResumenComercial(memory: CustomerMemory): string {
  const parts: string[] = [];

  // Producto
  if (memory.producto_interes) {
    let productDesc = memory.producto_interes;
    const specs: string[] = [];
    if (memory.color_preferido) specs.push(memory.color_preferido);
    if (memory.almacenamiento) specs.push(memory.almacenamiento);
    if (specs.length > 0) productDesc += ` (${specs.join(', ')})`;
    parts.push(`Interesado en ${productDesc}.`);
  }

  // Presupuesto
  if (memory.presupuesto_max !== null && memory.presupuesto_max !== undefined) {
    const min = memory.presupuesto_min;
    if (min !== null && min !== undefined && min > 0) {
      parts.push(
        `Presupuesto entre ${formatPrice(min)} y ${formatPrice(memory.presupuesto_max)}.`,
      );
    } else {
      parts.push(`Presupuesto hasta ${formatPrice(memory.presupuesto_max)}.`);
    }
  } else if (
    memory.presupuesto_min !== null &&
    memory.presupuesto_min !== undefined
  ) {
    parts.push(`Presupuesto desde ${formatPrice(memory.presupuesto_min)}.`);
  }

  // Fecha
  if (memory.fecha_estimada_compra) {
    parts.push(`Fecha estimada: ${memory.fecha_estimada_compra}.`);
  }

  // Raw preferences
  const raw = memory.raw_preferences;
  if (raw.uso_principal) {
    const usoLabel: Record<string, string> = {
      fotos: 'fotos',
      gaming: 'juegos',
      trabajo: 'trabajo',
      redes: 'redes sociales',
      general: 'uso general',
    };
    parts.push(`Uso: ${usoLabel[raw.uso_principal] ?? raw.uso_principal}.`);
  }
  if (raw.ciudad) parts.push(`Ciudad: ${raw.ciudad}.`);
  if (raw.es_regalo === true) parts.push('Es un regalo.');
  if (raw.para_quien) parts.push(`Para: ${raw.para_quien}.`);

  // Permuta
  if (raw.interesado_en_permuta) {
    const permuteDesc: string[] = ['Interesado en permuta'];
    if (raw.modelo_actual) permuteDesc.push(`de ${raw.modelo_actual}`);
    if (raw.almacenamiento_actual) permuteDesc.push(raw.almacenamiento_actual);
    if (raw.estado_equipo) permuteDesc.push(`(${raw.estado_equipo})`);
    parts.push(`${permuteDesc.join(' ')}.`);
  }

  if (parts.length === 0) return 'Sin datos comerciales registrados aún.';

  return parts.join(' ');
}

// ===========================================================================
// Operaciones con DB
// ===========================================================================

/**
 * Obtiene o crea la memoria comercial de un lead.
 * Si no existe, retorna un objeto vacío (no persiste nada todavía).
 */
export async function getOrCreate(
  leadId: string,
): Promise<Result<CustomerMemory>> {
  const result = await getMemory(leadId);
  if (!result.ok) return result;

  if (result.value) return ok(result.value);

  // Retornar objeto vacío en memoria (se persistirá con el primer applyPatch)
  return ok({
    id: '',
    lead_id: leadId,
    producto_interes: null,
    color_preferido: null,
    almacenamiento: null,
    presupuesto_min: null,
    presupuesto_max: null,
    fecha_estimada_compra: null,
    resumen_comercial: null,
    raw_preferences: {},
    updated_at: new Date().toISOString(),
  });
}

/**
 * Aplica un patch a la memoria de un lead y persiste en la DB.
 * Solo actualiza los campos que vienen en el patch (merge, no reemplazo).
 */
export async function applyPatch(
  leadId: string,
  patch: CustomerMemoryPatch,
): Promise<Result<CustomerMemory>> {
  // Ignorar patches vacíos
  if (Object.keys(patch).length === 0) {
    return getOrCreate(leadId);
  }
  return upsertMemory(leadId, patch);
}

/**
 * Regenera el resumen_comercial basado en el estado actual de la memoria.
 * Llama buildResumenComercial y persiste el resultado.
 *
 * El agent layer puede sobreescribir este resumen con uno generado por IA.
 */
export async function regenerateResumen(
  leadId: string,
): Promise<Result<CustomerMemory>> {
  const memResult = await getMemory(leadId);
  if (!memResult.ok) return memResult;
  if (!memResult.value) return getOrCreate(leadId);

  const resumen = buildResumenComercial(memResult.value);
  return upsertMemory(leadId, { resumen_comercial: resumen });
}

// ===========================================================================
// Helpers de fecha
// ===========================================================================

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getNextDayOfWeek(from: Date, targetDow: number): Date {
  const current = from.getDay();
  let daysUntil = targetDow - current;
  if (daysUntil <= 0) daysUntil += 7;
  return addDays(from, daysUntil);
}

/** Retorna el N-ésimo día de la semana de un mes dado (1-indexed) */
function getNthDayOfMonth(
  year: number,
  month: number, // 0-indexed
  targetDow: number,
  n: number,
): Date {
  const first = new Date(year, month, 1);
  const firstDow = first.getDay();
  let day = 1 + ((targetDow - firstDow + 7) % 7) + (n - 1) * 7;
  return new Date(year, month, day);
}
