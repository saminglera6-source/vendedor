/**
 * Abstracción de proveedor LLM.
 *
 * El agente arma un prompt con `buildPrompt()` (shape Anthropic) y cada
 * proveedor lo traduce a su API. Todos devuelven el MISMO objeto crudo:
 * los argumentos de `responder_cliente` sin validar. La validación con Zod
 * ocurre una sola vez, en `generateAgentResponse()`.
 */

import type { Result } from '../../types.js';
import type { BuiltPrompt } from '../prompt.js';

export interface LlmProvider {
  readonly name: string;
  /** Devuelve el objeto de argumentos de responder_cliente (sin validar). */
  complete(prompt: BuiltPrompt): Promise<Result<Record<string, unknown>>>;
}

/**
 * Contrato JSON para proveedores que no tienen tool_use nativo (ej: Gemini).
 * Se agrega al system instruction. Los campos y su semántica están
 * documentados en detalle en RESPONDER_CLIENTE_TOOL (prompt.ts); acá va la
 * versión corta para forzar el formato de salida.
 */
export const JSON_CONTRACT = `
FORMATO DE SALIDA — OBLIGATORIO
Respondé ÚNICAMENTE con un objeto JSON válido (sin \`\`\`, sin texto antes ni después) con exactamente estos campos:
{
  "respuesta": string,            // mensaje para el cliente. "" (vacío) si pasar_a_humano es true
  "fragmentos": string[] | null,  // 2-3 mensajes cortos para WhatsApp, o null para un solo mensaje
  "lead_score": number,           // 0-100
  "estado": "NEW"|"CONSULTA"|"INTERESADO"|"MUY_INTERESADO"|"LISTO_PARA_COMPRAR"|"CLIENTE"|"PERDIDO",
  "intencion": "consulta"|"disponibilidad"|"precio"|"comparacion"|"compra"|"objecion"|"queja"|"saludo"|"otro",
  "accion_venta": "pregunta_variante"|"pregunta_ciudad"|"pregunta_presupuesto"|"pregunta_uso"|"precio_dado"|"disponibilidad_dada"|"alternativa_ofrecida"|"objecion_resuelta"|"visita_propuesta"|"cierre_propuesto"|"seguimiento_creado"|"derivacion_humano"|"solo_respondio",
  "requiere_humano": boolean,
  "pasar_a_humano": boolean,       // true = no mandar nada, sigue un asesor
  "followup": { "tipo": "recuperacion"|"cierre"|"check_in"|"oferta", "delay_hours": number, "mensaje_base": string } | null,
  "data_faltante": string[] | null,
  "memory_update": { "producto_interes"?: string, "color_preferido"?: string, "almacenamiento"?: string, "presupuesto_min"?: number, "presupuesto_max"?: number, "fecha_estimada_compra"?: string, "resumen_comercial"?: string } | null
}
Si fragmentos no es null, respuesta debe ser igual a fragmentos unidos por "\\n\\n".
`.trim();
