/**
 * Precios en vivo desde el ERP de GreatPhones (Google Apps Script sobre Sheets).
 *
 * Fuente de verdad única para precio contado, preventa y tabla de toma (canje).
 * Reemplaza las tablas hardcodeadas que había en prompt.ts y la inyección de
 * product_variants.
 *
 * El endpoint (PRICING_API_URL) es un web app de Apps Script:
 *   GET {url}?api=all&token={PRICING_API_TOKEN}
 *   → { ok, data: { precios: PrecioRow[], toma: TomaRow[] } }
 *
 * Caché en proceso con TTL (PRICING_CACHE_TTL_MINUTES, default 10). Si el fetch
 * falla y hay caché vencida, se sirve la vencida (mejor stale que nada).
 */

import { readFileSync } from 'node:fs';
import { ok, err, type Result } from '../types.js';
import { normalizeModel, normalizeStorage, normalizeText } from './product-matching.service.js';

// ===========================================================================
// Tipos del feed
// ===========================================================================

export interface PrecioRow {
  modelo: string;
  almacenamiento: string;
  precioUSD: number;
  precioARS: number;
  preventaARS: number;
  preventaUSD: number;
  descuentoARS: number;
  descuentoUSD: number;
}

export interface TomaRow {
  /** En la hoja el modelo viene con almacenamiento incluido: "iPhone 13 128 GB" */
  modelo: string;
  impecable: number;
  bateria: number;
  pantalla: number;
  camara: number;
  microfono: number;
  parlante: number;
  tapa: number;
  marco: number;
  pin: number;
}

export interface CuotaCoef {
  cuotas: number;
  coeficiente: number;
  mostrar: boolean;
}

export interface PricingData {
  precios: PrecioRow[];
  toma: TomaRow[];
  cuotasCoef: CuotaCoef[];
  fetchedAt: number;
  /** Si hay una promo puntual activa: hasta qué día (YYYY-MM-DD) rige. */
  promoVigenteHasta: string | null;
  /** Claves "modelo|almacenamiento" (normalizadas) cuyo preventa viene de la promo. */
  promoAplicadaA: string[];
}

// ===========================================================================
// Promo puntual — override temporal SIN tocar la lista maestra del Sheet
// ===========================================================================
// Archivo promo.json en la raíz del repo (gitignoreado). Formato:
//   { "vigente_hasta": "2026-08-30",
//     "preventa": { "iPhone 15|128GB": 810000, "iPhone 16 Pro|128GB": 1250000 } }
// Se ignora entero si la fecha ya pasó. Borrar el archivo desactiva la promo.

interface PromoFile {
  vigente_hasta?: string;
  preventa?: Record<string, number>;
}

function hoyISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadPromo(): { vigenteHasta: string; preventa: Map<string, number> } | null {
  const path = process.env['PROMO_FILE'] ?? 'promo.json';
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null; // sin archivo → sin promo
  }
  let parsed: PromoFile;
  try {
    parsed = JSON.parse(raw) as PromoFile;
  } catch {
    console.error('[pricing] promo.json inválido — se ignora');
    return null;
  }
  const vigenteHasta = (parsed.vigente_hasta ?? '').trim();
  if (!vigenteHasta || vigenteHasta < hoyISO()) return null; // vencida o sin fecha

  const preventa = new Map<string, number>();
  for (const [k, v] of Object.entries(parsed.preventa ?? {})) {
    const [modeloRaw, almRaw] = k.split('|');
    const modelo = normalizeModel(modeloRaw ?? '') ?? (modeloRaw ?? '').trim();
    const alm = normalizeStorage(almRaw ?? '') ?? (almRaw ?? '').trim();
    if (modelo && alm && Number(v) > 0) {
      preventa.set(`${normalizeText(modelo)}|${alm.toLowerCase()}`, Number(v));
    }
  }
  return preventa.size > 0 ? { vigenteHasta, preventa } : null;
}

function promoKey(modelo: string, almacenamiento: string): string {
  const m = normalizeModel(modelo) ?? modelo;
  const a = normalizeStorage(almacenamiento) ?? almacenamiento;
  return `${normalizeText(m)}|${a.toLowerCase()}`;
}

/**
 * Detecta TODOS los modelos de iPhone nombrados en un texto (para consultas
 * tipo "comparame el 15 y el 16 pro"). Devuelve nombres canónicos, sin repetir.
 */
export function detectModelosMencionados(text: string): string[] {
  const t = normalizeText(text);
  // El número de modelo no puede venir seguido de otro dígito (evita "128" → "12").
  const rx = /\b(iphone\s*)?(1[1-7])(?!\d)\s*(pro\s*max|pro|plus|mini)?/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = rx.exec(t)) !== null) {
    const variante = m[3] ? ' ' + m[3].replace(/\s+/g, ' ').replace(/pro max/, 'Pro Max').replace(/^pro$/, 'Pro').replace(/^plus$/, 'Plus').replace(/^mini$/, 'Mini') : '';
    out.add(`iPhone ${m[2]}${variante}`);
  }
  return [...out];
}

// ===========================================================================
// Caché
// ===========================================================================

const TTL_MS =
  Number(process.env['PRICING_CACHE_TTL_MINUTES'] ?? 10) * 60 * 1000;

let _cache: PricingData | null = null;

function isFresh(c: PricingData | null): c is PricingData {
  return c !== null && Date.now() - c.fetchedAt < TTL_MS;
}

// ===========================================================================
// Fetch
// ===========================================================================

interface ApiResponse {
  ok: boolean;
  error?: string;
  data?: { precios?: unknown[]; toma?: unknown[]; cuotas_coef?: unknown[] };
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeRows(raw: ApiResponse['data']): PricingData {
  const precios: PrecioRow[] = (raw?.precios ?? [])
    .map((r) => r as Record<string, unknown>)
    .filter((r) => typeof r['modelo'] === 'string' && (r['modelo'] as string).trim() && r['modelo'] !== 'Modelo')
    .map((r) => ({
      modelo: String(r['modelo']).trim(),
      almacenamiento: String(r['almacenamiento'] ?? '').trim(),
      precioUSD: toNum(r['precioUSD']),
      precioARS: toNum(r['precioARS']),
      preventaARS: toNum(r['preventaARS']),
      preventaUSD: toNum(r['preventaUSD']),
      descuentoARS: toNum(r['descuentoARS']),
      descuentoUSD: toNum(r['descuentoUSD']),
    }));

  const toma: TomaRow[] = (raw?.toma ?? [])
    .map((r) => r as Record<string, unknown>)
    .filter((r) => typeof r['modelo'] === 'string' && (r['modelo'] as string).trim() && r['modelo'] !== 'Modelo')
    .map((r) => ({
      modelo: String(r['modelo']).trim(),
      impecable: toNum(r['impecable']),
      bateria: toNum(r['bateria']),
      pantalla: toNum(r['pantalla']),
      camara: toNum(r['camara']),
      microfono: toNum(r['microfono']),
      parlante: toNum(r['parlante']),
      tapa: toNum(r['tapa']),
      marco: toNum(r['marco']),
      pin: toNum(r['pin']),
    }));

  const cuotasCoef: CuotaCoef[] = (raw?.cuotas_coef ?? [])
    .map((r) => r as Record<string, unknown>)
    .map((r) => ({
      cuotas: toNum(r['cuotas']),
      coeficiente: toNum(r['coeficiente']),
      mostrar: r['mostrar'] !== false,
    }))
    .filter((c) => c.cuotas > 0 && c.coeficiente > 0)
    .sort((a, b) => a.cuotas - b.cuotas);

  return {
    precios,
    toma,
    cuotasCoef,
    fetchedAt: Date.now(),
    promoVigenteHasta: null,
    promoAplicadaA: [],
  };
}

/**
 * Devuelve una copia de `data` con la promo puntual aplicada sobre el preventa.
 * Se ejecuta en cada getPricing() (no en el fetch) así editar/borrar promo.json
 * se refleja casi al instante, sin depender del TTL de la caché del Sheet.
 */
function applyPromo(data: PricingData): PricingData {
  const promo = loadPromo();
  if (!promo) return data;

  const promoAplicadaA: string[] = [];
  const precios = data.precios.map((row) => {
    const nuevo = promo.preventa.get(promoKey(row.modelo, row.almacenamiento));
    if (nuevo === undefined || nuevo === row.preventaARS) return row;
    promoAplicadaA.push(promoKey(row.modelo, row.almacenamiento));
    return { ...row, preventaARS: nuevo };
  });

  return {
    ...data,
    precios,
    promoVigenteHasta: promoAplicadaA.length > 0 ? promo.vigenteHasta : null,
    promoAplicadaA,
  };
}

/** Cuotas exactas para un monto: total = round(monto × coef); porCuota = round(total / n). */
export function calcularCuotas(
  monto: number,
  coefs: CuotaCoef[],
): Array<{ cuotas: number; porCuota: number; total: number }> {
  if (!(monto > 0)) return [];
  return coefs
    .filter((c) => c.mostrar && c.cuotas > 1)
    .map((c) => {
      const total = Math.round(monto * c.coeficiente);
      return { cuotas: c.cuotas, porCuota: Math.round(total / c.cuotas), total };
    });
}

const FALLA_KEYWORDS: Array<[keyof TomaRow, RegExp]> = [
  ['pantalla', /\b(pantalla|display|rajad|rota|quebrad|fisurad|trizad|manchas?\s+en\s+la\s+pantalla|pixel)/i],
  ['bateria', /\b(bater[ií]a\s+(mala|gastada|baja|para\s+cambiar)|salud\s+de\s+bater[ií]a\s+baj|cambiar\s+la\s+bater[ií]a)/i],
  ['camara', /\b(c[aá]mara\s+(rota|fallada|con\s+manchas|empañad|no\s+enfoca)|manchas?\s+en\s+la\s+c[aá]mara)/i],
  ['microfono', /\b(micr[oó]fono|no\s+se\s+escucha\s+cuando\s+hablo|no\s+me\s+escuchan)/i],
  ['parlante', /\b(parlante|altavoz|auricular\s+de\s+llamada|no\s+se\s+escucha\s+el\s+audio)/i],
  ['tapa', /\b(tapa\s+(trasera|de\s+atr[aá]s)\s+(rota|rajad|quebrad)|vidrio\s+de\s+atr[aá]s\s+roto)/i],
  ['marco', /\b(marco\s+(golpead|abollad|doblad)|chasis\s+golpead|golpes?\s+en\s+el\s+marco|abollad)/i],
  ['pin', /\b(pin\s+de\s+carga|no\s+carga\s+bien|puerto\s+de\s+carga|conector\s+de\s+carga)/i],
];

/** Umbral de salud de batería: por debajo, la toma descuenta el cambio de batería. */
export const BATERIA_MIN_PCT = 85;

/**
 * Extrae el porcentaje de batería mencionado en texto.
 * @param text texto a analizar (mensajes del cliente)
 * @param allowBare si true, también acepta un porcentaje suelto ("88%", "88")
 *        — usar solo cuando el contexto ya es de batería (el agente la preguntó).
 */
export function detectBateriaPct(text: string, allowBare = false): number | null {
  const t = text.toLowerCase();
  const patterns = [
    /bater[ií]a\s*(?:al|en|de|:|est[aá]\s*(?:al|en)?)?\s*(\d{1,3})\s*%?/,
    /(\d{1,3})\s*%?\s*(?:de\s+)?bater[ií]a/,
    /salud\s*(?:de\s*(?:la\s*)?bater[ií]a)?\s*(?:al|en|de|:)?\s*(\d{1,3})/,
  ];
  if (allowBare) {
    patterns.push(/(?:^|[^a-z\d])(\d{2,3})\s*%/, /(?:tiene|est[aá]|anda)\s+(?:en\s+)?(\d{2,3})\b/);
  }
  for (const rx of patterns) {
    const m = rx.exec(t);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 100) return n;
    }
  }
  return null;
}

/**
 * Detecta fallas mencionadas en texto libre. Devuelve el set de claves de TomaRow.
 * Si se pasa `bateriaPct` y es menor a BATERIA_MIN_PCT, se agrega 'bateria'
 * (batería por debajo del umbral = hay que cambiarla → descuenta).
 */
export function detectFallas(text: string, bateriaPct?: number | null): Array<keyof TomaRow> {
  const found = new Set<keyof TomaRow>();
  for (const [key, rx] of FALLA_KEYWORDS) {
    if (rx.test(text)) found.add(key);
  }
  if (typeof bateriaPct === 'number' && bateriaPct < BATERIA_MIN_PCT) {
    found.add('bateria');
  }
  return [...found];
}

// Frases que introducen el equipo que el cliente ENTREGA (no el que quiere comprar).
// Frases que introducen el equipo que el cliente ENTREGA. "cambio MI 15" sí
// (apunta al equipo propio); "cambiarlo por un 17" NO (apunta al que quiere).
const PERMUTA_INTRO = new RegExp(
  '(entrego|entregando|doy|dando|dejo|tengo|cambio|cambiar|permuto)\\s+' +
  '(un|una|el|la|mi)\\s*(iphone|i ?phone|1[0-7]|xs|xr)' +
  '|a\\s+cuenta|parte\\s+de\\s+pago|en\\s+permuta|hacen\\s+permuta|hacen\\s+canje|de\\s+canje|plan\\s+canje' +
  '|cu[aá]nto\\s+me\\s+tom|me\\s+tom[aá]n|lo\\s+entrego|para\\s+entregar|el\\s+m[ií]o\\s+es',
  'i',
);

/**
 * Detecta el equipo que el cliente ofrece en parte de pago.
 * Toma el segmento de texto a partir de la frase de permuta y busca ahí el
 * modelo/almacenamiento, para no confundirlo con el equipo que quiere comprar.
 */
export function detectTradeIn(text: string): { modelo: string; almacenamiento: string | null } | null {
  const m = PERMUTA_INTRO.exec(text);
  if (!m) return null;
  // Segmento acotado: desde la frase de permuta hasta la primera coma / "por" /
  // "queria" — así "tengo un 15 pro, quiero cambiarlo por un 17" toma el 15, no el 17.
  const rest = text.slice(m.index);
  const cut = rest.search(/,|\bpor\b|\bquer[ií]a\b|\bquiero\b|\bpara\b/i);
  const segmento = cut > 8 ? rest.slice(0, cut) : rest;

  // El PRIMER modelo que aparece en el segmento es el que entrega el cliente.
  const num = /\b(1[1-7]|xs\s*max|xr|xs|x|8\s*plus|8)(?!\d)\s*(pro\s*max|pro|plus|mini)?/i.exec(segmento);
  let modelo: string | null = null;
  if (num) {
    const base = /^\d/.test(num[1]!) ? `iPhone ${num[1]}` : `iPhone ${num[1]!.toUpperCase()}`;
    const variante = num[2] ? ` ${num[2].replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}` : '';
    modelo = (base + variante).replace('Xs', 'XS').replace('Xr', 'XR');
  }
  modelo = modelo ?? normalizeModel(segmento);
  if (!modelo) return null;

  return { modelo, almacenamiento: normalizeStorage(segmento) ?? normalizeStorage(rest) };
}

/**
 * Devuelve los precios en vivo. Usa caché si está fresca.
 * Si el ERP no está configurado (sin PRICING_API_URL) devuelve error —
 * el caller decide (el pipeline continúa sin bloque de precios).
 */
export async function getPricing(): Promise<Result<PricingData>> {
  if (isFresh(_cache)) return ok(applyPromo(_cache));

  const url = process.env['PRICING_API_URL'];
  const token = process.env['PRICING_API_TOKEN'];
  if (!url || !token) {
    return err(new Error('PRICING_API_URL / PRICING_API_TOKEN no configurados'));
  }

  const sep = url.includes('?') ? '&' : '?';
  const full = `${url}${sep}api=all&token=${encodeURIComponent(token)}`;

  try {
    const res = await fetch(full, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as ApiResponse;
    if (!json.ok) throw new Error(json.error ?? 'respuesta ok:false');

    _cache = normalizeRows(json.data);
    return ok(applyPromo(_cache));
  } catch (e) {
    // Fallback: caché vencida si existe
    if (_cache) return ok(applyPromo(_cache));
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/** Fuerza refetch en la próxima llamada (tests / actualización en caliente). */
export function invalidatePricingCache(): void {
  _cache = null;
}

// ===========================================================================
// Lookups
// ===========================================================================

/** Extrae "iPhone 13" y "128 GB" de un string tipo "iPhone 13 128 GB". */
function splitModeloAlmacenamiento(s: string): { modelo: string; almacenamiento: string } {
  const m = s.match(/^(.*?)(\d+\s*(?:GB|TB))\s*$/i);
  if (m) return { modelo: m[1]!.trim(), almacenamiento: m[2]!.replace(/\s+/g, '').toUpperCase() };
  return { modelo: s.trim(), almacenamiento: '' };
}

/**
 * Busca las filas de precio que matchean el modelo (y opcionalmente el
 * almacenamiento). Devuelve todas las variantes de almacenamiento del modelo
 * si no se especifica una.
 */
export function findPrecios(
  data: PricingData,
  modeloRaw: string,
  almacenamientoRaw?: string | null,
): PrecioRow[] {
  const modelo = normalizeModel(modeloRaw);
  if (!modelo) return [];
  const modeloN = normalizeText(modelo);
  const storageN = almacenamientoRaw ? normalizeStorage(almacenamientoRaw) : null;

  const matches = data.precios.filter((r) => normalizeText(r.modelo) === modeloN);
  if (!storageN) return matches;

  const exact = matches.filter(
    (r) => normalizeStorage(r.almacenamiento) === storageN,
  );
  return exact.length > 0 ? exact : matches;
}

/** Busca la fila de toma (canje) para un modelo + almacenamiento. */
export function findToma(
  data: PricingData,
  modeloRaw: string,
  almacenamientoRaw?: string | null,
): TomaRow | null {
  const modelo = normalizeModel(modeloRaw);
  if (!modelo) return null;
  const modeloN = normalizeText(modelo);
  const storageN = almacenamientoRaw ? normalizeStorage(almacenamientoRaw) : null;

  const candidates = data.toma
    .map((r) => ({ row: r, parsed: splitModeloAlmacenamiento(r.modelo) }))
    .filter(({ parsed }) => normalizeText(normalizeModel(parsed.modelo) ?? parsed.modelo) === modeloN);

  if (candidates.length === 0) return null;
  if (storageN) {
    const exact = candidates.find(
      ({ parsed }) => normalizeStorage(parsed.almacenamiento) === storageN,
    );
    if (exact) return exact.row;
  }
  return candidates[0]!.row;
}

/** Valor de toma orientativo = impecable − suma de fallas presentes. */
const FALLA_LABEL: Record<string, string> = {
  bateria: 'batería', pantalla: 'pantalla', camara: 'cámara', microfono: 'micrófono',
  parlante: 'parlante', tapa: 'tapa trasera', marco: 'marco', pin: 'pin de carga',
};

/** Valor de toma exacto = impecable − suma de descuentos de las fallas presentes. */
export function estimarToma(
  row: TomaRow,
  fallas: Array<keyof TomaRow>,
): { base: number; deducciones: Array<{ parte: string; monto: number }>; total: number } {
  const deducciones: Array<{ parte: string; monto: number }> = [];
  for (const key of fallas) {
    const label = FALLA_LABEL[key as string];
    if (label && typeof row[key] === 'number' && row[key] > 0) {
      deducciones.push({ parte: label, monto: row[key] });
    }
  }
  const total = Math.max(0, row.impecable - deducciones.reduce((s, d) => s + d.monto, 0));
  return { base: row.impecable, deducciones, total };
}
