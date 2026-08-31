/**
 * Servicio de interpretación de lenguaje natural para productos.
 *
 * Responsabilidades:
 * - Normalizar jerga argentina a nombres canónicos de producto
 * - Detectar modelo, color, almacenamiento y presupuesto en texto libre
 * - Buscar variantes compatibles en la base de datos
 * - Tolerar errores ortográficos y abreviaciones de WhatsApp
 * - Formatear respuestas de disponibilidad con el lenguaje aprobado
 *
 * Este módulo es puro en sus funciones de parsing (sin efectos).
 * Solo `matchFromMessage` hace acceso a base de datos.
 */

import { getProductByModelAndStorage, getVariantsByProductId } from '../db/products.js';
import {
  ok,
  err,
  DatabaseError,
  type CustomerMemory,
  type ProductVariantWithProduct,
  type Result,
} from '../types.js';

// ===========================================================================
// Tablas de normalización (jerga argentina → nombre canónico)
// ===========================================================================

/**
 * Alias de modelos ordenados de más largo a más corto para matching greedy.
 * El orden importa: "16 pro max" debe matchear antes que "16 pro".
 */
const MODEL_ALIASES: ReadonlyArray<[pattern: string, canonical: string]> = [
  // ── iPhone 17 ──────────────────────────────────────────────────────────
  ['iphone 17 pro max', 'iPhone 17 Pro Max'],
  ['17 pro maxi',       'iPhone 17 Pro Max'],
  ['17 pro max',        'iPhone 17 Pro Max'],
  ['iphone 17 pro',     'iPhone 17 Pro'],
  ['17 pro',            'iPhone 17 Pro'],
  ['iphone 17 plus',    'iPhone 17 Plus'],
  ['17 plus',           'iPhone 17 Plus'],
  ['iphone 17',         'iPhone 17'],
  // ── iPhone 16 ──────────────────────────────────────────────────────────
  ['iphone 16 pro max', 'iPhone 16 Pro Max'],
  ['16 pro maxi',       'iPhone 16 Pro Max'],
  ['16 pro max',        'iPhone 16 Pro Max'],
  ['iphone 16 pro',     'iPhone 16 Pro'],
  ['16 pro',            'iPhone 16 Pro'],
  ['iphone 16 plus',    'iPhone 16 Plus'],
  ['16 plus',           'iPhone 16 Plus'],
  ['iphone 16',         'iPhone 16'],
  // ── iPhone 15 ──────────────────────────────────────────────────────────
  ['iphone 15 pro max', 'iPhone 15 Pro Max'],
  ['15 pro maxi',       'iPhone 15 Pro Max'],
  ['15 pro max',        'iPhone 15 Pro Max'],
  ['iphone 15 pro',     'iPhone 15 Pro'],
  ['15 pro',            'iPhone 15 Pro'],
  ['iphone 15 plus',    'iPhone 15 Plus'],
  ['iphone 15',         'iPhone 15'],
  ['quince pro',        'iPhone 15 Pro'],
  // ── iPhone 14 ──────────────────────────────────────────────────────────
  ['iphone 14 pro max', 'iPhone 14 Pro Max'],
  ['14 pro max',        'iPhone 14 Pro Max'],
  ['iphone 14 pro',     'iPhone 14 Pro'],
  ['14 pro',            'iPhone 14 Pro'],
  ['iphone 14',         'iPhone 14'],
  // ── iPhone 14 (extra) ──────────────────────────────────────────────────
  ['iphone 14 plus',    'iPhone 14 Plus'],
  ['14 plus',           'iPhone 14 Plus'],
  // ── iPhone 13 ──────────────────────────────────────────────────────────
  ['iphone 13 pro max', 'iPhone 13 Pro Max'],
  ['13 pro max',        'iPhone 13 Pro Max'],
  ['iphone 13 pro',     'iPhone 13 Pro'],
  ['13 pro',            'iPhone 13 Pro'],
  ['iphone 13 mini',    'iPhone 13 Mini'],
  ['13 mini',           'iPhone 13 Mini'],
  ['iphone 13',         'iPhone 13'],
  // ── iPhone 12 ──────────────────────────────────────────────────────────
  ['iphone 12 pro max', 'iPhone 12 Pro Max'],
  ['12 pro max',        'iPhone 12 Pro Max'],
  ['iphone 12 pro',     'iPhone 12 Pro'],
  ['12 pro',            'iPhone 12 Pro'],
  ['iphone 12 mini',    'iPhone 12 Mini'],
  ['12 mini',           'iPhone 12 Mini'],
  ['iphone 12',         'iPhone 12'],
  // ── iPhone 11 ──────────────────────────────────────────────────────────
  ['iphone 11 pro max', 'iPhone 11 Pro Max'],
  ['11 pro max',        'iPhone 11 Pro Max'],
  ['iphone 11 pro',     'iPhone 11 Pro'],
  ['11 pro',            'iPhone 11 Pro'],
  ['iphone 11',         'iPhone 11'],
  // ── iPhone X / XR / XS ─────────────────────────────────────────────────
  ['iphone xs max',     'iPhone XS Max'],
  ['xs max',            'iPhone XS Max'],
  ['iphone xs',         'iPhone XS'],
  ['iphone xr',         'iPhone XR'],
  ['iphone x',          'iPhone X'],
  // ── iPhone 8 ───────────────────────────────────────────────────────────
  ['iphone 8 plus',     'iPhone 8 Plus'],
  ['8 plus',            'iPhone 8 Plus'],
  ['iphone 8',          'iPhone 8'],
  // ── Samsung Galaxy S ───────────────────────────────────────────────────
  ['galaxy s25 ultra',  'Samsung Galaxy S25 Ultra'],
  ['s25 ultra',         'Samsung Galaxy S25 Ultra'],
  ['galaxy s25 plus',   'Samsung Galaxy S25+'],
  ['s25 plus',          'Samsung Galaxy S25+'],
  ['s25+',              'Samsung Galaxy S25+'],
  ['galaxy s25',        'Samsung Galaxy S25'],
  ['s25',               'Samsung Galaxy S25'],
  ['galaxy s24 ultra',  'Samsung Galaxy S24 Ultra'],
  ['s24 ultra',         'Samsung Galaxy S24 Ultra'],
  ['galaxy s24 fe',     'Samsung Galaxy S24 FE'],
  ['s24 fe',            'Samsung Galaxy S24 FE'],
  ['galaxy s24',        'Samsung Galaxy S24'],
  ['s24',               'Samsung Galaxy S24'],
  ['galaxy s23',        'Samsung Galaxy S23'],
  ['s23',               'Samsung Galaxy S23'],
  // ── Samsung Galaxy A ───────────────────────────────────────────────────
  ['galaxy a55',        'Samsung Galaxy A55'],
  ['a55',               'Samsung Galaxy A55'],
  ['galaxy a35',        'Samsung Galaxy A35'],
  ['a35',               'Samsung Galaxy A35'],
  ['galaxy a25',        'Samsung Galaxy A25'],
  ['a25',               'Samsung Galaxy A25'],
  ['galaxy a15',        'Samsung Galaxy A15'],
  ['a15',               'Samsung Galaxy A15'],
  // ── Motorola ───────────────────────────────────────────────────────────
  ['moto edge 50 ultra','Motorola Edge 50 Ultra'],
  ['edge 50 ultra',     'Motorola Edge 50 Ultra'],
  ['moto edge 50',      'Motorola Edge 50'],
  ['edge 50',           'Motorola Edge 50'],
  ['moto g85',          'Motorola Moto G85'],
  ['g85',               'Motorola Moto G85'],
  ['moto g75',          'Motorola Moto G75'],
  ['g75',               'Motorola Moto G75'],
  ['moto g54',          'Motorola Moto G54'],
  ['g54',               'Motorola Moto G54'],
  // ── Xiaomi ─────────────────────────────────────────────────────────────
  ['poco x6 pro',       'Xiaomi POCO X6 Pro'],
  ['poco x6',           'Xiaomi POCO X6'],
  ['poco x5 pro',       'Xiaomi POCO X5 Pro'],
  ['poco x5',           'Xiaomi POCO X5'],
  ['redmi note 13 pro', 'Xiaomi Redmi Note 13 Pro'],
  ['redmi note 13',     'Xiaomi Redmi Note 13'],
  ['redmi 13c',         'Xiaomi Redmi 13C'],
  ['redi note 13',      'Xiaomi Redmi Note 13'], // error ortográfico frecuente
  ['redi 13',           'Xiaomi Redmi 13C'],
] as const;

/** Alias de colores */
const COLOR_ALIASES: ReadonlyArray<[pattern: string, canonical: string]> = [
  // Negro / titanio
  ['negro titanio',   'Negro Titanio'],
  ['titanio negro',   'Negro Titanio'],
  ['titanio oscuro',  'Negro Titanio'],
  ['negro',           'Negro'],
  ['negrito',         'Negro'],
  ['black',           'Negro'],
  // Blanco
  ['blanco estrella', 'Blanco Estrella'],
  ['blanco titanio',  'Blanco Titanio'],
  ['blanco',          'Blanco'],
  ['blanquito',       'Blanco'],
  ['white',           'Blanco'],
  // Titanio natural
  ['titanio natural', 'Titanio Natural'],
  ['natural',         'Titanio Natural'],
  ['beige',           'Titanio Natural'],
  // Azul
  ['azul cobalt',     'Azul Cobalt'],
  ['cobalt',          'Azul Cobalt'],
  ['azul',            'Azul'],
  ['blue',            'Azul'],
  // Verde
  ['verde alpino',    'Verde Alpino'],
  ['verde',           'Verde'],
  ['green',           'Verde'],
  // Violeta / lila
  ['violeta',         'Violeta'],
  ['lila',            'Violeta'],
  ['morado',          'Violeta'],
  ['purple',          'Violeta'],
  // Otros
  ['dorado',          'Dorado'],
  ['oro',             'Dorado'],
  ['gold',            'Dorado'],
  ['rosa',            'Rosa'],
  ['pink',            'Rosa'],
  ['rojo',            'Rojo'],
  ['red',             'Rojo'],
  ['plateado',        'Plateado'],
  ['plata',           'Plateado'],
  ['gris',            'Gris'],
  ['gris espacial',   'Gris Espacial'],
] as const;

/** Alias de almacenamiento */
const STORAGE_ALIASES: ReadonlyArray<[pattern: string, canonical: string]> = [
  ['1 tera',    '1TB'],
  ['1 tb',      '1TB'],
  ['1tb',       '1TB'],
  ['1 t',       '1TB'],  // "el de 1 t" es muy común
  ['512 gigas', '512GB'],
  ['512gb',     '512GB'],
  ['512',       '512GB'],
  ['256 gigas', '256GB'],
  ['256gb',     '256GB'],
  ['256',       '256GB'],
  ['128 gigas', '128GB'],
  ['128gb',     '128GB'],
  ['128',       '128GB'],
  ['64 gigas',  '64GB'],
  ['64gb',      '64GB'],
  ['64',        '64GB'],
] as const;

/** Marcas canónicas — para derivar brand de un modelo normalizado */
const BRAND_PREFIXES: ReadonlyArray<[prefix: string, brand: string]> = [
  ['iphone',          'Apple'],
  ['samsung galaxy',  'Samsung'],
  ['motorola',        'Motorola'],
  ['moto ',           'Motorola'],
  ['xiaomi',          'Xiaomi'],
  ['poco',            'Xiaomi'],
  ['redmi',           'Xiaomi'],
] as const;

// ===========================================================================
// Tipos públicos
// ===========================================================================

export interface ParsedProductQuery {
  marca?: string;
  modelo?: string;
  /** Nombre canónico, listo para ILIKE en la DB */
  modeloNormalizado?: string;
  color?: string;
  almacenamiento?: string;
  presupuesto?: { min?: number; max?: number };
  /**
   * high: modelo detectado explícitamente
   * medium: solo color o almacenamiento detectado
   * low: solo presupuesto o señales indirectas
   */
  confidence: 'high' | 'medium' | 'low';
}

export interface ProductMatchResult {
  parsed: ParsedProductQuery;
  /** Variantes que coinciden exactamente con los criterios detectados */
  variants: ProductVariantWithProduct[];
  /** Hubo match preciso (modelo + almacenamiento o modelo + color) */
  exactMatch: boolean;
  /** Otras variantes del mismo producto si no hay exact match */
  alternatives: ProductVariantWithProduct[];
}

// ===========================================================================
// Normalización de texto
// ===========================================================================

/**
 * Normaliza texto para matching:
 * - minúsculas
 * - remueve acentos
 * - colapsa espacios múltiples
 * - remueve puntuación (excepto + y números)
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // remueve diacríticos
    .replace(/[¿¡!?,.'";:\-]/g, ' ')  // puntuación → espacio
    .replace(/\s+/g, ' ')
    .trim();
}

// ===========================================================================
// Detectores individuales
// ===========================================================================

/**
 * Detecta el modelo del celular en un texto normalizado.
 * Retorna el nombre canónico (ej: "iPhone 15 Pro") o null.
 */
export function normalizeModel(input: string): string | null {
  const normalized = normalizeText(input);

  for (const [pattern, canonical] of MODEL_ALIASES) {
    if (normalized.includes(pattern)) {
      return canonical;
    }
  }

  return null;
}

/**
 * Detecta el color en texto normalizado.
 * Retorna el nombre canónico (ej: "Negro Titanio") o null.
 */
export function normalizeColor(input: string): string | null {
  const normalized = normalizeText(input);

  // Aliases ya están ordenados de más específico a más general
  for (const [pattern, canonical] of COLOR_ALIASES) {
    if (normalized.includes(pattern)) {
      return canonical;
    }
  }

  return null;
}

/**
 * Detecta el almacenamiento en texto normalizado.
 * Retorna el string canónico (ej: "256GB") o null.
 *
 * ATENCIÓN: "512" y "256" son muy comunes como números sueltos.
 * Se valida que no sean parte de un año o número de teléfono.
 */
export function normalizeStorage(input: string): string | null {
  const normalized = normalizeText(input);

  for (const [pattern, canonical] of STORAGE_ALIASES) {
    // Para patrones solo numéricos, verificar que sea un token aislado
    if (/^\d+$/.test(pattern)) {
      const regex = new RegExp(`(?<![\\d])${pattern}(?![\\d])`, 'i');
      if (regex.test(normalized)) return canonical;
    } else if (normalized.includes(pattern)) {
      return canonical;
    }
  }

  return null;
}

/**
 * Extrae la marca desde el nombre canónico del modelo.
 * Retorna "Apple", "Samsung", etc. o null.
 */
export function extractBrandFromModel(canonicalModel: string): string | null {
  const lower = canonicalModel.toLowerCase();
  for (const [prefix, brand] of BRAND_PREFIXES) {
    if (lower.startsWith(prefix)) return brand;
  }
  return null;
}

// ===========================================================================
// Detección de presupuesto
// ===========================================================================

/**
 * Detecta el presupuesto mencionado en texto libre.
 *
 * Formatos soportados (contexto argentino):
 * - "$200.000" / "200000 pesos"
 * - "200 lucas" / "200 mil" / "200k" → 200,000
 * - "hasta 300" (sin unidad explícita, asume miles si < 10,000)
 * - "no paso de 400"
 * - "entre 200 y 300"
 * - "1 millon" / "1M" → 1,000,000
 */
export function detectBudgetFromText(
  text: string,
): { min?: number; max?: number } | null {
  // Normalización propia: minúsculas + sin acentos, pero CONSERVA . , $ (los
  // necesita para montos). normalizeText() los borra y rompe "1.2 millones".
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // X millon / XM  (chequear primero: "1.5 millones")
  const millonMatch = normalized.match(/(\d+(?:[.,]\d+)?)\s*(?:millones?|palos?|\bm\b)/);
  if (millonMatch?.[1]) {
    const value = parseFloat(millonMatch[1].replace(',', '.')) * 1_000_000;
    return deriveMinMax(normalized, value);
  }
  if (/\bmedio\s+palo\b/.test(normalized)) return deriveMinMax(normalized, 500_000);

  // X lucas / X mil / Xk / X luca  → SIEMPRE son miles (×1000), salvo que el
  // número ya sea grande (ej "500.000 mil" mal escrito).
  const lucasMatch = normalized.match(/(\d+(?:[.,]\d+)?)\s*(?:lucas?|mil\b|k\b|palos?)/);
  if (lucasMatch?.[1]) {
    const base = parseFloat(lucasMatch[1].replace(/\./g, '').replace(',', '.'));
    const value = base >= 100_000 ? base : Math.round(base * 1_000);
    return deriveMinMax(normalized, value);
  }

  // $X.XXX.XXX o $XXXXXX — formato explícito con signo pesos
  const pesoMatch = normalized.match(/\$\s*([\d][.,\d]*)/);
  if (pesoMatch?.[1]) {
    const value = parseArgentineNumber(pesoMatch[1]);
    if (value > 0) return deriveMinMax(normalized, value);
  }

  // Número grande suelto en contexto de presupuesto: "presupuesto 500000",
  // "tengo 450000", "hasta 600000"
  const bigMatch = normalized.match(/\b(\d{5,7})\b/);
  if (bigMatch?.[1] && /(presupuesto|gastar|pagar|tengo|hasta|tope|maximo|no paso|invertir|plata)/.test(normalized)) {
    return deriveMinMax(normalized, parseInt(bigMatch[1], 10));
  }

  // Número puro tipo "hasta 300" / "no paso de 400" — asume miles
  const bareMatch = normalized.match(/(?:hasta|no paso de|maximo|tope|presupuesto de|gastar|unos?)\s*(\d{2,4})\b/);
  if (bareMatch?.[1]) {
    const base = parseInt(bareMatch[1], 10);
    return { max: base < 10_000 ? base * 1_000 : base };
  }

  // Rango: "entre X y Y"
  const rangeMatch = normalized.match(/entre[\s,]*([\d.,]+)[\s]*y[\s]*([\d.,]+)/);
  if (rangeMatch?.[1] && rangeMatch[2]) {
    let min = parseArgentineNumber(rangeMatch[1]);
    let max = parseArgentineNumber(rangeMatch[2]);
    if (min < 10_000) min *= 1_000;
    if (max < 10_000) max *= 1_000;
    return { min, max };
  }

  return null;
}

function parseArgentineNumber(s: string): number {
  // Elimina separadores de miles (. o ,) si no es decimal
  const cleaned = s.replace(/\./g, '').replace(',', '.');
  return parseFloat(cleaned);
}

function deriveMinMax(
  text: string,
  value: number,
): { min?: number; max?: number } {
  if (/\b(hasta|maximo|no paso|tope)\b/.test(text)) return { max: value };
  if (/\b(minimo|desde|a partir)\b/.test(text)) return { min: value };
  // Sin modificador → asumir que es el máximo (lo más común en consultas de compra)
  return { max: value };
}

// ===========================================================================
// Parser principal
// ===========================================================================

/**
 * Parsea un mensaje libre y extrae todos los parámetros de búsqueda de producto.
 * Función pura — no hace IO.
 *
 * Ejemplo:
 *   "16 pro negro 256 presupuesto hasta 300k"
 *   → { marca: 'Apple', modeloNormalizado: 'iPhone 16 Pro', color: 'Negro',
 *        almacenamiento: '256GB', presupuesto: { max: 300_000 }, confidence: 'high' }
 */
export function parseProductQuery(message: string): ParsedProductQuery {
  const modeloNormalizado = normalizeModel(message) ?? undefined;
  const color = normalizeColor(message) ?? undefined;
  const almacenamiento = normalizeStorage(message) ?? undefined;
  const presupuesto = detectBudgetFromText(message) ?? undefined;
  const marca = modeloNormalizado
    ? (extractBrandFromModel(modeloNormalizado) ?? undefined)
    : undefined;

  let confidence: ParsedProductQuery['confidence'] = 'low';
  if (modeloNormalizado) {
    confidence = 'high';
  } else if (color !== undefined || almacenamiento !== undefined) {
    confidence = 'medium';
  }

  return {
    marca,
    modelo: modeloNormalizado,
    modeloNormalizado,
    color,
    almacenamiento,
    presupuesto,
    confidence,
  };
}

// ===========================================================================
// Matching con base de datos
// ===========================================================================

/**
 * Interpreta el mensaje + memoria del cliente y busca variantes en la DB.
 *
 * Estrategia:
 * 1. Parsear el mensaje actual
 * 2. Completar con datos de customer_memory si el mensaje es ambiguo
 * 3. Buscar variantes exactas
 * 4. Si no hay exactas, buscar alternativas del mismo modelo o marca
 */
export async function matchFromMessage(
  message: string,
  memory: CustomerMemory | null,
): Promise<Result<ProductMatchResult>> {
  try {
    const parsed = parseProductQuery(message);

    // Completar con memoria si el mensaje no tiene modelo explícito
    const effectiveModelo =
      parsed.modeloNormalizado ??
      (memory?.producto_interes ? normalizeModel(memory.producto_interes) ?? memory.producto_interes : undefined);

    const effectiveColor =
      parsed.color ?? memory?.color_preferido ?? undefined;

    const effectiveAlmacenamiento =
      parsed.almacenamiento ?? memory?.almacenamiento ?? undefined;

    if (!effectiveModelo && !effectiveColor && !effectiveAlmacenamiento) {
      return ok({
        parsed,
        variants: [],
        exactMatch: false,
        alternatives: [],
      });
    }

    // Búsqueda de variantes exactas
    const variantsResult = await getProductByModelAndStorage({
      modelo: effectiveModelo ?? '',
      almacenamiento: effectiveAlmacenamiento,
      color: effectiveColor,
      availableOnly: true,
    });

    if (!variantsResult.ok) return err(variantsResult.error);

    const variants = variantsResult.value;

    // Si no hubo match exacto, buscar otras variantes del mismo modelo
    let alternatives: ProductVariantWithProduct[] = [];

    if (variants.length === 0 && effectiveModelo) {
      const altResult = await getProductByModelAndStorage({
        modelo: effectiveModelo,
        availableOnly: true,
      });
      if (altResult.ok) {
        // Excluir la variante exacta buscada (ya sabemos que no existe)
        alternatives = altResult.value;
      }
    }

    const exactMatch =
      variants.length > 0 &&
      (effectiveAlmacenamiento !== undefined || effectiveColor !== undefined);

    return ok({ parsed, variants, exactMatch, alternatives });
  } catch (error) {
    if (error instanceof DatabaseError) return err(error);
    return err(
      new DatabaseError(
        `Error en matchFromMessage: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

// ===========================================================================
// Formateo de disponibilidad (lenguaje aprobado del CLAUDE.md)
// ===========================================================================

/**
 * Traduce los campos de disponibilidad de una variante al lenguaje aprobado.
 *
 * Ejemplos de salida:
 *   "Está disponible. Puedo entregarlo hoy."
 *   "Disponible, entrega mañana."
 *   "En este momento no lo tenemos disponible."
 *
 * @param deliveryLabels - Mapa de delivery_time_labels de business_rules
 */
export function formatAvailabilityPhrase(
  variant: Pick<ProductVariantWithProduct, 'availability_status' | 'delivery_time_hours'>,
  deliveryLabels: Record<string, string>,
): string {
  if (variant.availability_status === 'NO_DISPONIBLE') {
    return 'En este momento no lo tenemos disponible.';
  }

  const hours = variant.delivery_time_hours;

  // Buscar el label exacto, o el del bloque de tiempo más cercano
  const exactLabel = deliveryLabels[String(hours)];
  if (exactLabel) {
    if (hours === 0) return `Lo tengo disponible. Puedo entregarlo ${exactLabel}.`;
    return `Disponible, entrega ${exactLabel}.`;
  }

  // Fallback a descripción genérica si no hay label
  if (hours <= 4) return 'Lo tengo disponible para entrega hoy.';
  if (hours <= 24) return 'Disponible, entrega mañana.';
  if (hours <= 48) return 'Disponible, entrega en 2 días.';
  return `Disponible, entrega en aproximadamente ${Math.ceil(hours / 24)} días.`;
}

/**
 * Formatea precio con separador de miles (formato argentino).
 * Ej: 1250000 → "$1.250.000"
 */
export function formatPrice(precio: number): string {
  return `$${Math.round(precio).toLocaleString('es-AR')}`;
}
