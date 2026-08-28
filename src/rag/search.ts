/**
 * Búsqueda vectorial RAG en knowledge_chunks.
 *
 * Usa la función RPC match_knowledge_chunks (migración 003) porque
 * Supabase JS no soporta el operador <=> de pgvector en el query builder.
 *
 * Retorna Result<RagSearchResult[]> — nunca lanza excepciones al caller.
 */

import { db, toVectorString } from '../db/client.js';
import { type Result, type RagSearchResult, type KnowledgeChunkMetadata } from '../types.js';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** Máximo de resultados a retornar (default: 5) */
  topK?: number;
  /** Similitud mínima coseno [0, 1] (default: 0.75) */
  threshold?: number;
}

// Tipo de la fila que retorna la RPC (no está en schema.ts porque es una función, no una tabla)
interface MatchRow {
  id: string;
  source_type: string;
  source_id: string | null;
  content: string;
  similarity: number;
  metadata: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// searchSimilar
// ---------------------------------------------------------------------------

/**
 * Busca los chunks más similares al embedding dado.
 *
 * Llama a la RPC match_knowledge_chunks que ejecuta la búsqueda coseno
 * con pgvector directamente en PostgreSQL.
 *
 * @param embedding - Vector de 1536 dimensiones (output de embed())
 * @param opts      - Opciones de búsqueda: topK y threshold
 */
export async function searchSimilar(
  embedding: number[],
  opts: SearchOptions = {},
): Promise<Result<RagSearchResult[]>> {
  const { topK = 5, threshold = 0.75 } = opts;

  try {
    const { data, error } = await db.rpc('match_knowledge_chunks', {
      query_embedding: toVectorString(embedding) as unknown as string,
      match_threshold: threshold,
      match_count: topK,
    });

    if (error) {
      return { ok: false, error: new Error(`RAG RPC error: ${error.message}`) };
    }

    if (!data || !Array.isArray(data)) {
      return { ok: true, value: [] };
    }

    const results: RagSearchResult[] = (data as MatchRow[]).map((row) => ({
      id: row.id,
      source_type: row.source_type as RagSearchResult['source_type'],
      source_id: row.source_id,
      content: row.content,
      similarity: row.similarity,
      metadata: (row.metadata ?? {}) as KnowledgeChunkMetadata,
    }));

    return { ok: true, value: results };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
