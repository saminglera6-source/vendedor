/**
 * Chunker de texto para RAG.
 *
 * Divide textos largos en fragmentos de ~500 tokens (~2.000 chars) con
 * overlap de ~50 tokens (~200 chars). Función pura — sin dependencias externas.
 *
 * Criterios de corte (en orden de prioridad):
 *   1. Párrafos (doble salto de línea)
 *   2. Oraciones (punto, signo de interrogación/exclamación seguido de espacio)
 *   3. Palabras (como fallback si una oración supera maxChars)
 */

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface ChunkOptions {
  /** Máximo de caracteres por chunk (~2.000 ≈ 500 tokens) */
  maxChars?: number;
  /** Overlap entre chunks en caracteres (~200 ≈ 50 tokens) */
  overlapChars?: number;
}

export interface TextChunk {
  /** Contenido del chunk */
  content: string;
  /** Índice de posición en el texto original (0-based) */
  index: number;
  /** Posición de inicio en chars dentro del texto original (orientativo) */
  charStart: number;
}

// ---------------------------------------------------------------------------
// chunkText — función principal
// ---------------------------------------------------------------------------

/**
 * Divide un texto en chunks con overlap.
 *
 * @param text  - Texto a dividir
 * @param opts  - Opciones de tamaño y overlap
 * @returns     - Array de TextChunk en orden de aparición
 */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const { maxChars = 2_000, overlapChars = 200 } = opts;

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  // Texto corto: un solo chunk
  if (normalized.length <= maxChars) {
    return [{ content: normalized, index: 0, charStart: 0 }];
  }

  // Dividir en unidades mínimas (oraciones)
  const units = splitIntoUnits(normalized, maxChars);

  const chunks: TextChunk[] = [];
  let current = '';
  let currentStart = 0;
  let charCursor = 0;

  for (const unit of units) {
    const wouldExceed = current.length + unit.length + 1 > maxChars;

    if (wouldExceed && current.length > 0) {
      // Guardar chunk actual
      chunks.push({
        content: current.trim(),
        index: chunks.length,
        charStart: currentStart,
      });

      // Calcular overlap: tomar los últimos `overlapChars` del chunk actual
      const overlap = extractOverlap(current, overlapChars);
      current = overlap ? overlap + '\n' + unit : unit;
      currentStart = charCursor - overlap.length;
    } else {
      current = current ? current + '\n' + unit : unit;
    }

    charCursor += unit.length + 1;
  }

  // Último chunk
  if (current.trim()) {
    chunks.push({
      content: current.trim(),
      index: chunks.length,
      charStart: currentStart,
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// chunkConversation — para importación de historial Instagram
// ---------------------------------------------------------------------------

/**
 * Formatea una conversación como texto plano antes de chunkear.
 * Agrupa mensajes por participante y agrega timestamps simplificados.
 *
 * @param messages - Array de mensajes con sender, content y timestamp
 */
export function chunkConversation(
  messages: Array<{ sender: string; content: string; timestampMs: number }>,
  opts: ChunkOptions = {},
): TextChunk[] {
  if (messages.length === 0) return [];

  const text = messages
    .filter((m) => m.content.trim())
    .map((m) => {
      const date = new Date(m.timestampMs).toISOString().slice(0, 10);
      return `[${date}] ${m.sender}: ${m.content.trim()}`;
    })
    .join('\n');

  return chunkText(text, opts);
}

// ---------------------------------------------------------------------------
// Helpers privados
// ---------------------------------------------------------------------------

/**
 * Divide un texto en unidades de corte (párrafos, luego oraciones, luego palabras).
 * Garantiza que ninguna unidad supere maxChars.
 */
function splitIntoUnits(text: string, maxChars: number): string[] {
  // Primero dividir por párrafos
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const units: string[] = [];
  for (const para of paragraphs) {
    if (para.length <= maxChars) {
      units.push(para);
    } else {
      // Párrafo muy largo: dividir en oraciones
      const sentences = splitSentences(para);
      for (const sentence of sentences) {
        if (sentence.length <= maxChars) {
          units.push(sentence);
        } else {
          // Oración muy larga: dividir en palabras
          const words = sentence.split(/\s+/);
          let wordChunk = '';
          for (const word of words) {
            if (wordChunk.length + word.length + 1 > maxChars) {
              if (wordChunk) units.push(wordChunk);
              wordChunk = word;
            } else {
              wordChunk = wordChunk ? wordChunk + ' ' + word : word;
            }
          }
          if (wordChunk) units.push(wordChunk);
        }
      }
    }
  }

  return units;
}

/**
 * Divide un párrafo en oraciones.
 * Corta en punto, signo de exclamación/interrogación o salto de línea simple.
 */
function splitSentences(paragraph: string): string[] {
  // Dividir en terminadores de oración seguidos de espacio o salto de línea
  const parts = paragraph.split(/(?<=[.!?])\s+|(?<=\n)/);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Extrae los últimos `overlapChars` de un texto, cortando en límite de palabra.
 */
function extractOverlap(text: string, overlapChars: number): string {
  if (text.length <= overlapChars) return text;

  const candidate = text.slice(-overlapChars);
  // Buscar el primer espacio para no cortar una palabra en el medio
  const firstSpace = candidate.indexOf(' ');
  return firstSpace > 0 ? candidate.slice(firstSpace + 1) : candidate;
}
