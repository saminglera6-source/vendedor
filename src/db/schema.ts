/**
 * Tipos generados a mano para que coincidan exactamente con 001_initial.sql.
 * Si se modifica la migración, actualizar también este archivo.
 *
 * Supabase espera un tipo `Database` con esta estructura para tipar el cliente.
 * Referencia: https://supabase.com/docs/reference/typescript-support
 */

// ---------------------------------------------------------------------------
// Tipo base para columnas JSONB
// ---------------------------------------------------------------------------

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ---------------------------------------------------------------------------
// Tipos de fila por tabla
// Siguen el orden de creación en la migración.
// ---------------------------------------------------------------------------

export interface ProductRow {
  id: string;
  categoria: string;
  marca: string;
  modelo: string;
  descripcion: string | null;
  imagen_url: string | null;
  activo: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProductInsert {
  id?: string;
  categoria: string;
  marca: string;
  modelo: string;
  descripcion?: string | null;
  imagen_url?: string | null;
  activo?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ProductUpdate {
  categoria?: string;
  marca?: string;
  modelo?: string;
  descripcion?: string | null;
  imagen_url?: string | null;
  activo?: boolean;
  updated_at?: string;
}

// ---------------------------------------------------------------------------

export interface ProductVariantRow {
  id: string;
  product_id: string;
  color: string;
  almacenamiento: string;
  precio: number;
  availability_status: 'AVAILABLE' | 'NO_DISPONIBLE';
  delivery_time_hours: number;
  /**
   * USO INTERNO. Nunca incluir en el contexto del agente.
   * db/products.ts lo filtra en todas las queries.
   */
  supply_notes: string | null;
  activo: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProductVariantInsert {
  id?: string;
  product_id: string;
  color: string;
  almacenamiento: string;
  precio: number;
  availability_status?: 'AVAILABLE' | 'NO_DISPONIBLE';
  delivery_time_hours?: number;
  supply_notes?: string | null;
  activo?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ProductVariantUpdate {
  color?: string;
  almacenamiento?: string;
  precio?: number;
  availability_status?: 'AVAILABLE' | 'NO_DISPONIBLE';
  delivery_time_hours?: number;
  supply_notes?: string | null;
  activo?: boolean;
  updated_at?: string;
}

// ---------------------------------------------------------------------------

export interface LeadRow {
  id: string;
  phone: string;
  name: string | null;
  channel: string;
  estado: 'NEW' | 'CONSULTA' | 'INTERESADO' | 'MUY_INTERESADO' | 'LISTO_PARA_COMPRAR' | 'CLIENTE' | 'PERDIDO';
  lead_score: number;
  requiere_humano: boolean;
  last_contact: string;
  created_at: string;
  updated_at: string;
}

export interface LeadInsert {
  id?: string;
  phone: string;
  name?: string | null;
  channel?: string;
  estado?: LeadRow['estado'];
  lead_score?: number;
  requiere_humano?: boolean;
  last_contact?: string;
  created_at?: string;
  updated_at?: string;
}

export interface LeadUpdate {
  name?: string | null;
  channel?: string;
  estado?: LeadRow['estado'];
  lead_score?: number;
  requiere_humano?: boolean;
  last_contact?: string;
  updated_at?: string;
}

// ---------------------------------------------------------------------------

export interface CustomerMemoryRow {
  id: string;
  lead_id: string;
  producto_interes: string | null;
  color_preferido: string | null;
  almacenamiento: string | null;
  presupuesto_min: number | null;
  presupuesto_max: number | null;
  fecha_estimada_compra: string | null; // DATE → ISO string YYYY-MM-DD
  resumen_comercial: string | null;
  raw_preferences: Json;
  updated_at: string;
}

export interface CustomerMemoryInsert {
  id?: string;
  lead_id: string;
  producto_interes?: string | null;
  color_preferido?: string | null;
  almacenamiento?: string | null;
  presupuesto_min?: number | null;
  presupuesto_max?: number | null;
  fecha_estimada_compra?: string | null;
  resumen_comercial?: string | null;
  raw_preferences?: Json;
  updated_at?: string;
}

export interface CustomerMemoryUpdate {
  producto_interes?: string | null;
  color_preferido?: string | null;
  almacenamiento?: string | null;
  presupuesto_min?: number | null;
  presupuesto_max?: number | null;
  fecha_estimada_compra?: string | null;
  resumen_comercial?: string | null;
  raw_preferences?: Json;
  updated_at?: string;
}

// ---------------------------------------------------------------------------

export interface ConversationRow {
  id: string;
  lead_id: string;
  role: 'user' | 'assistant';
  content: string;
  metadata: Json;
  created_at: string;
}

export interface ConversationInsert {
  id?: string;
  lead_id: string;
  role: 'user' | 'assistant';
  content: string;
  metadata?: Json;
  created_at?: string;
}

// conversations es inmutable — no hay Update intencionalmente

// ---------------------------------------------------------------------------

export interface KnowledgeChunkRow {
  id: string;
  source_type: 'historical_conversation' | 'product_doc' | 'faq';
  source_id: string | null;
  content: string;
  /**
   * pgvector VECTOR(1536). Supabase lo devuelve como string "[0.1,0.2,...]"
   * en selects normales. Para búsquedas usar raw SQL con el operador <=>
   */
  embedding: string | null;
  metadata: Json;
  created_at: string;
}

export interface KnowledgeChunkInsert {
  id?: string;
  source_type: KnowledgeChunkRow['source_type'];
  source_id?: string | null;
  content: string;
  embedding?: string | null; // pasar como "[f1,f2,...]" o usar rpc
  metadata?: Json;
  created_at?: string;
}

// ---------------------------------------------------------------------------

export interface FollowupRow {
  id: string;
  lead_id: string;
  tipo: 'recuperacion' | 'cierre' | 'check_in' | 'oferta';
  mensaje_base: string | null;
  scheduled_at: string;
  executed_at: string | null;
  status: 'pending' | 'sent' | 'cancelled' | 'failed';
  created_at: string;
}

export interface FollowupInsert {
  id?: string;
  lead_id: string;
  tipo: FollowupRow['tipo'];
  mensaje_base?: string | null;
  scheduled_at: string;
  executed_at?: string | null;
  status?: FollowupRow['status'];
  created_at?: string;
}

export interface FollowupUpdate {
  mensaje_base?: string | null;
  scheduled_at?: string;
  executed_at?: string | null;
  status?: FollowupRow['status'];
}

// ---------------------------------------------------------------------------

export interface BusinessRuleRow {
  id: string;
  key: string;
  value: Json;
  description: string | null;
  updated_at: string;
}

export interface BusinessRuleInsert {
  id?: string;
  key: string;
  value: Json;
  description?: string | null;
  updated_at?: string;
}

export interface BusinessRuleUpdate {
  value?: Json;
  description?: string | null;
  updated_at?: string;
}

// ---------------------------------------------------------------------------

export interface AiFeedbackRow {
  id: string;
  conversation_id: string | null;
  lead_id: string | null;
  respuesta_original: string;
  respuesta_corregida: string;
  motivo:
    | 'precio_incorrecto'
    | 'lenguaje_prohibido'
    | 'tono_inadecuado'
    | 'no_avanzo_venta'
    | 'info_inventada'
    | 'derivacion_innecesaria'
    | 'otro'
    | null;
  corregido_por: string | null;
  created_at: string;
}

export interface AiFeedbackInsert {
  id?: string;
  conversation_id?: string | null;
  lead_id?: string | null;
  respuesta_original: string;
  respuesta_corregida: string;
  motivo?: AiFeedbackRow['motivo'];
  corregido_por?: string | null;
  created_at?: string;
}

// ---------------------------------------------------------------------------
// Tipo Database principal — requerido por createClient<Database>
// ---------------------------------------------------------------------------

export type Database = {
  public: {
    Tables: {
      products: {
        Row: ProductRow;
        Insert: ProductInsert;
        Update: ProductUpdate;
        Relationships: [];
      };
      product_variants: {
        Row: ProductVariantRow;
        Insert: ProductVariantInsert;
        Update: ProductVariantUpdate;
        Relationships: [
          {
            foreignKeyName: 'product_variants_product_id_fkey';
            columns: ['product_id'];
            referencedRelation: 'products';
            referencedColumns: ['id'];
          },
        ];
      };
      leads: {
        Row: LeadRow;
        Insert: LeadInsert;
        Update: LeadUpdate;
        Relationships: [];
      };
      customer_memory: {
        Row: CustomerMemoryRow;
        Insert: CustomerMemoryInsert;
        Update: CustomerMemoryUpdate;
        Relationships: [
          {
            foreignKeyName: 'customer_memory_lead_id_fkey';
            columns: ['lead_id'];
            referencedRelation: 'leads';
            referencedColumns: ['id'];
          },
        ];
      };
      conversations: {
        Row: ConversationRow;
        Insert: ConversationInsert;
        Update: never; // conversaciones son inmutables
        Relationships: [
          {
            foreignKeyName: 'conversations_lead_id_fkey';
            columns: ['lead_id'];
            referencedRelation: 'leads';
            referencedColumns: ['id'];
          },
        ];
      };
      knowledge_chunks: {
        Row: KnowledgeChunkRow;
        Insert: KnowledgeChunkInsert;
        Update: never; // chunks son inmutables; reindexar en lugar de actualizar
        Relationships: [];
      };
      followups: {
        Row: FollowupRow;
        Insert: FollowupInsert;
        Update: FollowupUpdate;
        Relationships: [
          {
            foreignKeyName: 'followups_lead_id_fkey';
            columns: ['lead_id'];
            referencedRelation: 'leads';
            referencedColumns: ['id'];
          },
        ];
      };
      business_rules: {
        Row: BusinessRuleRow;
        Insert: BusinessRuleInsert;
        Update: BusinessRuleUpdate;
        Relationships: [];
      };
      ai_feedback: {
        Row: AiFeedbackRow;
        Insert: AiFeedbackInsert;
        Update: never; // feedback es inmutable para trazabilidad
        Relationships: [
          {
            foreignKeyName: 'ai_feedback_conversation_id_fkey';
            columns: ['conversation_id'];
            referencedRelation: 'conversations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'ai_feedback_lead_id_fkey';
            columns: ['lead_id'];
            referencedRelation: 'leads';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      lead_estado: LeadRow['estado'];
      availability_status: ProductVariantRow['availability_status'];
    };
    CompositeTypes: Record<string, never>;
  };
};

// ---------------------------------------------------------------------------
// Helpers de extracción de tipos (mismos que genera Supabase CLI)
// ---------------------------------------------------------------------------

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];

export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T] extends { Update: infer U } ? U : never;

export type Enums<T extends keyof Database['public']['Enums']> =
  Database['public']['Enums'][T];
