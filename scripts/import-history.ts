/**
 * Importación masiva de conversaciones históricas de Instagram a knowledge_chunks.
 *
 * Lee los archivos JSON de _chat_analysis/, genera embeddings y los inserta
 * en knowledge_chunks para activar el pipeline RAG.
 *
 * Uso:
 *   node --env-file .env --import tsx/esm scripts/import-history.ts
 *   npm run import-history
 *
 * Requiere: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY en .env
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { embedBatch } from '../src/rag/embed.js';
import { chunkConversation } from '../src/rag/chunker.js';
import { db, toVectorString } from '../src/db/client.js';
import type { KnowledgeChunkInsert } from '../src/db/schema.js';
import type { KnowledgeChunkMetadata } from '../src/types.js';

// ---------------------------------------------------------------------------
// Tipos del formato de exportación de Instagram
// ---------------------------------------------------------------------------

interface InstagramMessage {
  sender_name: string;
  timestamp_ms: number;
  content?: string;
  share?: { link?: string };
  photos?: Array<{ uri: string }>;
  is_unsent?: boolean;
}

interface InstagramThread {
  participants: Array<{ name: string }>;
  messages: InstagramMessage[];
  title?: string;
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const CHAT_DIR = join(process.cwd(), '_chat_analysis');
const BATCH_SIZE = 50; // embeddings por request a OpenAI
const CHUNK_MAX_CHARS = 2_000;
const CHUNK_OVERLAP_CHARS = 200;

// Umbral de mensajes del vendedor para detectar autoáticamente el nombre
const MIN_SELLER_MESSAGES = 100;

// ---------------------------------------------------------------------------
// Detector automático del vendedor (el remitente con más mensajes)
// ---------------------------------------------------------------------------

function detectSellerName(threads: InstagramThread[]): string {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    for (const msg of thread.messages) {
      if (msg.content) {
        counts.set(msg.sender_name, (counts.get(msg.sender_name) ?? 0) + 1);
      }
    }
  }

  const [seller] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .find(([, count]) => count >= MIN_SELLER_MESSAGES) ?? [];

  if (!seller) throw new Error('No se pudo detectar el vendedor en los chats');
  return seller;
}

// ---------------------------------------------------------------------------
// Detección del resultado de la conversación
// ---------------------------------------------------------------------------

const SOLD_KEYWORDS = [
  'transferencia', 'transferís', 'transferiste', 'comprobante',
  'alias', 'cbu', 'cvu', 'ya te mando', 'ya mandé', 'enviado',
  'te llega', 'queda reservado', 'lo retirás', 'lo retiras',
  'cerrado', 'listo lo tuyo', 'dale lo cerramos',
];

const LOST_KEYWORDS = [
  'no me interesa', 'ya lo compré', 'ya lo compre', 'compré en otro lado',
  'conseguí por otro lado', 'no lo necesito', 'gracias igual',
];

function detectOutcome(messages: InstagramMessage[]): 'vendido' | 'no_vendido' | undefined {
  const allText = messages
    .filter((m) => m.content)
    .map((m) => m.content!.toLowerCase())
    .join(' ');

  const hasSold = SOLD_KEYWORDS.some((kw) => allText.includes(kw));
  const hasLost = LOST_KEYWORDS.some((kw) => allText.includes(kw));

  if (hasSold) return 'vendido';
  if (hasLost) return 'no_vendido';
  return undefined;
}

// ---------------------------------------------------------------------------
// Detección del modelo mencionado en la conversación
// ---------------------------------------------------------------------------

const MODEL_PATTERNS = [
  'iphone 17 pro max', 'iphone 17 pro', 'iphone 17',
  'iphone 16 pro max', 'iphone 16 pro', 'iphone 16',
  'iphone 15 pro max', 'iphone 15 pro', 'iphone 15',
  'iphone 14 pro max', 'iphone 14 pro', 'iphone 14',
  'iphone 13 pro max', 'iphone 13 pro', 'iphone 13',
  'iphone 12 pro max', 'iphone 12 pro', 'iphone 12',
  'iphone 11 pro max', 'iphone 11',
];

function detectModel(messages: InstagramMessage[]): string | undefined {
  const text = messages
    .filter((m) => m.content)
    .map((m) => m.content!.toLowerCase())
    .join(' ');

  return MODEL_PATTERNS.find((pattern) => text.includes(pattern));
}

// ---------------------------------------------------------------------------
// Detección de objeción resuelta
// ---------------------------------------------------------------------------

const OBJECTION_PATTERNS: Array<{ keywords: string[]; label: string }> = [
  { keywords: ['caro', 'precio', 'plata', 'presupuesto'], label: 'precio' },
  { keywords: ['garantía', 'garantia', 'original', 'falso'], label: 'garantia' },
  { keywords: ['mercado libre', 'ml', 'más barato', 'mas barato'], label: 'competencia' },
  { keywords: ['pienso', 'después', 'despues', 'luego', 'más tarde'], label: 'postponamiento' },
  { keywords: ['batería', 'bateria', 'batería original'], label: 'bateria' },
];

function detectObjection(messages: InstagramMessage[]): string | undefined {
  const text = messages
    .filter((m) => m.content)
    .map((m) => m.content!.toLowerCase())
    .join(' ');

  for (const { keywords, label } of OBJECTION_PATTERNS) {
    if (keywords.some((kw) => text.includes(kw))) return label;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Carga de archivos
// ---------------------------------------------------------------------------

async function loadThreads(dir: string): Promise<InstagramThread[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));

  const threads: InstagramThread[] = [];
  for (const file of files) {
    try {
      const content = await readFile(join(dir, file), 'utf-8');
      const thread = JSON.parse(content) as InstagramThread;
      if (thread.messages?.length > 0) threads.push(thread);
    } catch {
      console.warn(`  ⚠  No se pudo parsear ${file}`);
    }
  }
  return threads;
}

// ---------------------------------------------------------------------------
// Pipeline de inserción
// ---------------------------------------------------------------------------

interface ChunkToInsert {
  insert: KnowledgeChunkInsert;
  contentForEmbed: string;
}

async function processBatch(batch: ChunkToInsert[]): Promise<number> {
  if (batch.length === 0) return 0;

  // 1. Generar embeddings en batch
  const texts = batch.map((b) => b.contentForEmbed);
  const embedResult = await embedBatch(texts);

  if (!embedResult.ok) {
    console.error(`  ✗ Error en embedBatch: ${embedResult.error.message}`);
    return 0;
  }

  // 2. Preparar inserts con embeddings
  const inserts: KnowledgeChunkInsert[] = batch.map((b, i) => ({
    ...b.insert,
    embedding: toVectorString(embedResult.value[i]!),
  }));

  // 3. Insertar en knowledge_chunks
  const { error } = await db.from('knowledge_chunks').insert(inserts as never);

  if (error) {
    console.error(`  ✗ Error en insert: ${error.message}`);
    return 0;
  }

  return inserts.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🔍 Cargando conversaciones de', CHAT_DIR);

  const threads = await loadThreads(CHAT_DIR);
  console.log(`📂 ${threads.length} conversaciones cargadas`);

  const sellerName = detectSellerName(threads);
  console.log(`🧑‍💼 Vendedor detectado: "${sellerName}"`);

  let totalChunks = 0;
  let totalInserted = 0;
  let threadCount = 0;
  const batch: ChunkToInsert[] = [];

  for (const thread of threads) {
    const messages = thread.messages
      .filter((m) => m.content && !m.is_unsent)
      .sort((a, b) => a.timestamp_ms - b.timestamp_ms)
      .map((m) => ({
        sender: m.sender_name === sellerName ? 'Vendedor' : 'Cliente',
        content: m.content!,
        timestampMs: m.timestamp_ms,
      }));

    if (messages.length < 3) continue; // ignorar threads vacíos

    // Construir metadatos una vez por conversación
    const allRaw = thread.messages.filter((m) => m.content);
    const outcome = detectOutcome(allRaw);
    const modelo = detectModel(allRaw);
    const objecion = detectObjection(allRaw);
    const firstDate = new Date(Math.min(...thread.messages.map((m) => m.timestamp_ms)));

    const metadata: KnowledgeChunkMetadata = {
      ...(modelo && { producto: modelo }),
      ...(outcome && { resultado: outcome }),
      ...(objecion && { objecion_resuelta: objecion }),
      tags: [
        ...(outcome ? [outcome] : []),
        ...(modelo ? [modelo.replace('iphone ', 'iphone-')] : []),
      ],
    };

    // Generar chunks del thread
    const chunks = chunkConversation(messages, {
      maxChars: CHUNK_MAX_CHARS,
      overlapChars: CHUNK_OVERLAP_CHARS,
    });

    const sourceId = `instagram_${firstDate.toISOString().slice(0, 10)}_${threadCount}`;

    for (const chunk of chunks) {
      batch.push({
        contentForEmbed: chunk.content,
        insert: {
          source_type: 'historical_conversation',
          source_id: sourceId,
          content: chunk.content,
          metadata: metadata as Record<string, unknown>,
        },
      });

      // Procesar batch cuando llega al límite
      if (batch.length >= BATCH_SIZE) {
        process.stdout.write(`  ↑ Insertando batch de ${batch.length} chunks...`);
        const inserted = await processBatch(batch.splice(0, BATCH_SIZE));
        totalInserted += inserted;
        console.log(` ✓ (total: ${totalInserted})`);
      }
    }

    totalChunks += chunks.length;
    threadCount++;

    if (threadCount % 100 === 0) {
      console.log(`  📊 ${threadCount}/${threads.length} conversaciones procesadas`);
    }
  }

  // Procesar lo que queda
  if (batch.length > 0) {
    process.stdout.write(`  ↑ Insertando batch final de ${batch.length} chunks...`);
    const inserted = await processBatch(batch);
    totalInserted += inserted;
    console.log(` ✓`);
  }

  console.log('\n✅ Importación completa:');
  console.log(`   Conversaciones procesadas: ${threadCount}`);
  console.log(`   Chunks generados:          ${totalChunks}`);
  console.log(`   Chunks insertados:         ${totalInserted}`);
  if (totalInserted < totalChunks) {
    console.warn(`   ⚠  ${totalChunks - totalInserted} chunks fallaron — revisar logs arriba`);
  }
}

main().catch((err) => {
  console.error('✗ Error fatal:', err);
  process.exit(1);
});
