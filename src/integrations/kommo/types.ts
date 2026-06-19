/**
 * Tipos para la integración con Kommo CRM.
 *
 * Kommo envía webhooks en dos formatos según el evento:
 *  - Chat messages: cuando un cliente escribe por WhatsApp / Instagram / Facebook
 *  - Lead events: cuando se crea o actualiza un lead en el CRM
 *
 * La API de Kommo usa OAuth 2.0 con access tokens de 24h y refresh tokens.
 */

// ===========================================================================
// Webhook payloads (Kommo → nuestro servidor)
// ===========================================================================

/** Payload principal del webhook de mensaje entrante de Kommo. */
export interface KommoMessageWebhook {
  account_id: number;
  time: number;
  message: KommoIncomingChatMessage;
}

export interface KommoIncomingChatMessage {
  /** UUID del mensaje — usado para deduplicación. */
  id: string;
  type: 'text' | 'image' | 'audio' | 'video' | 'file' | 'location' | 'sticker';
  text?: string;
  author: {
    /** e.g. "whatsapp:5491155550001" / "instagram:123456789" / "facebook:987654321" */
    id: string;
    name?: string;
    /** 'client' = mensaje entrante, 'user' = agente de Kommo */
    type: 'client' | 'user';
  };
  conversation: {
    /** UUID de la conversación — se usa para enviar respuestas. */
    id: string;
    /** ID del lead asociado en Kommo (si ya fue creado). */
    lead_id?: number;
    /** ID del contacto en Kommo. */
    contact_id?: number;
  };
  channel: {
    id: string;
    type: 'whatsapp' | 'instagram' | 'facebook' | 'telegram' | 'vk';
  };
}

/** Webhook alternativo de Kommo para eventos de lead (creación / actualización). */
export interface KommoLeadWebhook {
  account: { subdomain: string; id: number };
  leads?: {
    add?: KommoLeadEvent[];
    update?: KommoLeadEvent[];
  };
}

export interface KommoLeadEvent {
  id: number;
  pipeline_id: number;
  status_id: number;
  responsible_user_id?: number;
  contact?: { id: number };
  created_at: number;
  updated_at: number;
}

// ===========================================================================
// Tipos de la API de Kommo (respuestas)
// ===========================================================================

export interface KommoContact {
  id: number;
  name: string;
  custom_fields_values?: KommoCustomFieldValue[];
}

export interface KommoLead {
  id: number;
  name: string;
  pipeline_id: number;
  status_id: number;
  responsible_user_id?: number;
  score?: number;
  custom_fields_values?: KommoCustomFieldValue[];
}

export interface KommoCustomFieldValue {
  field_id: number;
  field_code?: string;
  values: Array<{ value: string | number | boolean; enum_id?: number }>;
}

export interface KommoTokenResponse {
  token_type: 'Bearer';
  expires_in: number;
  access_token: string;
  refresh_token: string;
}

// ===========================================================================
// Tipos internos de la integración
// ===========================================================================

/**
 * Tipo de consulta detectado en el primer mensaje del cliente.
 * Determina a qué pipeline de Kommo se mueve el lead.
 */
export type KommoTipoConsulta =
  | 'compra'
  | 'venta'
  | 'permuta'
  | 'reparacion'
  | 'garantia'
  | 'accesorios'
  | 'consulta_general'
  | 'cliente_existente';

export type KommoTemperatura = 'caliente' | 'tibio' | 'frio' | 'no_calificado';

/** Configuración de un pipeline de Kommo con sus etapas. */
export interface KommoPipeline {
  pipeline_id: number;
  stages: Record<string, number>;
}

/** IDs de campos personalizados en Kommo. */
export interface KommoCustomFields {
  score: number;
  temperatura: number;
  tipo_consulta: number;
  requiere_humano: number;
  intencion: number;
  modelo_interes: number;
  canal_entrada: number;
  accion_venta: number;
  /** Campo donde el agente deposita la respuesta para que el Salesbot la envíe. */
  ia_respuesta: number;
}

/** Datos necesarios para sincronizar un lead con Kommo. */
export interface KommoSyncPayload {
  kommo_lead_id: number;
  kommo_conversation_id: string;
  tipo_consulta: KommoTipoConsulta;
  temperatura: KommoTemperatura;
}

/** Canal de origen extraído del sender.id de Kommo. */
export type KommoChannel = 'whatsapp' | 'instagram' | 'facebook' | 'web';
