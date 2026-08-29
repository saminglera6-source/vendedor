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

export interface PricingData {
  precios: PrecioRow[];
  toma: TomaRow[];
  fetchedAt: number;
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
  data?: { precios?: unknown[]; toma?: unknown[] };
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

  return { precios, toma, fetchedAt: Date.now() };
}

/**
 * Devuelve los precios en vivo. Usa caché si está fresca.
 * Si el ERP no está configurado (sin PRICING_API_URL) devuelve error —
 * el caller decide (el pipeline continúa sin bloque de precios).
 */
export async function getPricing(): Promise<Result<PricingData>> {
  if (isFresh(_cache)) return ok(_cache);

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
    return ok(_cache);
  } catch (e) {
    // Fallback: caché vencida si existe
    if (_cache) return ok(_cache);
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
export function estimarToma(
  row: TomaRow,
  fallas: Partial<Record<'bateria' | 'pantalla' | 'camara' | 'microfono' | 'parlante' | 'tapa' | 'marco' | 'pin', boolean>>,
): { base: number; deducciones: Array<{ parte: string; monto: number }>; total: number } {
  const map: Array<[keyof typeof fallas, string]> = [
    ['bateria', 'batería'], ['pantalla', 'pantalla'], ['camara', 'cámara'],
    ['microfono', 'micrófono'], ['parlante', 'parlante'], ['tapa', 'tapa trasera'],
    ['marco', 'marco'], ['pin', 'pin de carga'],
  ];
  const deducciones: Array<{ parte: string; monto: number }> = [];
  for (const [key, label] of map) {
    if (fallas[key]) deducciones.push({ parte: label, monto: row[key] });
  }
  const total = Math.max(0, row.impecable - deducciones.reduce((s, d) => s + d.monto, 0));
  return { base: row.impecable, deducciones, total };
}
