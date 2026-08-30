/**
 * Parser de respuestas del agente Claude.
 *
 * Claude responde siempre vía tool_use con la herramienta "responder_cliente".
 * Este módulo extrae el bloque tool_use, valida el contenido con Zod y
 * retorna un AgentResponse tipado.
 *
 * Nunca parsea texto libre — si Claude no usa la herramienta, es un error.
 */

import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { ok, err, AgentError, type Result, type AgentResponse } from '../types.js';

// ===========================================================================
// Esquemas Zod
// ===========================================================================

const FollowupSpecSchema = z.object({
  tipo: z.enum(['recuperacion', 'cierre', 'check_in', 'oferta']),
  delay_hours: z.number().int().min(1).max(8760), // 1h mínimo — 1 año máximo
  mensaje_base: z.string().min(1).max(500),
});

const CustomerMemoryPatchSchema = z
  .object({
    producto_interes: z.string().optional(),
    color_preferido: z.string().optional(),
    almacenamiento: z.string().optional(),
    presupuesto_min: z.number().nonnegative().optional(),
    presupuesto_max: z.number().nonnegative().optional(),
    fecha_estimada_compra: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha debe ser YYYY-MM-DD')
      .optional(),
    resumen_comercial: z.string().max(1000).optional(),
  })
  // Sin .strict(): los modelos chicos a veces agregan campos de más — Zod los
  // descarta silenciosamente en vez de tirar todo el turno.
  ;

const CoerceBool = z.union([
  z.boolean(),
  z.string().transform((s) => /^(true|1|si|sí|yes)$/i.test(s.trim())),
  z.null().transform(() => false),
]);

export const AgentResponseSchema = z
  .object({
    respuesta: z
      .string()
      .max(2000, 'respuesta demasiado larga para WhatsApp')
      .catch(''),

    // Preprocesado: un array de <2 elementos no tiene sentido como fragmentos
    // (se manda un solo mensaje) → null. Más de 3 → recortar. Filtrar vacíos.
    fragmentos: z.preprocess((v) => {
      if (!Array.isArray(v)) return null;
      const cleaned = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).slice(0, 700));
      if (cleaned.length < 2) return null;
      return cleaned.slice(0, 3);
    }, z.array(z.string()).nullable()),

    lead_score: z
      .coerce.number()
      .catch(0)
      .transform((n) => Math.min(100, Math.max(0, Math.round(n)))),

    estado: z.enum([
      'NEW', 'CONSULTA', 'INTERESADO', 'MUY_INTERESADO',
      'LISTO_PARA_COMPRAR', 'CLIENTE', 'PERDIDO',
    ]).catch('CONSULTA'),

    intencion: z.enum([
      'consulta', 'disponibilidad', 'precio', 'comparacion',
      'compra', 'objecion', 'queja', 'saludo', 'otro',
    ]).catch('otro'),

    accion_venta: z.enum([
      'pregunta_variante', 'pregunta_ciudad', 'pregunta_presupuesto', 'pregunta_uso',
      'precio_dado', 'disponibilidad_dada', 'alternativa_ofrecida', 'objecion_resuelta',
      'visita_propuesta', 'cierre_propuesto', 'seguimiento_creado', 'derivacion_humano', 'solo_respondio',
    ]).catch('solo_respondio'),

    requiere_humano: CoerceBool.catch(false),

    pasar_a_humano: CoerceBool.catch(false),

    followup: FollowupSpecSchema.nullable().catch(null),

    data_faltante: z.preprocess(
      (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : v),
      z.array(z.string()).nullable(),
    ).catch(null),

    memory_update: CustomerMemoryPatchSchema.nullable().catch(null),
  });

/** Tipo inferido de Zod — coincide con AgentResponse de types.ts */
export type ParsedAgentResponse = z.infer<typeof AgentResponseSchema>;

// ===========================================================================
// Función principal de parseo
// ===========================================================================

/**
 * Extrae y valida el AgentResponse desde la respuesta de Claude.
 *
 * Flujo:
 * 1. Busca el bloque tool_use en `message.content`
 * 2. Verifica que el nombre sea "responder_cliente"
 * 3. Valida el input con Zod
 * 4. Retorna Result<AgentResponse>
 *
 * Retorna error si:
 * - No hay bloque tool_use (Claude usó texto libre — no debería ocurrir con tool_choice forzado)
 * - El nombre del tool es inesperado
 * - La validación Zod falla (Claude devolvió campos inválidos)
 */
export function parseAgentResponse(
  message: Anthropic.Message,
): Result<AgentResponse> {
  // Buscar el bloque tool_use en el contenido de la respuesta
  const toolUseBlock = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (!toolUseBlock) {
    return err(
      new AgentError('Claude no devolvió tool_use — se esperaba responder_cliente', {
        stop_reason: message.stop_reason,
        content_types: message.content.map((b) => b.type),
        usage: message.usage,
      }),
    );
  }

  if (toolUseBlock.name !== 'responder_cliente') {
    return err(
      new AgentError(`Tool inesperado: "${toolUseBlock.name}"`, {
        expected: 'responder_cliente',
        received: toolUseBlock.name,
      }),
    );
  }

  const parseResult = AgentResponseSchema.safeParse(toolUseBlock.input);

  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const summary = firstIssue
      ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
      : parseResult.error.message;

    return err(
      new AgentError(`AgentResponse inválido: ${summary}`, {
        issues: parseResult.error.issues,
        received: toolUseBlock.input,
      }),
    );
  }

  // El cast es seguro: AgentResponseSchema produce la misma forma que AgentResponse.
  // La diferencia tipológica es que Zod infiere tipos ligeramente más amplios en
  // algunas uniones. El runtime ya está validado por safeParse.
  return ok(parseResult.data as unknown as AgentResponse);
}

// ===========================================================================
// Helper: extraer el texto de respuesta sin parseo completo
// ===========================================================================

/**
 * Extrae solo el campo `respuesta` del tool_use sin validar el resto.
 * Útil en language-guard para la regeneración — evita parseo doble.
 */
export function extractRespuestaFromMessage(
  message: Anthropic.Message,
): string | null {
  const toolUseBlock = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (!toolUseBlock || toolUseBlock.name !== 'responder_cliente') return null;

  const input = toolUseBlock.input as Record<string, unknown>;
  const respuesta = input['respuesta'];

  return typeof respuesta === 'string' && respuesta.length > 0 ? respuesta : null;
}
