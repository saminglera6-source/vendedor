-- ============================================================
-- 005_embeddings_local_384.sql
--
-- Cambia el motor de embeddings de OpenAI text-embedding-3-small (1536 dim)
-- a un modelo local multilingüe (Xenova/multilingual-e5-small, 384 dim).
-- Sin API key, sin costo.
--
-- Seguro de correr solo si knowledge_chunks está VACÍA (los vectores de
-- 1536 no son compatibles con los de 384). Si tiene datos, primero:
--   TRUNCATE knowledge_chunks;
-- ============================================================

-- 1. Quitar el índice viejo (atado a la dimensión anterior)
DROP INDEX IF EXISTS idx_knowledge_chunks_embedding;

-- 2. Cambiar la dimensión de la columna
ALTER TABLE knowledge_chunks
  ALTER COLUMN embedding TYPE vector(384);

-- 3. Recrear el índice ivfflat para coseno
CREATE INDEX idx_knowledge_chunks_embedding
  ON knowledge_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 4. Recrear la RPC de búsqueda con la nueva dimensión
DROP FUNCTION IF EXISTS match_knowledge_chunks(vector, float, int);

CREATE OR REPLACE FUNCTION match_knowledge_chunks(
  query_embedding  vector(384),
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

GRANT EXECUTE ON FUNCTION match_knowledge_chunks(vector, float, int)
  TO service_role;
