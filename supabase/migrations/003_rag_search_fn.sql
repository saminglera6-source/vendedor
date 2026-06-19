-- ============================================================
-- Migración 003: función RPC para búsqueda vectorial RAG
--
-- Bloqueador: Supabase JS no soporta el operador <=> de
-- pgvector en el query builder. Esta función lo expone como
-- RPC para que search.ts pueda llamarla con db.rpc().
--
-- Requiere: extensión pgvector activa (habilitada en 001).
-- ============================================================

CREATE OR REPLACE FUNCTION match_knowledge_chunks(
  query_embedding  vector(1536),
  match_threshold  float         DEFAULT 0.75,
  match_count      int           DEFAULT 5
)
RETURNS TABLE (
  id          uuid,
  source_type text,
  source_id   text,
  content     text,
  similarity  float,
  metadata    jsonb
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    kc.id,
    kc.source_type,
    kc.source_id,
    kc.content,
    (1 - (kc.embedding <=> query_embedding))::float AS similarity,
    kc.metadata
  FROM knowledge_chunks kc
  WHERE (1 - (kc.embedding <=> query_embedding)) > match_threshold
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Permitir ejecución desde el rol de servicio (service_role)
GRANT EXECUTE ON FUNCTION match_knowledge_chunks(vector, float, int)
  TO service_role;
