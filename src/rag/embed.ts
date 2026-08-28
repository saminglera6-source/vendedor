/**
 * Embeddings con OpenAI text-embedding-3-small.
 *
 * Retorna Result<number[]> — nunca lanza excepciones al caller.
 * El cliente se inicializa en el primer uso (lazy singleton).
 */

import OpenAI from 'openai';
import { type Result } from '../types.js';

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (_openai) return _openai;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY no definida — requerida para RAG');
  _openai = new OpenAI({ apiKey: key });
  return _openai;
}

const MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
const DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);

// OpenAI limita la entrada a ~8191 tokens. En español, 1 token ≈ 4 chars.
// Truncamos a 32.000 chars como margen seguro sin cortar la semántica.
const MAX_INPUT_CHARS = 32_000;

// ---------------------------------------------------------------------------
// embed
// ---------------------------------------------------------------------------

/**
 * Genera el embedding de un texto.
 *
 * @param text - Texto a vectorizar. Se trunca si supera MAX_INPUT_CHARS.
 * @returns Vector de 1536 dimensiones, o error si la API falla.
 */
export async function embed(text: string): Promise<Result<number[]>> {
  try {
    const client = getOpenAI();
    const input = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;

    const response = await client.embeddings.create({
      model: MODEL,
      input,
      dimensions: DIMENSIONS,
    });

    const embedding = response.data[0]?.embedding;
    if (!embedding) {
      return { ok: false, error: new Error('OpenAI no devolvió embedding en la respuesta') };
    }

    return { ok: true, value: embedding };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Genera embeddings para un batch de textos en una sola llamada.
 * Más eficiente que llamar embed() N veces cuando hay muchos textos.
 *
 * @param texts - Array de textos a vectorizar (máx. 2048 por request)
 * @returns Array de vectores en el mismo orden que `texts`
 */
export async function embedBatch(texts: string[]): Promise<Result<number[][]>> {
  if (texts.length === 0) return { ok: true, value: [] };

  try {
    const client = getOpenAI();
    const inputs = texts.map((t) =>
      t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t,
    );

    const response = await client.embeddings.create({
      model: MODEL,
      input: inputs,
      dimensions: DIMENSIONS,
    });

    // La API devuelve los embeddings en el mismo orden que los inputs
    const embeddings = response.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);

    return { ok: true, value: embeddings };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
