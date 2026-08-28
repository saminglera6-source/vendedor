/**
 * Guardia de lenguaje post-generación.
 *
 * Valida que la respuesta del agente no contenga frases prohibidas (CLAUDE.md §12, §13).
 * Se ejecuta DESPUÉS de parsear el AgentResponse, antes de persistir y enviar.
 *
 * Flujo en index.ts (CLAUDE.md §19, paso 10):
 *   1. checkLanguage(respuesta, prohibitedPhrases) → GuardResult
 *   2. Si violations.length > 0:
 *      a. Loguear en ai_feedback (motivo: 'lenguaje_prohibido')
 *      b. Regenerar llamando a Claude una vez más
 *      c. Si la regeneración también falla → usar respuesta original, logear el doble fallo
 *
 * Este módulo es puro (sin IO). El logging y la regeneración viven en index.ts.
 */

import { normalizeText } from '../services/product-matching.service.js';

// ===========================================================================
// Tipos públicos
// ===========================================================================

export interface GuardResult {
  /** true si la respuesta pasó la validación (sin violaciones) */
  passed: boolean;
  /** Frases prohibidas encontradas en la respuesta */
  violations: string[];
}

// ===========================================================================
// Frases adicionales que siempre se validan (además de las de business_rules)
// ===========================================================================

/**
 * Frases que NUNCA deben aparecer, independientemente de la configuración.
 * Son violaciones semánticas graves que comprometen la credibilidad del agente.
 */
const HARDCODED_VIOLATIONS: readonly string[] = [
  // IA / bot identity
  'como ia',
  'como modelo de lenguaje',
  'soy un bot',
  'soy una ia',
  'inteligencia artificial',
  'no tengo acceso',
  'no puedo verificar',
  // Datos inventados — crítico para integridad comercial
  'debería costar',
  'aproximadamente vale',
  'creo que sale',
  'supongo que',
  'no estoy seguro del precio',
  // Identidad personal (el agente representa a GreatPhones, nunca a una persona)
  'yo lo vendo',
  'yo hago envios',
  'yo te aviso',
  'te paso con sam',
  'te paso con martin',
  'te paso con el dueno',
  // Stock / origen de mercadería
  'lo puedo conseguir',
  // Escalación visible al cliente — la escalación es siempre interna, nunca mencionada al cliente
  'ya te paso con alguien',
  'te paso con alguien',
  'un asesor de greatphones',
  'le paso con un asesor',
  'lo voy a derivar',
  'voy a derivar',
  'derivamos la consulta',
  'nuestro equipo se contactara',
  'un representante',
  'voy a escalar',
  'vamos a revisar tu caso',
  'te confirmo con un asesor',
  'departamento de',
  'sector de',
  'area de',
  // Frases de call center / bot
  'estoy aca para ayudarte',
  'puedo ayudarte a cerrarlo',
  'le informamos',
  'estimado cliente',
  // Garantía — NUNCA confirmar cobertura por chat antes de revisar el equipo en el local
  'esta dentro de la garantia',
  'entra en garantia',
  'cubre la garantia',
  'lo cubre la garantia',
  'si te cubre',
  'esta cubierto',
  'queda cubierto',
  'aplica la garantia',
  'entra en la garantia',
  'corresponde la garantia',
] as const;

// ===========================================================================
// checkLanguage
// ===========================================================================

/**
 * Verifica que `respuesta` no contenga frases prohibidas.
 *
 * Matching case-insensitive sobre texto normalizado (sin acentos, sin puntuación).
 * La normalización evita falsos negativos por variaciones ortográficas.
 *
 * @param respuesta         - Texto de la respuesta generada por Claude
 * @param prohibitedPhrases - Array desde business_rules.prohibited_phrases
 */
export function checkLanguage(
  respuesta: string,
  prohibitedPhrases: readonly string[],
): GuardResult {
  const normalized = normalizeText(respuesta);
  const violations: string[] = [];

  // Verificar frases de business_rules
  for (const phrase of prohibitedPhrases) {
    const normalizedPhrase = normalizeText(phrase);
    if (normalized.includes(normalizedPhrase)) {
      violations.push(phrase);
    }
  }

  // Verificar frases hardcodeadas
  for (const phrase of HARDCODED_VIOLATIONS) {
    if (normalized.includes(phrase)) {
      // Evitar duplicados si la misma frase ya está en prohibited_phrases
      if (!violations.includes(phrase)) {
        violations.push(phrase);
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

// ===========================================================================
// formatViolationSummary (helper para logging)
// ===========================================================================

/**
 * Formatea las violaciones para incluir en el log de ai_feedback.
 * Devuelve un string conciso listo para `respuesta_corregida` del feedback.
 */
export function formatViolationSummary(violations: string[]): string {
  return `Frases prohibidas detectadas: ${violations.map((v) => `"${v}"`).join(', ')}`;
}
