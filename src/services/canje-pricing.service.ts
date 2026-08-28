/**
 * Servicio de valuación orientativa para Plan Canje.
 *
 * Contiene la tabla de precios de toma por modelo y tipo de falla.
 * Las valuaciones son orientativas — la definitiva se confirma con
 * el equipo en mano en el local.
 *
 * Fuente de datos: GREATPHONES_BUSINESS_INFO.md §14 (Precios de toma Plan Canje).
 */

import { normalizeModel } from './product-matching.service.js';

// ===========================================================================
// Tipos
// ===========================================================================

export type CanjaFalla =
  | 'pantalla'
  | 'tapa_trasera'
  | 'bateria'
  | 'camara'
  | 'microfono'
  | 'parlante'
  | 'auricular'
  | 'face_id';

export interface CanjeEstimado {
  modelo: string;
  basePrice: number;
  deductions: Array<{ falla: CanjaFalla; monto: number }>;
  totalOrientativo: number;
  /** true si se aplica descuento por face_id (modelos anteriores al 13) */
  faceIdAplica: boolean;
}

// ===========================================================================
// Tabla de toma (ARS) — GREATPHONES_BUSINESS_INFO §14
// ===========================================================================

interface CanjeEntry {
  base: number;
  pantalla: number;
  tapa_trasera: number;
  bateria: number;
  camara: number;
  microfono: number;
  parlante: number;
  auricular: number;
  /** Descuento por Face ID roto. null = no aplica (iPhone 13 en adelante). */
  face_id: number | null;
}

const CANJE_TABLE: Record<string, CanjeEntry> = {
  'iPhone 8': {
    base: 60_000, pantalla: 40_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 50_000, parlante: 50_000, auricular: 20_000, face_id: null,
  },
  'iPhone 8 Plus': {
    base: 100_000, pantalla: 45_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 50_000, parlante: 50_000, auricular: 20_000, face_id: null,
  },
  'iPhone X': {
    base: 120_000, pantalla: 60_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 50_000, parlante: 50_000, auricular: 20_000, face_id: 80_000,
  },
  'iPhone XR': {
    base: 140_000, pantalla: 60_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 50_000, parlante: 50_000, auricular: 20_000, face_id: 80_000,
  },
  'iPhone XS Max': {
    base: 170_000, pantalla: 90_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 50_000, parlante: 50_000, auricular: 20_000, face_id: 80_000,
  },
  'iPhone 11': {
    base: 145_000, pantalla: 70_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 80_000, parlante: 50_000, auricular: 20_000, face_id: 80_000,
  },
  'iPhone 11 Pro Max': {
    base: 180_000, pantalla: 70_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 80_000, parlante: 50_000, auricular: 20_000, face_id: 80_000,
  },
  'iPhone 12': {
    base: 210_000, pantalla: 70_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 80_000, parlante: 50_000, auricular: 80_000, face_id: 80_000,
  },
  'iPhone 12 Mini': {
    base: 210_000, pantalla: 70_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 80_000, parlante: 50_000, auricular: 80_000, face_id: 80_000,
  },
  'iPhone 12 Pro Max': {
    base: 300_000, pantalla: 70_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 80_000, parlante: 50_000, auricular: 80_000, face_id: 80_000,
  },
  'iPhone 13': {
    base: 300_000, pantalla: 120_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 80_000, parlante: 50_000, auricular: 80_000, face_id: null,
  },
  'iPhone 13 Pro': {
    base: 500_000, pantalla: 150_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 80_000, parlante: 50_000, auricular: 80_000, face_id: null,
  },
  'iPhone 13 Pro Max': {
    base: 550_000, pantalla: 160_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 80_000, parlante: 100_000, auricular: 80_000, face_id: null,
  },
  'iPhone 14': {
    base: 430_000, pantalla: 150_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 80_000, parlante: 100_000, auricular: 80_000, face_id: null,
  },
  'iPhone 14 Pro': {
    base: 570_000, pantalla: 200_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 80_000, parlante: 100_000, auricular: 80_000, face_id: null,
  },
  'iPhone 14 Pro Max': {
    base: 650_000, pantalla: 200_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 200_000, parlante: 100_000, auricular: 80_000, face_id: null,
  },
  'iPhone 15': {
    base: 650_000, pantalla: 190_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 150_000, microfono: 200_000, parlante: 100_000, auricular: 80_000, face_id: null,
  },
  'iPhone 15 Pro': {
    base: 725_000, pantalla: 220_000, tapa_trasera: 50_000, bateria: 80_000,
    camara: 220_000, microfono: 200_000, parlante: 100_000, auricular: 80_000, face_id: null,
  },
  'iPhone 15 Pro Max': {
    base: 870_000, pantalla: 300_000, tapa_trasera: 50_000, bateria: 190_000,
    camara: 220_000, microfono: 200_000, parlante: 100_000, auricular: 80_000, face_id: null,
  },
  'iPhone 16': {
    base: 725_000, pantalla: 190_000, tapa_trasera: 50_000, bateria: 190_000,
    camara: 220_000, microfono: 200_000, parlante: 100_000, auricular: 80_000, face_id: null,
  },
  'iPhone 16 Pro': {
    base: 1_005_000, pantalla: 250_000, tapa_trasera: 50_000, bateria: 190_000,
    camara: 220_000, microfono: 200_000, parlante: 100_000, auricular: 80_000, face_id: null,
  },
  'iPhone 16 Pro Max': {
    base: 1_160_000, pantalla: 300_000, tapa_trasera: 50_000, bateria: 190_000,
    camara: 220_000, microfono: 200_000, parlante: 100_000, auricular: 80_000, face_id: null,
  },
  'iPhone 17': {
    base: 940_000, pantalla: 700_000, tapa_trasera: 50_000, bateria: 190_000,
    camara: 350_000, microfono: 200_000, parlante: 100_000, auricular: 80_000, face_id: null,
  },
  'iPhone 17 Pro': {
    base: 1_500_000, pantalla: 1_000_000, tapa_trasera: 50_000, bateria: 190_000,
    camara: 350_000, microfono: 200_000, parlante: 100_000, auricular: 80_000, face_id: null,
  },
  'iPhone 17 Pro Max': {
    base: 1_600_000, pantalla: 1_100_000, tapa_trasera: 50_000, bateria: 190_000,
    camara: 350_000, microfono: 200_000, parlante: 100_000, auricular: 80_000, face_id: null,
  },
};

// ===========================================================================
// Función de cálculo
// ===========================================================================

/**
 * Calcula el precio orientativo de toma en Plan Canje.
 *
 * @param modelInput - Nombre del modelo tal como lo menciona el cliente
 * @param fallas     - Lista de fallas reportadas
 * @returns CanjeEstimado o null si el modelo no está en la tabla o no se acepta
 */
export function calculateCanjePrice(
  modelInput: string,
  fallas: CanjaFalla[],
): CanjeEstimado | null {
  const canonicalModel = normalizeModel(modelInput);
  const entry = CANJE_TABLE[canonicalModel];
  if (!entry) return null;

  const deductions: Array<{ falla: CanjaFalla; monto: number }> = [];

  for (const falla of fallas) {
    if (falla === 'face_id') {
      if (entry.face_id !== null) {
        deductions.push({ falla, monto: entry.face_id });
      }
      // Si face_id es null para este modelo, no se aplica descuento (no deductible)
      continue;
    }
    const monto = entry[falla];
    if (monto > 0) {
      deductions.push({ falla, monto });
    }
  }

  const totalDeductions = deductions.reduce((acc, d) => acc + d.monto, 0);
  const totalOrientativo = Math.max(0, entry.base - totalDeductions);

  return {
    modelo: canonicalModel,
    basePrice: entry.base,
    deductions,
    totalOrientativo,
    faceIdAplica: entry.face_id !== null,
  };
}

/**
 * Formatea el resultado del canje orientativo para el agente.
 *
 * @param estimado   - Resultado de calculateCanjePrice
 * @param precioCompra - Precio del equipo que el cliente quiere llevarse
 */
export function formatCanjeResult(
  estimado: CanjeEstimado,
  precioCompra: number,
): string {
  const diferencia = Math.max(0, precioCompra - estimado.totalOrientativo);
  const formatARS = (n: number) =>
    `$${n.toLocaleString('es-AR', { minimumFractionDigits: 0 })}`;

  if (diferencia === 0) {
    return `Con el ${estimado.modelo} en el estado que describís, cubrís el total. Confirmamos el precio exacto con el equipo en mano.`;
  }

  return `Con el ${estimado.modelo} en ese estado, el valor orientativo es ${formatARS(estimado.totalOrientativo)}. Te quedarían a abonar ${formatARS(diferencia)}. Confirmamos cuando lo traés.`;
}

/**
 * Devuelve si el modelo acepta canje.
 * Acepta iPhone 11 en adelante (no 8, 8 Plus, X, XR, XS Max).
 */
export function modeloAceptadoEnCanje(modelInput: string): boolean {
  const canonical = normalizeModel(modelInput);
  const noAceptados = new Set(['iPhone 8', 'iPhone 8 Plus', 'iPhone X', 'iPhone XR', 'iPhone XS Max']);
  // Si está en tabla y no está en la lista de no aceptados en canje, se acepta
  return canonical in CANJE_TABLE && !noAceptados.has(canonical);
}
