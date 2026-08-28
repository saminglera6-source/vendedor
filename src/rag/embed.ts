/**
 * Embeddings locales con Transformers.js (sin API, sin key, sin costo).
 *
 * Modelo: Xenova/multilingual-e5-small — multilingüe (incl. español),
 * 384 dimensiones. Se descarga una sola vez (~120 MB) a la caché local
 * y después corre 100% offline sobre CPU.
 *
 * El modelo e5 requiere prefijos:
 *   - "query: "   para el texto de búsqueda
 *   - "passage: " para los documentos indexados
 *
 * Retorna Result<number[]> — nunca lanza excepciones al caller.
 */

import { type Result } from '../types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MODEL = process.env.EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small';
export const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 384);

// e5 fue entrenado con ventana de 512 tokens (~2.000 chars en español).
const MAX_INPUT_CHARS = 2_000;

type EmbedKind = 'query' | 'passage';

// ---------------------------------------------------------------------------
// Singleton del pipeline (carga perezosa)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _extractor: any = null;
let _loading: Promise<unknown> | null = null;

async function getExtractor(): Promise<unknown> {
  if (_extractor) return _extractor;
  if (!_loading) {
    _loading = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      // Solo modelos remotos de HuggingFace; caché en node_modules/.cache
      env.allowLocalModels = false;
      _extractor = await pipeline('feature-extraction', MODEL);
      return _extractor;
    })();
  }
  await _loading;
  return _extractor;
}

function prep(text: string, kind: EmbedKind): string {
  const trimmed = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
  return `${kind}: ${trimmed}`;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Genera el embedding de un texto.
 * @param text - texto a vectorizar
 * @param kind - 'query' para búsquedas, 'passage' para documentos (default)
 */
export async function embed(
  text: string,
  kind: EmbedKind = 'passage',
): Promise<Result<number[]>> {
  try {
    const extractor = await getExtractor();
    // @ts-expect-error — el pipeline es callable pero sin tipos precisos
    const output = await extractor(prep(text, kind), { pooling: 'mean', normalize: true });
    return { ok: true, value: Array.from(output.data as Float32Array) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Genera embeddings para un batch de textos.
 * Transformers.js no paraleliza en CPU, así que procesa secuencialmente,
 * pero mantiene la misma interfaz que la versión OpenAI.
 *
 * @param texts - textos a vectorizar
 * @param kind  - 'query' o 'passage' (default)
 */
export async function embedBatch(
  texts: string[],
  kind: EmbedKind = 'passage',
): Promise<Result<number[][]>> {
  if (texts.length === 0) return { ok: true, value: [] };

  try {
    const extractor = await getExtractor();
    const out: number[][] = [];
    for (const t of texts) {
      // @ts-expect-error — pipeline callable sin tipos precisos
      const output = await extractor(prep(t, kind), { pooling: 'mean', normalize: true });
      out.push(Array.from(output.data as Float32Array));
    }
    return { ok: true, value: out };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
