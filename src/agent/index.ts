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

import {
  ok,
  err,
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
import { matchFromMessage, normalizeModel, normalizeText, formatPrice } from '../services/product-matching.service.js';
import {
  getPricing,
  findPrecios,
  findToma,
  calcularCuotas,
  estimarToma,
  detectFallas,
  detectBateriaPct,
  detectTradeIn,
  hasPermutaIntent,
  detectModelosMencionados,
  findPreciosEnPresupuesto,
} from '../services/pricing.service.js';
import { assessLead } from '../services/lead-scoring.service.js';
import { getOrCreate, applyPatch, regenerateResumen } from '../services/customer-memory.service.js';

/** Normaliza un nombre de modelo para comparar (canónico + sin acentos). */
const normModelo = (m: string): string => normalizeText(normalizeModel(m) ?? m);

// — Agent layer —
import { generateAgentResponse } from './llm/index.js';
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
  channel?: 'whatsapp' | 'instagram' | 'facebook' | 'web';
  /**
   * Historial previo traído de una fuente externa (ej: la conversación en Kommo
   * anterior a que el agente existiera). Se antepone al historial propio. Sirve
   * para que el agente vea si la persona ya encargó, ya reclamó, etc.
   */
  priorHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
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

/**
 * Parte una respuesta en 2-4 mensajes cortos estilo WhatsApp.
 * Un mensaje solo = apariencia de bot. Los vendedores mandan la confirmación,
 * el precio y la pregunta en burbujas separadas.
 */
function fragmentar(texto: string, existentes: string[] | null): string[] {
  // Punto de partida: los fragmentos del modelo si ya vienen, si no el texto entero.
  const fuente = existentes && existentes.length > 0 ? existentes : [texto];

  // 1) Partir por saltos de línea y por oración en las partes largas.
  let piezas: string[] = [];
  for (const bloque of fuente) {
    for (const linea of bloque.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
      if (linea.length <= 165) {
        piezas.push(linea);
        continue;
      }
      // Linea larga -> cortar tras . ! ? conservando el signo.
      // Enmascaramos los puntos de miles ("$545.000") para no cortar un numero.
      const PH = String.fromCharCode(1);
      const protegida = linea.replace(/(\d)\.(?=\d)/g, `$1${PH}`);
      const oraciones = (protegida.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [protegida])
        .map((s) => s.split(PH).join("."));
      let buffer = '';
      for (const o of oraciones.map((s) => s.trim())) {
        if ((buffer + ' ' + o).trim().length > 165 && buffer) {
          piezas.push(buffer.trim());
          buffer = o;
        } else {
          buffer = (buffer ? buffer + ' ' : '') + o;
        }
      }
      if (buffer.trim()) piezas.push(buffer.trim());
    }
  }
  // Reparar números partidos por el corte de oración ("$545. 000" → "$545.000").
  piezas = piezas.map((p) => p.replace(/(\d)\.\s+(?=\d{3}\b)/g, '$1.'));

  // 2) Unir fragmentos muy cortos con el siguiente (evita "Siii" solo).
  const unidas: string[] = [];
  for (const p of piezas) {
    if (unidas.length > 0 && unidas[unidas.length - 1]!.length < 22) {
      unidas[unidas.length - 1] = `${unidas[unidas.length - 1]} ${p}`.trim();
    } else {
      unidas.push(p);
    }
  }

  // 3) Cap a 4: el excedente se pega al último.
  if (unidas.length > 4) {
    const cabeza = unidas.slice(0, 3);
    cabeza.push(unidas.slice(3).join(' '));
    piezas = cabeza;
  } else {
    piezas = unidas;
  }

  return piezas.filter(Boolean);
}

/** El menos avanzado de dos estados (para poner techo por score). */
function leastAdvanced(a: LeadEstado, b: LeadEstado): LeadEstado {
  if (a === 'PERDIDO' || b === 'PERDIDO') return 'PERDIDO';
  const idxA = ESTADO_ORDER.indexOf(a);
  const idxB = ESTADO_ORDER.indexOf(b);
  return idxA <= idxB ? a : b;
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
  // La DB solo distingue 'whatsapp' | 'web'; instagram/facebook cuentan como whatsapp.
  const leadChannel = channel === 'web' ? 'web' : 'whatsapp';

  // ─── Paso 1: Lead ────────────────────────────────────────────────────────
  const leadResult = await createLead({ phone, channel: leadChannel });
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
  const historyResult = await getHistoryForPrompt(lead.id, 14);
  const ownHistory = historyResult.ok ? historyResult.value : [];
  // Se antepone el historial externo (Kommo pre-bot). Dedup simple por contenido
  // y se corta a los últimos 18 turnos para no inflar el prompt.
  const prior = input.priorHistory ?? [];
  const vistos = new Set(ownHistory.map((h) => h.content.trim()));
  const history = [
    ...prior.filter((h) => h.content.trim() && !vistos.has(h.content.trim())),
    ...ownHistory,
  ].slice(-18);

  // ─── Paso 5: RAG — embed + búsqueda vectorial ────────────────────────────
  // Embeddings locales (Transformers.js) — sin API key. Fallo no bloquea:
  // si el modelo no cargó o no hay chunks, continúa con [].
  let ragChunks: AgentContext['ragChunks'] = [];
  {
    const embeddingResult = await embed(message, 'query');
    if (embeddingResult.ok) {
      // Más ejemplos y umbral algo más laxo: el RAG acá se usa sobre todo
      // para calcar el estilo real, no solo para datos puntuales.
      const ragTopK = Math.max(rules.rag_top_k.value ?? 6, 6);
      const ragThreshold = Math.min(rules.rag_top_k.threshold ?? 0.68, 0.68);
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

  // ─── Paso 6.5: Precios en vivo desde el ERP ──────────────────────────────
  // Fuente de verdad para contado, preventa y toma. Fallo no bloquea.
  let livePricing: AgentContext['livePricing'] = null;
  {
    const pricingResult = await getPricing();
    if (pricingResult.ok) {
      const data = pricingResult.value;
      const parsed = matchResult.ok ? matchResult.value.parsed : undefined;

      const almacenamientoConsulta =
        parsed?.almacenamiento ?? memory?.almacenamiento ?? null;

      // Todos los modelos nombrados en el mensaje (consultas tipo "el 15 y el 16 pro"),
      // Texto de todos los mensajes del cliente (fallas/modelo de canje pueden
      // haberse dicho hace 2 turnos).
      const textoCliente = [
        ...history.filter((h) => h.role === 'user').map((h) => h.content),
        message,
      ].join('  ·  ');

      // Equipo que ENTREGA el cliente — se resuelve primero para no cotizarlo
      // como si fuera el que quiere comprar. detectTradeIn (sobre el segmento
      // de la frase de permuta) es más confiable que el valor de memoria.
      const tradeIn = detectTradeIn(textoCliente);
      const permutaIntent =
        Boolean(tradeIn) ||
        Boolean(memory?.raw_preferences?.interesado_en_permuta) ||
        hasPermutaIntent(textoCliente);
      // Todos los modelos que el cliente nombró en toda la conversación, en orden.
      const modelosEnTexto = detectModelosMencionados(textoCliente);
      let modeloTomaRaw =
        tradeIn?.modelo ?? memory?.raw_preferences?.modelo_actual ?? null;
      // Red de seguridad: hay intención de permuta pero no se pudo aislar el
      // equipo (typo, frase rara). Si nombró 2+ modelos, el PRIMERO es el que
      // entrega y el resto es lo que quiere comprar.
      if (!modeloTomaRaw && permutaIntent && modelosEnTexto.length >= 2) {
        modeloTomaRaw = modelosEnTexto[0]!;
      }

      // Modelos que el cliente QUIERE (nombrados en el mensaje o en memoria),
      // excluyendo el que entrega en parte de pago.
      const modelosMsg = detectModelosMencionados(message).filter(
        (m) => !modeloTomaRaw || normModelo(m) !== normModelo(modeloTomaRaw),
      );
      const candidatos = modelosMsg.length > 0
        ? modelosMsg
        : [parsed?.modeloNormalizado ?? memory?.producto_interes].filter((x): x is string => !!x);
      const modelosConsulta = candidatos.filter(
        (m) => !modeloTomaRaw || normModelo(m) !== normModelo(modeloTomaRaw),
      );

      // ── Valor de toma del equipo que entrega (se necesita para el presupuesto) ──
      const almToma =
        tradeIn?.almacenamiento ?? memory?.raw_preferences?.almacenamiento_actual ?? null;
      const tomaRow = modeloTomaRaw ? findToma(data, modeloTomaRaw, almToma) : null;

      // Batería del equipo a entregar: <85% ya cuenta como cambio de batería.
      // Un % suelto cuenta como batería si el agente ya la preguntó O si hay
      // un equipo en canje en juego (ahí "de 128 con 81%" = batería).
      const bateriaEnContexto =
        /bater[ií]a/i.test(textoCliente + ' ' + history.map((h) => h.content).join(' ')) ||
        Boolean(tradeIn || modeloTomaRaw);
      const bateriaPct = detectBateriaPct(textoCliente, bateriaEnContexto);
      const fallas = detectFallas(
        `${textoCliente}  ·  ${memory?.raw_preferences?.estado_equipo ?? ''}`,
        bateriaPct,
      );
      const tomaCalc = tomaRow && fallas.length > 0 ? estimarToma(tomaRow, fallas) : null;
      const tomaParaPresupuesto = tomaCalc?.total ?? tomaRow?.impecable ?? 0;

      // Presupuesto (del mensaje o de memoria) para cuando no nombró modelo.
      // El poder de compra real = tope + lo que vale su equipo en parte de pago.
      const budgetMax =
        parsed?.presupuesto?.max ?? memory?.presupuesto_max ?? null;
      const budgetEfectivo = budgetMax ? budgetMax + tomaParaPresupuesto : null;

      let preciosRaw = modelosConsulta.flatMap((mod) =>
        findPrecios(data, mod, modelosConsulta.length > 1 ? null : almacenamientoConsulta),
      );
      // 1 modelo sin GB especificado → cotizar el más barato (128) como
      // referencia; el agente igual pregunta "128 o 256?".
      if (modelosConsulta.length === 1 && !almacenamientoConsulta && preciosRaw.length > 1) {
        preciosRaw = [preciosRaw.reduce((a, b) => (b.preventaARS < a.preventaARS ? b : a))];
      }
      // Sin modelo pedido pero con tope → iPhones que entran, con precios REALES.
      let esListaPorPresupuesto = false;
      if (preciosRaw.length === 0 && budgetEfectivo) {
        preciosRaw = findPreciosEnPresupuesto(data, budgetEfectivo);
        esListaPorPresupuesto = preciosRaw.length > 0;
      }
      // ¿El cliente nombró el modelo EN ESTE turno? Si no (viene de memoria),
      // el agente presenta la opción, no la da por elegida.
      const modeloConfirmado = modelosMsg.length >= 1;
      // Dedup por modelo+almacenamiento
      const vistos = new Set<string>();
      const precios = preciosRaw
        .filter((p) => {
          const k = `${p.modelo}|${p.almacenamiento}`;
          if (vistos.has(k)) return false;
          vistos.add(k);
          return true;
        })
        .map((p) => ({
            modelo: p.modelo,
            almacenamiento: p.almacenamiento,
            precioARS: p.precioARS,
            preventaARS: p.preventaARS,
            precioUSD: p.precioUSD,
            cuotasContado: calcularCuotas(p.precioARS, data.cuotasCoef).map((c) => ({
              cuotas: c.cuotas,
              porCuota: c.porCuota,
            })),
            cuotasPreventa: calcularCuotas(p.preventaARS, data.cuotasCoef).map((c) => ({
              cuotas: c.cuotas,
              porCuota: c.porCuota,
            })),
        }));

      if (precios.length > 0 || tomaRow) {
        livePricing = {
          precios,
          toma: tomaRow
            ? {
                modelo: tomaRow.modelo,
                impecable: tomaRow.impecable,
                deducciones: {
                  batería: tomaRow.bateria,
                  pantalla: tomaRow.pantalla,
                  cámara: tomaRow.camara,
                  micrófono: tomaRow.microfono,
                  parlante: tomaRow.parlante,
                  'tapa trasera': tomaRow.tapa,
                  marco: tomaRow.marco,
                  'pin de carga': tomaRow.pin,
                },
                calculada: tomaCalc
                  ? {
                      fallasDetectadas: fallas.map(String),
                      deducciones: tomaCalc.deducciones,
                      total: tomaCalc.total,
                    }
                  : null,
              }
            : null,
          edadMinutos: Math.round((Date.now() - data.fetchedAt) / 60_000),
          promoVigenteHasta: data.promoAplicadaA.length > 0 ? data.promoVigenteHasta : null,
          esListaPorPresupuesto,
          poderDeCompra: budgetEfectivo,
          modeloConfirmado,
        };
      }
    }
  }

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
    livePricing,
  };

  // ─── Paso 9: Llamar al LLM (proveedor según LLM_PROVIDER) ────────────────
  // Interés estimado (antes de la respuesta): score guardado vs evaluación del turno.
  const interestScore = Math.max(lead.lead_score, assessment.newScore);
  // 'web' = API directa / simulador (sin esperas largas). Otros = WhatsApp/IG por Kommo.
  const llmOpts = { interestScore, patient: channel !== 'web' };

  const llmResult = await generateAgentResponse(context, llmOpts);
  if (!llmResult.ok) return err(llmResult.error);

  let agentResponse = llmResult.value;

  // ─── Modo B: el agente decide no responder — un humano sigue ─────────────
  if (agentResponse.pasar_a_humano) {
    agentResponse = {
      ...agentResponse,
      respuesta: '',
      fragmentos: null,
      requiere_humano: true,
      accion_venta: 'derivacion_humano',
    };
  }

  // ─── Paso 10: Language guard (se saltea si no hay respuesta) ─────────────
  const guardResult = agentResponse.respuesta.trim()
    ? checkLanguage(agentResponse.respuesta, rules.prohibited_phrases)
    : { passed: true as const, violations: [] as string[] };

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

    // El reintento por lenguaje no espera largo a Gemini (ya hay una respuesta).
    const retryResult = await generateAgentResponse(retryContext, { ...llmOpts, patient: false });
    if (retryResult.ok) {
      const retryGuard = checkLanguage(retryResult.value.respuesta, rules.prohibited_phrases);
      if (retryGuard.passed) {
        agentResponse = retryResult.value;
      } else {
        // Doble fallo — usar respuesta original, loguear
        console.error('[language-guard] Doble fallo en regeneración:', retryGuard.violations);
      }
    }
  }

  // Re-normalizar modo B por si el reintento lo activó
  if (agentResponse.pasar_a_humano) {
    agentResponse = {
      ...agentResponse,
      respuesta: '',
      fragmentos: null,
      requiere_humano: true,
      accion_venta: 'derivacion_humano',
    };
  }

  // ─── Paso 11: Merge de scoring (backend como autoridad) ──────────────────
  //
  // Claude calcula score y estado desde el contexto conversacional.
  // Nuestro backend (`assessLead`) los calcula de forma determinista desde señales.
  // Regla de merge: usar la señal más fuerte para evitar que el agente
  // subestime el avance del lead.
  // El backend (assessLead, determinista) manda. Claude puede empujar el score
  // un poco por encima si lee intención que las keywords no captan, pero nunca
  // más de +8 sobre la evaluación determinista — así "subir cuesta".
  const mergedScore = Math.min(
    Math.max(agentResponse.lead_score, assessment.newScore),
    assessment.newScore + 8,
  );

  // Estado propuesto por score + Claude, PERO con techo según el score real
  // (salvo compra explícita, que assessLead ya salta a LISTO por keyword).
  const estadoPropuesto = advanceEstado(agentResponse.estado, assessment.suggestedEstado);
  const compraExplicita = assessment.suggestedEstado === 'LISTO_PARA_COMPRAR';
  const techoScore: LeadEstado =
    mergedScore >= 86 ? 'LISTO_PARA_COMPRAR'
    : mergedScore >= 66 ? 'MUY_INTERESADO'
    : mergedScore >= 40 ? 'INTERESADO'
    : mergedScore >= 8 ? 'CONSULTA'
    : 'NEW';
  const acotado = compraExplicita
    ? estadoPropuesto
    : leastAdvanced(estadoPropuesto, techoScore);
  const mergedEstado = advanceEstado(acotado, lead.estado); // nunca retroceder
  const mergedRequiereHumano = agentResponse.requiere_humano || assessment.requiresHuman;

  const finalResponse: AgentResponse = {
    ...agentResponse,
    lead_score: mergedScore,
    estado: mergedEstado,
    requiere_humano: mergedRequiereHumano,
  };

  // ─── Guardia de montos: el modelo a veces corrompe un dígito de un precio ─
  // ya calculado. Reemplaza montos que estén cerca (±3%) de un valor canónico
  // por el valor exacto. No inventa: solo corrige un número casi-correcto.
  if (livePricing) {
    const canon = new Set<number>();
    const add = (n: number): void => { if (n > 0) canon.add(Math.round(n)); };
    const tomaTotal = livePricing.toma?.calculada?.total ?? livePricing.toma?.impecable ?? 0;
    if (tomaTotal) add(tomaTotal);
    for (const p of livePricing.precios) {
      add(p.precioARS); add(p.preventaARS);
      if (tomaTotal) { add(p.precioARS - tomaTotal); add(p.preventaARS - tomaTotal); }
      for (const c of [...p.cuotasContado, ...p.cuotasPreventa]) add(c.porCuota);
    }
    const canonArr = [...canon];
    const snap = (txt: string): string =>
      txt.replace(/\$\s?([\d][\d.]*\d)/g, (m, digits: string) => {
        const val = Number(digits.replace(/\./g, ''));
        if (!Number.isFinite(val) || val < 10_000) return m;
        const cerca = canonArr.filter((c) => Math.abs(c - val) / c <= 0.015);
        if (cerca.length === 1 && cerca[0] !== val) {
          return formatPrice(cerca[0]!);
        }
        return m;
      });
    finalResponse.respuesta = snap(finalResponse.respuesta);
    if (finalResponse.fragmentos) {
      finalResponse.fragmentos = finalResponse.fragmentos.map(snap);
    }

    // ── Guardia anti-invención: en un flujo de canje con valor calculado, todos
    // los montos "grandes" ($200k+) tienen que coincidir con un valor canónico.
    // Si aparece uno inventado (ej: "$380.000" cuando la toma es $705.000) →
    // callarse (Modo B) en vez de mandar un número falso.
    if (livePricing.toma?.calculada && canonArr.length > 0 && !finalResponse.pasar_a_humano) {
      const textos = [finalResponse.respuesta, ...(finalResponse.fragmentos ?? [])].join(' ');
      const montos = [...textos.matchAll(/\$\s?([\d][\d.]*\d)/g)]
        .map((mm) => Number(mm[1]!.replace(/\./g, '')))
        .filter((v) => Number.isFinite(v) && v >= 200_000);
      const inventado = montos.find(
        (v) => !canonArr.some((c) => Math.abs(c - v) / c <= 0.03),
      );
      if (inventado !== undefined) {
        console.error(
          `[anti-invención] monto sin respaldo ($${inventado}) en flujo de canje — Modo B. ` +
          `canon: ${canonArr.join(', ')}`,
        );
        finalResponse.respuesta = '';
        finalResponse.fragmentos = null;
        finalResponse.pasar_a_humano = true;
        finalResponse.requiere_humano = true;
        finalResponse.accion_venta = 'derivacion_humano';
      }
    }
  }

  // ─── Fragmentación: nunca un solo mensaje largo (parece bot) ─────────────
  if (!finalResponse.pasar_a_humano && finalResponse.respuesta.trim()) {
    const frags = fragmentar(finalResponse.respuesta, finalResponse.fragmentos);
    if (frags.length >= 2) {
      finalResponse.fragmentos = frags;
      finalResponse.respuesta = frags.join('\n\n');
    }
  }

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

  // Mensaje del asistente — o nota interna si el agente se calló (modo B)
  await appendMessage({
    lead_id: lead.id,
    role: 'assistant',
    content: finalResponse.pasar_a_humano
      ? '[SIN RESPUESTA AUTOMÁTICA — derivado a un asesor humano]'
      : finalResponse.respuesta,
    metadata: {
      intencion: finalResponse.intencion,
      accion_venta: finalResponse.accion_venta,
      estado_en_momento: finalResponse.estado,
      lead_score_en_momento: finalResponse.lead_score,
      ...(finalResponse.pasar_a_humano && { sin_respuesta: true }),
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
