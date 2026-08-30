/**
 * Tipos de dominio de vendedor-ia.
 *
 * Este archivo define el vocabulario de la aplicación: enums, interfaces
 * de negocio, tipos del agente y estructuras de configuración. Es la fuente
 * de verdad de los tipos que circulan por encima de la capa de base de datos.
 *
 * Los tipos de fila de DB están en src/db/schema.ts.
 * Los tipos de dominio aquí son la versión "aplicación" de esas filas.
 */

import type {
  CustomerMemoryRow,
  FollowupRow,
  KnowledgeChunkRow,
  LeadRow,
  ProductRow,
  ProductVariantRow,
} from './db/schema.js';

// ===========================================================================
// Enums — derivados de los ENUMs de PostgreSQL en 001_initial.sql
// ===========================================================================

/** Estados posibles de un lead, en orden de avance comercial */
export type LeadEstado =
  | 'NEW'
  | 'CONSULTA'
  | 'INTERESADO'
  | 'MUY_INTERESADO'
  | 'LISTO_PARA_COMPRAR'
  | 'CLIENTE'
  | 'PERDIDO';

/** Constantes de LeadEstado para comparaciones programáticas sin magic strings */
export const LEAD_ESTADO = {
  NEW: 'NEW',
  CONSULTA: 'CONSULTA',
  INTERESADO: 'INTERESADO',
  MUY_INTERESADO: 'MUY_INTERESADO',
  LISTO_PARA_COMPRAR: 'LISTO_PARA_COMPRAR',
  CLIENTE: 'CLIENTE',
  PERDIDO: 'PERDIDO',
} as const satisfies Record<LeadEstado, LeadEstado>;

/** Estados "activos" — no terminales, el agente sigue trabajando */
export const ESTADOS_ACTIVOS: readonly LeadEstado[] = [
  LEAD_ESTADO.NEW,
  LEAD_ESTADO.CONSULTA,
  LEAD_ESTADO.INTERESADO,
  LEAD_ESTADO.MUY_INTERESADO,
  LEAD_ESTADO.LISTO_PARA_COMPRAR,
] as const;

export type AvailabilityStatus = 'AVAILABLE' | 'NO_DISPONIBLE';

export const AVAILABILITY_STATUS = {
  AVAILABLE: 'AVAILABLE',
  NO_DISPONIBLE: 'NO_DISPONIBLE',
} as const satisfies Record<AvailabilityStatus, AvailabilityStatus>;

// ===========================================================================
// Tipos de dominio de producto
// Excluyen supply_notes — ese campo nunca circula fuera de db/products.ts
// ===========================================================================

/** Producto sin variante. Referencia del catálogo. */
export type Product = Omit<ProductRow, 'created_at' | 'updated_at'>;

/**
 * Variante de producto segura para exponer al agente.
 * supply_notes está intencionalmente excluido.
 */
export type ProductVariantPublic = Omit<
  ProductVariantRow,
  'supply_notes' | 'created_at' | 'updated_at'
>;

/** Variante con el nombre del producto denormalizado — para respuestas al cliente */
export interface ProductVariantWithProduct extends ProductVariantPublic {
  product: Pick<ProductRow, 'marca' | 'modelo' | 'categoria' | 'descripcion'>;
}

// ===========================================================================
// Tipos de dominio de lead
// ===========================================================================

export type Lead = LeadRow;

export type LeadChannel = 'whatsapp' | 'web';

// ===========================================================================
// Memoria comercial
// ===========================================================================

/** Preferencias no estructuradas capturadas de la conversación */
export interface CustomerRawPreferences {
  ciudad?: string;
  uso_principal?: 'fotos' | 'gaming' | 'trabajo' | 'redes' | 'general';
  es_regalo?: boolean;
  para_quien?: string;
  operador_preferido?: string;
  // Permuta — detectados cuando el cliente menciona un equipo para entregar
  interesado_en_permuta?: boolean;
  modelo_actual?: string;       // iPhone que el cliente tiene para permutar
  almacenamiento_actual?: string;
  estado_equipo?: string;       // 'buen estado' | 'con detalles' | 'con falla'
  [key: string]: unknown;
}

/**
 * customer_memory con raw_preferences tipado.
 * Se usa dentro de la aplicación en lugar del tipo de DB crudo.
 */
export interface CustomerMemory
  extends Omit<CustomerMemoryRow, 'raw_preferences'> {
  raw_preferences: CustomerRawPreferences;
}

/** Campos que el agente puede detectar y actualizar en una sola interacción */
export type CustomerMemoryPatch = Partial<
  Pick<
    CustomerMemory,
    | 'producto_interes'
    | 'color_preferido'
    | 'almacenamiento'
    | 'presupuesto_min'
    | 'presupuesto_max'
    | 'fecha_estimada_compra'
    | 'resumen_comercial'
    | 'raw_preferences'
  >
>;

// ===========================================================================
// Metadata de conversación (columna JSONB en conversations)
// ===========================================================================

export interface ConversationMetadata {
  intencion?: Intencion;
  accion_venta?: AccionVenta;
  /** ID de la variante de producto consultada en este mensaje */
  variant_id?: string;
  estado_en_momento?: LeadEstado;
  lead_score_en_momento?: number;
}

// ===========================================================================
// Tipos del agente
// ===========================================================================

/**
 * Intención detectada en el mensaje del cliente.
 * Define el "qué quiere" del cliente en este mensaje.
 */
export type Intencion =
  | 'consulta'       // pregunta informativa general
  | 'disponibilidad' // pregunta si hay disponibilidad
  | 'precio'         // pregunta cuánto cuesta
  | 'comparacion'    // compara dos o más modelos
  | 'compra'         // quiere comprar / pide cerrar
  | 'objecion'       // pone una objeción (precio, tiempo, etc.)
  | 'queja'          // frustración o problema
  | 'saludo'         // primer mensaje o saludo sin más info
  | 'otro';

/**
 * Acción tomada por el agente para avanzar hacia la visita o la venta.
 * 'visita_propuesta' es la acción prioritaria: el agente propuso que el cliente venga al local.
 * 'solo_respondio' es señal de alerta: respuesta pasiva sin proponer ningún paso siguiente.
 */
export type AccionVenta =
  | 'pregunta_variante'    // preguntó color/almacenamiento para cualificar
  | 'pregunta_ciudad'      // preguntó ciudad para coordinar envío
  | 'pregunta_presupuesto' // preguntó por presupuesto
  | 'pregunta_uso'         // preguntó uso principal para recomendar
  | 'precio_dado'          // informó precio y avanzó
  | 'disponibilidad_dada'  // informó disponibilidad y avanzó
  | 'alternativa_ofrecida' // producto no disponible, ofreció otro
  | 'objecion_resuelta'    // manejó una objeción y avanzó
  | 'visita_propuesta'     // propuso que el cliente visite el local (acción prioritaria)
  | 'cierre_propuesto'     // propuso cerrar (link, reserva) — solo ante intención explícita
  | 'seguimiento_creado'   // programó un followup activo
  | 'derivacion_humano'    // derivó al equipo humano
  | 'solo_respondio';      // respondió sin avanzar (evitar en producción)

/** Especificación de un followup a crear después de este mensaje */
export interface FollowupSpec {
  tipo: FollowupRow['tipo'];
  /** Horas desde ahora para programar el followup */
  delay_hours: number;
  /** Contexto para que el cron genere el mensaje personalizado */
  mensaje_base: string;
}

/**
 * Respuesta estructurada del agente.
 * Siempre devuelta vía tool_use de Claude — nunca texto libre parseado.
 */
export interface AgentResponse {
  /** Mensaje final para enviar al cliente (texto completo, usado para logging y clientes legacy) */
  respuesta: string;
  /**
   * Fragmentos individuales para enviar como mensajes separados en WhatsApp.
   * null → enviar `respuesta` como un único mensaje.
   * Array de 2-3 strings → enviar cada elemento como mensaje separado con delay entre ellos.
   * Si no es null, respuesta === fragmentos.join('\n\n').
   */
  fragmentos: string[] | null;
  /** Score 0–100 del lead después de procesar este mensaje */
  lead_score: number;
  /** Nuevo estado calculado para el lead */
  estado: LeadEstado;
  /** Intención detectada en el mensaje del cliente */
  intencion: Intencion;
  /** Qué hizo el agente para avanzar la venta en esta respuesta */
  accion_venta: AccionVenta;
  /** true → escalar inmediatamente al equipo humano */
  requiere_humano: boolean;
  /**
   * true → NO enviar ninguna respuesta al cliente; un asesor humano continúa.
   * Se usa cuando el agente no puede responder bien (técnico fuera de alcance,
   * reclamo, garantía de equipo ya comprado, acusación). respuesta queda vacía.
   */
  pasar_a_humano: boolean;
  /** Followup a programar, o null si no corresponde */
  followup: FollowupSpec | null;
  /**
   * Datos reales que faltaron para responder correctamente.
   * Si no es null, la respuesta debe informar al cliente sin inventar datos.
   * Ej: ['precio', 'stock'] — se consulta la variante y no estaba en la BD.
   */
  data_faltante: string[] | null;
  /** Campos de customer_memory actualizados en este turno */
  memory_update: CustomerMemoryPatch | null;
}

// ===========================================================================
// Lead scoring
// ===========================================================================

/**
 * Eventos que modifican el lead_score.
 * Los valores positivos/negativos están documentados en CLAUDE.md §9.
 */
export type LeadScoringEvent =
  | 'primer_contacto'
  | 'pregunta_disponibilidad'
  | 'pregunta_precio'
  | 'pregunta_specs'
  | 'comparacion_modelos'
  | 'pregunta_envio'
  | 'pregunta_garantia'
  | 'menciona_presupuesto'
  | 'menciona_fecha_compra'
  | 'producto_para_regalo'
  | 'pregunta_cuotas'
  | 'da_ciudad_direccion'
  | 'menciona_permuta'
  | 'pide_link_pago'
  | 'dice_lo_quiero'
  | 'responde_followup'
  | 'rechazo_suave'
  | 'rechazo_moderado'
  | 'rechazo_fuerte'
  | 'sin_respuesta_24h';

/**
 * Mapa de evento → delta de puntos.
 *
 * Escala deliberadamente CONSERVADORA: subir en el score tiene que costar.
 * Las señales de interés (precio, disponibilidad, permuta, specs) suman poco;
 * solo una intención de compra explícita y repetida lleva el score arriba.
 * Un solo mensaje no debe pasar de ~15-20 puntos por más señales que traiga.
 */
export const LEAD_SCORE_DELTA: Record<LeadScoringEvent, number> = {
  primer_contacto: 2,
  pregunta_disponibilidad: 4,
  pregunta_precio: 6,
  pregunta_specs: 3,
  comparacion_modelos: 6,
  pregunta_envio: 4,
  pregunta_garantia: 3,
  menciona_presupuesto: 8,
  menciona_fecha_compra: 8,
  producto_para_regalo: 5,
  pregunta_cuotas: 6,
  da_ciudad_direccion: 6,
  menciona_permuta: 7,
  pide_link_pago: 22,
  dice_lo_quiero: 18,
  responde_followup: 6,
  rechazo_suave: -8,
  rechazo_moderado: -18,
  rechazo_fuerte: -25,
  sin_respuesta_24h: -6,
} as const;

/** Tope de puntos que un solo mensaje puede sumar (antes de aplicar clamp global). */
export const MAX_SCORE_GAIN_PER_MESSAGE = 20;

/** Rangos de score → estado esperado (referencia para el agente) */
export const LEAD_SCORE_RANGES: Array<{
  min: number;
  max: number;
  estado: LeadEstado;
}> = [
  { min: 0, max: 20, estado: LEAD_ESTADO.CONSULTA },
  { min: 21, max: 45, estado: LEAD_ESTADO.INTERESADO },
  { min: 46, max: 65, estado: LEAD_ESTADO.INTERESADO },
  { min: 66, max: 85, estado: LEAD_ESTADO.MUY_INTERESADO },
  { min: 86, max: 100, estado: LEAD_ESTADO.LISTO_PARA_COMPRAR },
] as const;

/** Clamp seguro del score al rango [0, 100] */
export function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ===========================================================================
// RAG — búsqueda en knowledge_chunks
// ===========================================================================

export type KnowledgeChunkSourceType = KnowledgeChunkRow['source_type'];

/** Metadata tipada almacenada en knowledge_chunks.metadata */
export interface KnowledgeChunkMetadata {
  producto?: string;
  marca?: string;
  resultado?: 'vendido' | 'no_vendido';
  objecion_resuelta?: string;
  estado_final_lead?: LeadEstado;
  tags?: string[];
  [key: string]: unknown;
}

/** Resultado de una búsqueda RAG con similitud coseno calculada por pgvector */
export interface RagSearchResult {
  id: string;
  source_type: KnowledgeChunkSourceType;
  source_id: string | null;
  content: string;
  /** Similitud coseno [0, 1]. Valores > 0.75 son relevantes (ver rag_top_k en business_rules) */
  similarity: number;
  metadata: KnowledgeChunkMetadata;
}

// ===========================================================================
// Business rules — config tipada del negocio
// Corresponde a las claves en 002_seed_rules.sql
// ===========================================================================

export interface EscalationThreshold {
  lead_score: number;
  keywords: string[];
}

export interface BusinessHoursSlot {
  open: string;  // HH:MM en 24h
  close: string; // HH:MM en 24h
}

export interface BusinessHours {
  timezone: string;
  schedule: {
    mon: BusinessHoursSlot | null;
    tue: BusinessHoursSlot | null;
    wed: BusinessHoursSlot | null;
    thu: BusinessHoursSlot | null;
    fri: BusinessHoursSlot | null;
    sat: BusinessHoursSlot | null;
    sun: BusinessHoursSlot | null;
  };
  outside_hours_msg: string;
}

export interface FollowupMessages {
  recuperacion: string;
  cierre: string;
  check_in: string;
  oferta: string;
}

export interface MaxNoResponseHours {
  /** Horas hasta crear un followup de cierre */
  warning: number;
  /** Horas hasta marcar el lead como PERDIDO */
  lost: number;
}

export interface RagTopK {
  value: number;
  threshold: number; // similitud coseno mínima [0, 1]
}

export interface FinancingPlan {
  name: string;        // "Ahora 12", "3 cuotas sin interés"
  installments: number;
  interest_rate: number; // 0 = sin interés
  min_amount: number;
}

export interface AgentSalesPriority {
  order: string[];
  directive: string;
  advance_question_required: boolean;
}

/**
 * Todas las business_rules cargadas y tipadas.
 * Se construye desde la tabla business_rules al iniciar el servidor.
 * Ver src/db/business-rules.ts para la carga y caché.
 */
export interface BusinessRulesMap {
  escalation_threshold: EscalationThreshold;
  business_hours: BusinessHours;
  followup_messages: FollowupMessages;
  max_no_response_hours: MaxNoResponseHours;
  recovery_interval_days: { value: number };
  rag_top_k: RagTopK;
  /** Claves son strings del número de horas: "0" → "hoy", "24" → "mañana" */
  delivery_time_labels: Record<string, string>;
  prohibited_phrases: string[];
  approved_availability_phrases: string[];
  financing_plans: FinancingPlan[];
  agent_sales_priority: AgentSalesPriority;
}

// ===========================================================================
// Contexto de entrada al agente por mensaje
// ===========================================================================

/** Todo lo que el agente necesita para generar una respuesta */
export interface AgentContext {
  lead: Lead;
  memory: CustomerMemory | null;
  /** Últimos N mensajes del historial, ordenados de más antiguo a más reciente */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Chunks RAG relevantes para el mensaje actual */
  ragChunks: RagSearchResult[];
  /** Variantes de producto encontradas para el contexto del mensaje (sin supply_notes) */
  productVariants: ProductVariantWithProduct[];
  rules: BusinessRulesMap;
  /** Mensaje actual del cliente */
  userMessage: string;
  /**
   * Precios en vivo desde el ERP (hoja del Sheet), ya filtrados al modelo
   * consultado. Fuente de verdad para contado, preventa y toma/canje.
   * null si el ERP no está configurado o no se pudo consultar.
   */
  livePricing: LivePricingContext | null;
}

export interface LivePricingContext {
  /** Filas de precio (contado + preventa) del modelo consultado, por almacenamiento */
  precios: Array<{
    modelo: string;
    almacenamiento: string;
    precioARS: number;
    preventaARS: number;
    precioUSD: number;
    /** Cuotas exactas sobre el precio contado (calculadas en código, no por el modelo) */
    cuotasContado: Array<{ cuotas: number; porCuota: number }>;
    /** Cuotas exactas sobre el precio de preventa */
    cuotasPreventa: Array<{ cuotas: number; porCuota: number }>;
  }>;
  /** Fila de toma (canje) del modelo que el cliente quiere entregar, si aplica */
  toma: {
    modelo: string;
    impecable: number;
    deducciones: Record<string, number>;
    /**
     * Valuación ya calculada en código a partir de las fallas detectadas en
     * la conversación. null si no se detectó ninguna falla todavía.
     */
    calculada: {
      fallasDetectadas: string[];
      deducciones: Array<{ parte: string; monto: number }>;
      total: number;
    } | null;
  } | null;
  /** Antigüedad del dato en minutos (para saber si está fresco) */
  edadMinutos: number;
  /** Si el precio de preventa que se muestra es una PROMO por tiempo limitado: hasta cuándo. */
  promoVigenteHasta: string | null;
}

// ===========================================================================
// Tipos de error de la aplicación
// ===========================================================================

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'DATABASE_ERROR', context);
    this.name = 'DatabaseError';
  }
}

export class AgentError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'AGENT_ERROR', context);
    this.name = 'AgentError';
  }
}

// ===========================================================================
// Tipos utilitarios
// ===========================================================================

/** Resultado de una operación que puede fallar con un error tipado */
export type Result<T, E extends Error = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<E extends Error>(error: E): Result<never, E> {
  return { ok: false, error };
}
