/**
 * Clasificador de tipo de consulta para la integración con Kommo.
 *
 * Determina a qué pipeline de Kommo debe ir el lead según el contenido
 * del primer mensaje del cliente. Usa matching de keywords normalizado.
 *
 * Función pura — sin efectos secundarios, testeable de forma aislada.
 */

import type { KommoTipoConsulta } from './types.js';
import type { AgentResponse } from '../../types.js';

// ===========================================================================
// Keywords por tipo de consulta
// Orden de prioridad: permuta > garantia > reparacion > venta > accesorios > compra
// ===========================================================================

const SIGNALS: Record<Exclude<KommoTipoConsulta, 'consulta_general' | 'cliente_existente'>, string[]> = {
  permuta: [
    'permuta', 'plan canje', 'canje', 'cambio el mio', 'cambio mi',
    'entrego el mio', 'entrego mi', 'lo doy a cuenta', 'parte de pago',
    'cuanto me descuentan', 'me lo toman', 'toman mi', 'cambio por',
    'cambiar mi iphone', 'cambio mi iphone',
  ],
  garantia: [
    'garantia', 'garantía', 'lo compre y', 'compre hace', 'compré hace',
    'dejo de funcionar', 'dejó de funcionar', 'se rompio solo', 'se rompió solo',
    'falla desde que', 'reclamo', 'lo compré con ustedes', 'lo compre ahi',
    'me lo vendieron y', 'tienen garantia', 'cobro de garantia',
  ],
  reparacion: [
    'reparar', 'reparacion', 'reparación', 'arreglar', 'tecnico', 'técnico',
    'servicio tecnico', 'servicio técnico', 'roto', 'rompi', 'rompí',
    'no funciona', 'no enciende', 'no prende', 'no carga', 'no carga',
    'pantalla rota', 'pantalla rajada', 'rajada', 'rajado', 'pantalla partida',
    'se cayo', 'se cayó', 'cayo al agua', 'cayó al agua', 'se mojo', 'se mojó',
    'mojado', 'agua', 'bateria hinchada', 'batería hinchada',
    'se reinicia', 'se cuelga', 'no arranca', 'no funciona el', 'falla la',
    'falla el', 'puerto de carga', 'no reconoce',
  ],
  venta: [
    'quiero vender', 'vendo mi', 'vendo el', 'me compran', 'cuanto me dan',
    'cuánto me dan', 'cuanto pagan', 'cuánto pagan', 'compran iphone',
    'vender mi iphone', 'quieren comprar', 'les vendo', 'me lo compran',
    'cuanto me ofrecen', 'cuánto me ofrecen', 'me interesa vender',
    'quiero desprender', 'quiero dejar',
  ],
  accesorios: [
    'funda', 'cargador', 'cable', 'auricular', 'auriculares', 'vidrio templado',
    'protector de pantalla', 'protector', 'estuche', 'case', 'accesorios',
    'accesorio', 'magsafe', 'soporte', 'adaptador',
  ],
  compra: [
    'tienen el', 'tienen iphone', 'quiero comprar', 'quiero el', 'me interesa el',
    'precio del', 'precio de', 'cuanto sale', 'cuánto sale', 'a cuanto',
    'a cuánto', 'cuesta', 'tienen disponible', 'disponible', 'stock',
    'lo tienen', 'me lo venden', 'venden el', 'iphone 15', 'iphone 14',
    'iphone 13', 'iphone 16', 'iphone 17', 'iphone 12', 'iphone 11',
    'iphone x', 'busco un', 'necesito un iphone', 'me conseguis',
  ],
};

// ===========================================================================
// Normalización
// ===========================================================================

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countMatches(normalizedText: string, signals: string[]): number {
  return signals.filter((s) => normalizedText.includes(normalize(s))).length;
}

// ===========================================================================
// Clasificador principal
// ===========================================================================

/**
 * Clasifica el tipo de consulta a partir del primer mensaje del cliente.
 *
 * Orden de prioridad (de mayor a menor):
 * permuta > garantia > reparacion > venta > accesorios > compra > consulta_general
 *
 * Si el agente ya determinó una intención clara, se usa como fallback.
 */
export function classifyTipoConsulta(
  message: string,
  agentResponse?: AgentResponse,
): KommoTipoConsulta {
  const normalized = normalize(message);

  const scores = {
    permuta: countMatches(normalized, SIGNALS.permuta),
    garantia: countMatches(normalized, SIGNALS.garantia),
    reparacion: countMatches(normalized, SIGNALS.reparacion),
    venta: countMatches(normalized, SIGNALS.venta),
    accesorios: countMatches(normalized, SIGNALS.accesorios),
    compra: countMatches(normalized, SIGNALS.compra),
  } as const;

  // Prioridad estricta
  if (scores.permuta > 0) return 'permuta';
  if (scores.garantia > 0) return 'garantia';
  if (scores.reparacion > 0) return 'reparacion';
  if (scores.venta > 0) return 'venta';
  if (scores.accesorios > 0) return 'accesorios';
  if (scores.compra > 0) return 'compra';

  // Fallback: usar la intención que detectó el agente
  if (agentResponse) {
    switch (agentResponse.intencion) {
      case 'compra':
      case 'disponibilidad':
      case 'precio':
      case 'comparacion':
        return 'compra';
      default:
        return 'consulta_general';
    }
  }

  return 'consulta_general';
}

/**
 * Convierte lead_score a temperatura para el campo personalizado de Kommo.
 */
export function scoreToTemperatura(
  score: number,
): 'caliente' | 'tibio' | 'frio' | 'no_calificado' {
  if (score >= 70) return 'caliente';
  if (score >= 40) return 'tibio';
  if (score >= 10) return 'frio';
  return 'no_calificado';
}

/**
 * Extrae el número de teléfono del sender_id de Kommo.
 * Formato del sender_id: "whatsapp:5491155550001"
 *
 * Retorna el teléfono limpio (solo dígitos) o null si no se puede parsear.
 */
export function extractPhoneFromSenderId(senderId: string): string | null {
  const match = senderId.match(/^(?:whatsapp|instagram|facebook|telegram):(.+)$/);
  if (!match || !match[1]) return null;
  // Mantener solo dígitos para normalización
  return match[1].replace(/\D/g, '') || match[1];
}

/**
 * Extrae el canal (whatsapp, instagram, facebook, web) del sender_id de Kommo.
 */
export function extractChannelFromSenderId(
  senderId: string,
): 'whatsapp' | 'instagram' | 'facebook' | 'web' {
  if (senderId.startsWith('whatsapp:')) return 'whatsapp';
  if (senderId.startsWith('instagram:')) return 'instagram';
  if (senderId.startsWith('facebook:')) return 'facebook';
  return 'web';
}
