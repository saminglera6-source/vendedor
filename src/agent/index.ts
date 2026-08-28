/**
 * Orquestador del pipeline del agente vendedor.
 *
 * Implementa los 13 pasos de CLAUDE.md §19 para cada mensaje entrante.
 * Integra: product matching, lead scoring, customer memory, followups,
 * business rules, prompt building, Claude call, language guard y persistencia.
 *
 * RAG (pasos 5 y la parte de chunks) queda como stub vacío hasta que
 * src/rag/embed.ts y src/rag/search.ts estén implementados.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  ok,
  err,
  AgentError,
  type Result,
  type AgentResponse,
  type LeadEstado,
  type AgentContext,
} from '../types.js';

// — DB layer —
import { createLead, syncLeadAfterMessage } from '../db/leads.js';
import { getHistoryForPrompt, appendMessage } from '../db/conversations.js';
import { getBusinessRules } from '../db/business-rules.js';
import { createFollowup, cancelPendingFollowups } from '../db/followups.js';
import { createAiFeedback } from '../db/ai-feedback.js';

// — Services —
import { matchFromMessage } from '../services/product-matching.service.js';
import { assessLead } from '../services/lead-scoring.service.js';
import { getOrCreate, applyPatch, regenerateResumen } from '../services/customer-memory.service.js';

// — Agent layer —
import { buildPrompt, RESPONDER_CLIENTE_TOOL } from './prompt.js';
import { parseAgentResponse } from './parser.js';
import { checkLanguage, formatViolationSummary } from './language-guard.js';

// — RAG layer —
import { embed } from '../rag/embed.js';
import { searchSimilar } from '../rag/search.js';

// ===========================================================================
// Tipos públicos
// ===========================================================================

export interface ProcessMessageInput {
  /** Número de teléfono del cliente (identificador principal del lead) */
  phone: string;
  /** Mensaje recibido */
  message: string;
  /** Canal de origen — default: whatsapp */
  channel?: 'whatsapp' | 'web';
}

export interface ProcessMessageOutput {
  /** Respuesta final para enviar al cliente */
  respuesta: string;
  /** AgentResponse completo para trazabilidad */
  agentResponse: AgentResponse;
  /** ID del lead procesado */
  leadId: string;
  /** Si se escaló a humano en este turno */
  escalated: boolean;
}

// ===========================================================================
// Cliente Anthropic singleton
// ===========================================================================

let _anthropic: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (_anthropic) return _anthropic;

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new AgentError(
      'ANTHROPIC_API_KEY no definida. Verificar .env.',
      { env: 'ANTHROPIC_API_KEY' },
    );
  }

  _anthropic = new Anthropic({
    apiKey,
    // Header requerido para activar prompt caching
    defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
  });

  return _anthropic;
}

const AGENT_MODEL = process.env['AGENT_MODEL'] ?? 'claude-sonnet-4-6';

// ===========================================================================
// Helpers de estado
// ===========================================================================

const ESTADO_ORDER: readonly LeadEstado[] = [
  'NEW', 'CONSULTA', 'INTERESADO', 'MUY_INTERESADO',
  'LISTO_PARA_COMPRAR', 'CLIENTE',
];

/**
 * Retorna el estado más avanzado entre dos.
 * PERDIDO tiene lógica especial: gana si alguno lo es.
 * CLIENTE no retrocede (si ya es CLIENTE, queda CLIENTE).
 */
function advanceEstado(a: LeadEstado, b: LeadEstado): LeadEstado {
  if (a === 'PERDIDO' || b === 'PERDIDO') return 'PERDIDO';
  const idxA = ESTADO_ORDER.indexOf(a);
  const idxB = ESTADO_ORDER.indexOf(b);
  return idxA >= idxB ? a : b;
}

// ===========================================================================
// Llamada a Claude con manejo de errores
// ===========================================================================

async function callClaude(
  context: AgentContext,
): Promise<Result<Anthropic.Message>> {
  try {
    const { system, messages, tools } = buildPrompt(context);
    const client = getAnthropicClient();

    const response = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 1024,
      // Los tipos de system y tools usan intersecciones locales para cache_control.
      // El cast es seguro: la API acepta cache_control vía beta header.
      system: system as Anthropic.TextBlockParam[],
      messages,
      tools: tools as Anthropic.Tool[],
      tool_choice: { type: 'tool', name: RESPONDER_CLIENTE_TOOL.name },
    });

    return ok(response);
  } catch (error) {
    return err(
      new AgentError(
        `Error llamando a Claude: ${error instanceof Error ? error.message : String(error)}`,
        { model: AGENT_MODEL, cause: String(error) },
      ),
    );
  }
}

// ===========================================================================
// Pipeline principal
// ===========================================================================

/**
 * Procesa un mensaje entrante y retorna la respuesta del agente.
 *
 * Pasos (CLAUDE.md §19):
 *  1.  Buscar/crear lead por teléfono
 *  2.  Cargar business_rules (con caché TTL)
 *  3.  Cargar customer_memory
 *  4.  Cargar historial de conversación
 *  5.  RAG stub — sin implementar, chunks vacíos
 *  6.  Detectar producto en el mensaje (product matching)
 *  7.  Evaluación comercial del mensaje (lead scoring)
 *  8.  Construir prompt con contexto completo
 *  9.  Llamar a Claude → AgentResponse via tool_use
 *  10. Language guard — verificar frases prohibidas
 *  11. Persistir todo en una pasada
 *  12. Escalación si requiere_humano
 *  13. Retornar respuesta al cliente
 */
export async function processMessage(
  input: ProcessMessageInput,
): Promise<Result<ProcessMessageOutput>> {
  const { phone, message, channel = 'whatsapp' } = input;

  // ─── Paso 1: Lead ────────────────────────────────────────────────────────
  const leadResult = await createLead({ phone, channel });
  if (!leadResult.ok) return err(leadResult.error);
  const lead = leadResult.value;

  // ─── Paso 2: Business rules ──────────────────────────────────────────────
  const rulesResult = await getBusinessRules();
  if (!rulesResult.ok) return err(rulesResult.error);
  const rules = rulesResult.value;

  // ─── Paso 3: Customer memory (fallo no bloquea) ──────────────────────────
  const memoryResult = await getOrCreate(lead.id);
  const memory = memoryResult.ok ? memoryResult.value : null;

  // ─── Paso 4: Historial (fallo no bloquea) ────────────────────────────────
  const historyResult = await getHistoryForPrompt(lead.id, 20);
  const history = historyResult.ok ? historyResult.value : [];

  // ─── Paso 5: RAG — embed + búsqueda vectorial ────────────────────────────
  // Embeddings locales (Transformers.js) — sin API key. Fallo no bloquea:
  // si el modelo no cargó o no hay chunks, continúa con [].
  let ragChunks: AgentContext['ragChunks'] = [];
  {
    const embeddingResult = await embed(message, 'query');
    if (embeddingResult.ok) {
      const ragTopK = rules.rag_top_k.value ?? 5;
      const ragThreshold = rules.rag_top_k.threshold ?? 0.75;
      const searchResult = await searchSimilar(embeddingResult.value, {
        topK: ragTopK,
        threshold: ragThreshold,
      });
      if (searchResult.ok) ragChunks = searchResult.value;
    }
  }

  // ─── Paso 6: Product matching ────────────────────────────────────────────
  const matchResult = await matchFromMessage(message, memory);
  const productVariants = matchResult.ok
    ? [...matchResult.value.variants, ...matchResult.value.alternatives].slice(0, 5)
    : [];

  // ─── Paso 7: Lead scoring ─────────────────────────────────────────────────
  const assessment = assessLead(message, lead, rules);

  // ─── Paso 8: Construir contexto y prompt ─────────────────────────────────
  const context: AgentContext = {
    lead,
    memory,
    history,
    ragChunks,
    productVariants,
    rules,
    userMessage: message,
  };

  // ─── Paso 9: Llamar a Claude ─────────────────────────────────────────────
  const claudeResult = await callClaude(context);
  if (!claudeResult.ok) return err(claudeResult.error);

  const parseResult = parseAgentResponse(claudeResult.value);
  if (!parseResult.ok) return err(parseResult.error);

  let agentResponse = parseResult.value;

  // ─── Paso 10: Language guard ──────────────────────────────────────────────
  const guardResult = checkLanguage(agentResponse.respuesta, rules.prohibited_phrases);

  if (!guardResult.passed) {
    // Loguear el fallo (fire and forget — no bloquear la respuesta)
    void createAiFeedback({
      respuesta_original: agentResponse.respuesta,
      respuesta_corregida: formatViolationSummary(guardResult.violations),
      motivo: 'lenguaje_prohibido',
      lead_id: lead.id,
      corregido_por: 'system',
    }).catch((e: unknown) => {
      console.error('[language-guard] Error al loguear ai_feedback:', e);
    });

    // Reintentar la llamada a Claude una sola vez con instrucción explícita
    const retryContext: AgentContext = {
      ...context,
      // Agregar al final del historial sintético para que Claude entienda el problema
      history: [
        ...history,
        { role: 'user' as const, content: message },
        {
          role: 'assistant' as const,
          content: `[NOTA INTERNA: La respuesta anterior contenía frases prohibidas: ${guardResult.violations.join(', ')}. Generar una nueva respuesta sin esas frases.]`,
        },
      ],
      userMessage: message,
    };

    const retryResult = await callClaude(retryContext);
    if (retryResult.ok) {
      const retryParseResult = parseAgentResponse(retryResult.value);
      if (retryParseResult.ok) {
        const retryGuard = checkLanguage(retryParseResult.value.respuesta, rules.prohibited_phrases);
        if (retryGuard.passed) {
          agentResponse = retryParseResult.value;
        } else {
          // Doble fallo — usar respuesta original, loguear
          console.error('[language-guard] Doble fallo en regeneración:', retryGuard.violations);
        }
      }
    }
  }

  // ─── Paso 11: Merge de scoring (backend como autoridad) ──────────────────
  //
  // Claude calcula score y estado desde el contexto conversacional.
  // Nuestro backend (`assessLead`) los calcula de forma determinista desde señales.
  // Regla de merge: usar la señal más fuerte para evitar que el agente
  // subestime el avance del lead.
  const mergedScore = Math.max(agentResponse.lead_score, assessment.newScore);
  const mergedEstado = advanceEstado(agentResponse.estado, assessment.suggestedEstado);
  const mergedRequiereHumano = agentResponse.requiere_humano || assessment.requiresHuman;

  const finalResponse: AgentResponse = {
    ...agentResponse,
    lead_score: mergedScore,
    estado: mergedEstado,
    requiere_humano: mergedRequiereHumano,
  };

  // ─── Paso 11: Persistir en una pasada ────────────────────────────────────
  //
  // El orden importa: mensajes primero, luego sync del lead.
  // Si algún paso falla, el error es no-fatal — retornamos la respuesta igual.

  // Mensaje del usuario
  const userMsgResult = await appendMessage({
    lead_id: lead.id,
    role: 'user',
    content: message,
    metadata: {
      intencion: finalResponse.intencion,
      estado_en_momento: lead.estado,
      lead_score_en_momento: lead.lead_score,
    },
  });

  // Mensaje del asistente (con metadata de venta)
  await appendMessage({
    lead_id: lead.id,
    role: 'assistant',
    content: finalResponse.respuesta,
    metadata: {
      intencion: finalResponse.intencion,
      accion_venta: finalResponse.accion_venta,
      estado_en_momento: finalResponse.estado,
      lead_score_en_momento: finalResponse.lead_score,
    },
  });

  // Sync del lead (score + estado + requiere_humano + last_contact en una query)
  await syncLeadAfterMessage(lead.id, {
    lead_score: finalResponse.lead_score,
    estado: finalResponse.estado,
    requiere_humano: finalResponse.requiere_humano,
  });

  // Actualizar memoria comercial si Claude detectó cambios
  if (finalResponse.memory_update !== null) {
    await applyPatch(lead.id, finalResponse.memory_update);
  }

  // Cancelar followups pendientes porque el cliente respondió
  await cancelPendingFollowups(lead.id);

  // Crear nuevo followup si el agente lo indicó
  if (finalResponse.followup !== null) {
    await createFollowup({
      lead_id: lead.id,
      tipo: finalResponse.followup.tipo,
      delay_hours: finalResponse.followup.delay_hours,
      mensaje_base: finalResponse.followup.mensaje_base,
    });
  }

  // Regenerar resumen comercial cada 5 mensajes (fire and forget)
  if (userMsgResult.ok) {
    void triggerResumenIfNeeded(lead.id).catch((e: unknown) => {
      console.error('[agent] Error al regenerar resumen comercial:', e);
    });
  }

  // ─── Paso 12: Escalación ─────────────────────────────────────────────────
  if (finalResponse.requiere_humano) {
    // En V1: loguear. La notificación al equipo se implementa en la API layer.
    console.warn('[agent] ESCALACIÓN requerida', {
      leadId: lead.id,
      phone,
      score: finalResponse.lead_score,
      estado: finalResponse.estado,
    });
  }

  // ─── Paso 13: Retornar ────────────────────────────────────────────────────
  return ok({
    respuesta: finalResponse.respuesta,
    agentResponse: finalResponse,
    leadId: lead.id,
    escalated: finalResponse.requiere_humano,
  });
}

// ===========================================================================
// Helper: regenerar resumen cada 5 mensajes
// ===========================================================================

/**
 * Cuenta los mensajes totales del lead. Si es múltiplo de 5, regenera el resumen.
 * Se usa una ventana de 200 mensajes (más que suficiente para detectar el ciclo de 5).
 *
 * Fire-and-forget — nunca bloquea el pipeline principal.
 */
async function triggerResumenIfNeeded(leadId: string): Promise<void> {
  const { countMessagesSince } = await import('../db/conversations.js');

  // Contar desde el inicio del tiempo para obtener el total
  const countResult = await countMessagesSince(leadId, '2000-01-01T00:00:00.000Z');
  if (!countResult.ok) return;

  const total = countResult.value;

  // Regenerar cada 5 mensajes (incluye tanto user como assistant)
  if (total > 0 && total % 5 === 0) {
    await regenerateResumen(leadId);
  }
}
