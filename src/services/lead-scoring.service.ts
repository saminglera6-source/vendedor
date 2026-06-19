/**
 * Servicio de lead scoring y evaluación de estado comercial.
 *
 * Responsabilidades:
 * - Detectar eventos de scoring en texto libre
 * - Calcular el nuevo score aplicando los deltas del CLAUDE.md
 * - Sugerir el estado del lead según score + señales contextuales
 * - Detectar compradores calientes (hot buyers)
 * - Detectar oportunidades perdidas
 * - Detectar necesidad de escalación a humano
 *
 * Todas las funciones son puras (sin IO) excepto donde se indica.
 * La persistencia se hace en leads.ts — este servicio solo computa.
 */

import {
  LEAD_SCORE_DELTA,
  LEAD_ESTADO,
  ESTADOS_ACTIVOS,
  clampScore,
  type Lead,
  type LeadEstado,
  type LeadScoringEvent,
  type BusinessRulesMap,
} from '../types.js';
import { normalizeText } from './product-matching.service.js';

// ===========================================================================
// Diccionario de keywords por evento
// ===========================================================================

/**
 * Mapa de evento → array de keywords que lo activan.
 * El matching es case-insensitive sobre texto normalizado.
 * Las keywords más específicas deben estar primero para evitar falsos positivos.
 */
const SCORING_KEYWORDS: Readonly<Partial<Record<LeadScoringEvent, string[]>>> =
  {
    pide_link_pago: [
      'link de pago',
      'como pago',
      'cómo pago',
      'link para pagar',
      'mercado pago',
      'mercadopago',
      ' mp ',
      'transferencia',
      'efectivo',
      'como compro',
      'cómo compro',
      // Señales de pago específicas de GreatPhones
      'pasame el alias',
      'pasame alias',
      'el alias',
      'te transfiero',
      'ya te mando',
      'te hago la transferencia',
    ],

    dice_lo_quiero: [
      'lo quiero',
      'me lo llevo',
      'lo llevo',
      'lo reservo',
      'reservame',
      'lo tomo',
      'lo compro',
      'cerramos',
      'dale cerramos',
      'lo cerramos',
      // Señales de cierre explícitas
      'quiero cerrar',
      'quiero comprar',
      'quiero reservar',
      'lo cierro',
      'coordinemos',
      // Señales de seña (depósito para reservar)
      'quiero senarlo',
      'quiero señarlo',
      'puedo señar',
      'puedo senar',
      'dejo una sena',
      'dejo una seña',
      'puedo dejar una sena',
      'puedo dejar una seña',
      'lo seno',
      'lo señalo',
    ],

    pregunta_cuotas: [
      'cuotas',
      'cuota',
      'sin interes',
      'sin interés',
      'ahora 12',
      'ahora 6',
      'financiar',
      'financiacion',
      'financiación',
      'mensual',
      'en cuotas',
    ],

    pregunta_precio: [
      'cuanto sale',
      'cuánto sale',
      'cuanto vale',
      'cuánto vale',
      'a cuanto',
      'a cuánto',
      'cuanto es',
      'cuánto es',
      'cuanto cuesta',
      'cuánto cuesta',
      'el precio',
      'que precio',
      'qué precio',
      'sale?',
      'vale?',
    ],

    pregunta_disponibilidad: [
      'tenes el',
      'tenés el',
      'tienen el',
      'lo tenes',
      'lo tenés',
      'hay ',
      'disponible',
      'en stock',
      'en mano',
      'lo tienen',
      'lo tienen disponible',
      'me interesa',
    ],

    pregunta_envio: [
      'envio',
      'envío',
      'envian',
      'envían',
      'mandan',
      'mandas',
      'mandás',
      'hacen envio',
      'hacen envío',
      'entrega',
      'retiro',
      'retiras',
      'retirás',
      'a domicilio',
      // Señales de retiro/entrega en Bahía Blanca
      'cuando entregan',
      'cuándo entregan',
      'cuando lo entregan',
      'lo paso a buscar',
      'donde estan',
      'dónde están',
      'donde quedan',
      'cuanto tardan',
      'cuánto tardan',
    ],

    pregunta_specs: [
      'camara',
      'cámara',
      'bateria',
      'batería',
      'pantalla',
      'procesador',
      'ram ',
      'memoria ram',
      'velocidad',
      'foto ',
      'fotos',
      'video',
      'zoom',
      'carga rapida',
      'carga rápida',
      'autonomia',
      'autonomía',
    ],

    pregunta_garantia: [
      'garantia',
      'garantía',
      'garantia oficial',
      'garantía oficial',
      'factura',
      'original',
      'sellado',
      'caja original',
    ],

    comparacion_modelos: [
      ' o el ',
      ' vs ',
      'diferencia entre',
      'cual es mejor',
      'cuál es mejor',
      'mejor entre',
      'comparo',
      'comparando',
    ],

    menciona_presupuesto: [
      'presupuesto',
      'hasta ',
      'no paso de',
      'tengo ',
      'lucas',
      ' mil ',
      'guita',
      'plata',
    ],

    menciona_permuta: [
      // Señales directas de tenencia de iPhone para permutar
      'tengo un iphone',
      'tengo una iphone',
      'entrego mi iphone',
      'entrego el iphone',
      'tomo en parte de pago',
      'recibis mi iphone',
      'recibís mi iphone',
      // Por modelo específico (iPhone 11 en adelante — modelos aceptados)
      'tengo un 11',
      'tengo un 12',
      'tengo un 13',
      'tengo un 14',
      'tengo un 15',
      'tengo un 16',
      'tengo un pro max',
      'tengo una pro max',
      // Intención de entrega / parte de pago
      'doy a cuenta',
      'entrego como parte de pago',
      'lo cambio por',
      'cambio mi',
      'cuanto me toman',
      'cuánto me toman',
      'me toman el mio',
      'me toman el mío',
      'toman en permuta',
      'hacen permuta',
      'toman iphone',
    ],

    menciona_fecha_compra: [
      'para el viernes',
      'para el sabado',
      'para el domingo',
      'para el lunes',
      'esta semana',
      'semana que viene',
      'mañana',
      'hoy mismo',
      'urgente',
      'ya mismo',
      'lo necesito para',
      'para el cumple',
      'dia de la madre',
      'navidad',
      'para el mes',
      'este fin de semana',
    ],

    producto_para_regalo: [
      'de regalo',
      'para regalar',
      'para regalarle',
      'es un regalo',
      'para mi',
      'para mi hija',
      'para mi hijo',
      'para mi mama',
      'para mi papá',
      'para mi papa',
      'para mi novio',
      'para mi novia',
      'cumpleaños',
    ],

    da_ciudad_direccion: [
      // Ciudad base de GreatPhones — señal fuerte de intención local
      'bahia blanca',
      'bahía blanca',
      'de bahia',
      // Otras ciudades
      'de buenos aires',
      'de caba',
      'de cordoba',
      'de córdoba',
      'de rosario',
      'de mendoza',
      'de tucuman',
      'de tucumán',
      'de la plata',
      'de mar del plata',
      'de salta',
      'de santa fe',
      'calle ',
      'barrio ',
      'mi direccion',
      'mi dirección',
      'codigo postal',
      'código postal',
    ],

    rechazo_fuerte: [
      'no me interesa',
      'ya lo compre',
      'ya lo compré',
      'consegui en otro lado',
      'conseguí en otro lado',
      'lo compre en',
      'lo compré en',
      'no lo necesito',
      'no gracias',
      'gracias pero no',
      'no estoy interesado',
    ],

    rechazo_moderado: [
      'muy caro',
      'está caro',
      'esta caro',
      'es mucho',
      'no me convence',
      'no se',
      'no sé',
      'me parece caro',
    ],

    rechazo_suave: [
      'lo pienso',
      'despues te digo',
      'después te digo',
      'mas adelante',
      'más adelante',
      'lo consulto',
      'lo hablo',
      'vemos',
      'ya te aviso',
    ],
  };

// ===========================================================================
// Tipos públicos
// ===========================================================================

export interface ScoreResult {
  newScore: number;
  delta: number;
  appliedEvents: LeadScoringEvent[];
}

export interface LeadAssessment {
  events: LeadScoringEvent[];
  newScore: number;
  scoreDelta: number;
  suggestedEstado: LeadEstado;
  isHotBuyer: boolean;
  requiresHuman: boolean;
  /** El lead fue marcado como perdido en esta evaluación */
  isLost: boolean;
}

// ===========================================================================
// Detección de eventos
// ===========================================================================

/**
 * Detecta qué eventos de scoring ocurrieron en un mensaje del cliente.
 * Retorna un Set (sin duplicados) de eventos activos.
 *
 * No detecta: `primer_contacto`, `responde_followup`, `sin_respuesta_24h`
 * — esos dependen de contexto externo al texto.
 */
export function detectEventsFromMessage(message: string): LeadScoringEvent[] {
  const normalized = normalizeText(message);
  const active = new Set<LeadScoringEvent>();

  // Rechazo fuerte tiene precedencia — si está presente, ignorar señales positivas
  const hasStrongRejection = matchesAny(
    normalized,
    SCORING_KEYWORDS.rechazo_fuerte ?? [],
  );

  if (hasStrongRejection) {
    active.add('rechazo_fuerte');
    return [...active];
  }

  for (const [event, keywords] of Object.entries(SCORING_KEYWORDS) as Array<
    [LeadScoringEvent, string[]]
  >) {
    if (matchesAny(normalized, keywords)) {
      active.add(event);
    }
  }

  // Detectar presupuesto también si hay símbolo $ o número seguido de "lucas/mil/k"
  if (/\$\d|(\d{3,})\s*(pesos|lucas|mil\b)/i.test(message)) {
    active.add('menciona_presupuesto');
  }

  return [...active];
}

/** Retorna true si el texto contiene alguna de las keywords */
function matchesAny(normalizedText: string, keywords: string[]): boolean {
  return keywords.some((kw) => normalizedText.includes(kw));
}

// ===========================================================================
// Cálculo de score
// ===========================================================================

/**
 * Aplica eventos de scoring al score actual y retorna el resultado.
 * El score final siempre queda clampeado en [0, 100].
 */
export function applyEvents(
  currentScore: number,
  events: LeadScoringEvent[],
): ScoreResult {
  let delta = 0;

  for (const event of events) {
    delta += LEAD_SCORE_DELTA[event];
  }

  const newScore = clampScore(currentScore + delta);

  return {
    newScore,
    delta: newScore - currentScore, // delta real (ajustado por clamp)
    appliedEvents: events,
  };
}

// ===========================================================================
// Sugerencia de estado
// ===========================================================================

/**
 * Sugiere el estado del lead basado en el score y señales del mensaje.
 *
 * El agente tiene la última palabra — esta función da una sugerencia.
 * Las transiciones siempre son "hacia adelante" (no regresivas)
 * excepto para PERDIDO.
 */
export function suggestEstado(
  score: number,
  currentEstado: LeadEstado,
  message: string,
): LeadEstado {
  const normalized = normalizeText(message);

  // Señales de compra explícita → LISTO_PARA_COMPRAR directamente
  const buySignals = SCORING_KEYWORDS.pide_link_pago ?? [];
  const wantSignals = SCORING_KEYWORDS.dice_lo_quiero ?? [];
  if (matchesAny(normalized, [...buySignals, ...wantSignals])) {
    return LEAD_ESTADO.LISTO_PARA_COMPRAR;
  }

  // Rechazo fuerte → PERDIDO
  if (matchesAny(normalized, SCORING_KEYWORDS.rechazo_fuerte ?? [])) {
    return LEAD_ESTADO.PERDIDO;
  }

  // Si el lead ya es CLIENTE o PERDIDO, no cambiar por score
  if (
    currentEstado === LEAD_ESTADO.CLIENTE ||
    currentEstado === LEAD_ESTADO.PERDIDO
  ) {
    return currentEstado;
  }

  // Estado sugerido por score
  let suggestedByScore: LeadEstado;
  if (score >= 86) {
    suggestedByScore = LEAD_ESTADO.LISTO_PARA_COMPRAR;
  } else if (score >= 66) {
    suggestedByScore = LEAD_ESTADO.MUY_INTERESADO;
  } else if (score >= 46) {
    suggestedByScore = LEAD_ESTADO.INTERESADO;
  } else if (score >= 5) {
    suggestedByScore = LEAD_ESTADO.CONSULTA;
  } else {
    suggestedByScore = LEAD_ESTADO.NEW;
  }

  // No retroceder: si el lead ya está en MUY_INTERESADO, no volver a INTERESADO
  const estadoOrder: LeadEstado[] = [
    LEAD_ESTADO.NEW,
    LEAD_ESTADO.CONSULTA,
    LEAD_ESTADO.INTERESADO,
    LEAD_ESTADO.MUY_INTERESADO,
    LEAD_ESTADO.LISTO_PARA_COMPRAR,
    LEAD_ESTADO.CLIENTE,
  ];

  const currentIndex = estadoOrder.indexOf(currentEstado);
  const suggestedIndex = estadoOrder.indexOf(suggestedByScore);

  return suggestedIndex > currentIndex ? suggestedByScore : currentEstado;
}

// ===========================================================================
// Detección de comprador caliente
// ===========================================================================

/**
 * Retorna true si el lead muestra señales de comprador caliente.
 *
 * Un hot buyer es alguien que puede cerrar en esta sesión o en las
 * próximas horas. El agente debe proponer cierre inmediatamente.
 */
export function detectHotBuyer(
  message: string,
  score: number,
  estado: LeadEstado,
): boolean {
  // Score muy alto + estado avanzado
  if (score >= 75 && (estado === LEAD_ESTADO.MUY_INTERESADO || estado === LEAD_ESTADO.LISTO_PARA_COMPRAR)) {
    return true;
  }

  const normalized = normalizeText(message);

  // Señales explícitas de compra inmediata
  const urgencySignals = [
    ...(SCORING_KEYWORDS.pide_link_pago ?? []),
    ...(SCORING_KEYWORDS.dice_lo_quiero ?? []),
    ...(SCORING_KEYWORDS.menciona_fecha_compra ?? []).filter((k) =>
      ['hoy', 'mañana', 'urgente', 'ya mismo'].includes(k),
    ),
  ];

  return matchesAny(normalized, urgencySignals);
}

// ===========================================================================
// Detección de oportunidad perdida
// ===========================================================================

/**
 * Evalúa si un lead debe considerarse perdido basándose en:
 * - Horas sin respuesta vs umbrales de business_rules
 * - Estado actual
 *
 * @param hoursSinceLastContact - Horas desde last_contact del lead
 */
export function detectLostOpportunity(
  lead: Pick<Lead, 'estado' | 'lead_score'>,
  hoursSinceLastContact: number,
  rules: Pick<BusinessRulesMap, 'max_no_response_hours'>,
): { isLost: boolean; needsFollowup: boolean } {
  // Los clientes y los ya-perdidos no se evalúan
  if (
    lead.estado === LEAD_ESTADO.CLIENTE ||
    lead.estado === LEAD_ESTADO.PERDIDO
  ) {
    return { isLost: false, needsFollowup: false };
  }

  const { warning, lost } = rules.max_no_response_hours;

  if (hoursSinceLastContact >= lost) {
    return { isLost: true, needsFollowup: false };
  }

  if (hoursSinceLastContact >= warning && lead.lead_score > 20) {
    return { isLost: false, needsFollowup: true };
  }

  return { isLost: false, needsFollowup: false };
}

// ===========================================================================
// Detección de escalación
// ===========================================================================

/**
 * Retorna true si el lead debe escalarse a un humano.
 *
 * Criterios:
 * - Score >= umbral configurado en business_rules
 * - Mensaje contiene keyword de escalación
 * - Rechazo activo + score alto (puede recuperarse con humano)
 */
export function detectEscalation(
  message: string,
  score: number,
  rules: Pick<BusinessRulesMap, 'escalation_threshold'>,
): boolean {
  const { lead_score: scoreThreshold, keywords } = rules.escalation_threshold;

  if (score >= scoreThreshold) return true;

  const normalized = normalizeText(message);
  return keywords.some((kw) => normalized.includes(normalizeText(kw)));
}

// ===========================================================================
// Evaluación completa del lead en un turno
// ===========================================================================

/**
 * Función de alto nivel que consolida toda la evaluación del agente
 * para un turno de conversación.
 *
 * Combina: detección de eventos + score + estado + hot buyer + escalación.
 * El resultado alimenta directamente los campos de AgentResponse.
 */
export function assessLead(
  message: string,
  lead: Pick<Lead, 'lead_score' | 'estado'>,
  rules: Pick<BusinessRulesMap, 'escalation_threshold' | 'max_no_response_hours'>,
  hoursSinceLastContact = 0,
): LeadAssessment {
  const events = detectEventsFromMessage(message);

  // Agregar primer_contacto si el lead es nuevo
  if (lead.estado === LEAD_ESTADO.NEW) {
    events.unshift('primer_contacto');
  }

  const { newScore, delta } = applyEvents(lead.lead_score, events);
  const suggestedEstado = suggestEstado(newScore, lead.estado, message);
  const isHotBuyer = detectHotBuyer(message, newScore, suggestedEstado);
  const requiresHuman = detectEscalation(message, newScore, rules);
  const { isLost } = detectLostOpportunity(
    { ...lead, lead_score: newScore, estado: suggestedEstado },
    hoursSinceLastContact,
    rules,
  );

  return {
    events,
    newScore,
    scoreDelta: delta,
    suggestedEstado: isLost ? LEAD_ESTADO.PERDIDO : suggestedEstado,
    isHotBuyer,
    requiresHuman,
    isLost,
  };
}
