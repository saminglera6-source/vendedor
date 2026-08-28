/**
 * Importación del historial de conversaciones de Kommo a knowledge_chunks (RAG).
 *
 * Recorre todas las conversaciones (talks) de la cuenta, baja el transcript
 * completo de cada una vía /api/v4/talks/{id}/messages, las agrupa en hilos
 * cronológicos, genera embeddings y los inserta en knowledge_chunks. Así el
 * agente aprende el estilo real de respuesta del vendedor.
 *
 * Uso:
 *   npm run import-kommo-history
 *   npm run import-kommo-history -- --dry-run --max-talks=5
 *
 * Requiere en .env:
 *   KOMMO_SUBDOMAIN, KOMMO_ACCESS_TOKEN (long-lived token con scope crm)
 *   OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
 *
 * Flags:
 *   --dry-run          baja y arma los hilos, muestra un ejemplo, no inserta
 *   --max-talks=N      límite de conversaciones a procesar
 *   --origin=waba      solo un canal (waba | instagram_business | telegram | …)
 */

import {
  listTalksPage,
  getTalkMessages,
  type KommoChatMessage,
} from '../src/integrations/kommo/client.js';
import { embedBatch } from '../src/rag/embed.js';
import { chunkConversation } from '../src/rag/chunker.js';
import { db, toVectorString } from '../src/db/client.js';
import type { KnowledgeChunkInsert } from '../src/db/schema.js';
import type { KnowledgeChunkMetadata } from '../src/types.js';

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const MAX_TALKS = numFlag('--max-talks=', Infinity);
const ORIGIN_FILTER = strFlag('--origin=');

function numFlag(prefix: string, def: number): number {
  const f = args.find((a) => a.startsWith(prefix));
  return f ? parseInt(f.slice(prefix.length), 10) : def;
}
function strFlag(prefix: string): string | undefined {
  const f = args.find((a) => a.startsWith(prefix));
  return f ? f.slice(prefix.length) : undefined;
}

const EMBED_BATCH_SIZE = 50;
const CHUNK_MAX_CHARS = 2_000;
const CHUNK_OVERLAP_CHARS = 200;
const MIN_MESSAGES_PER_THREAD = 3;
const REQUEST_DELAY_MS = 120; // respeta rate limit de Kommo (~7 req/s)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. Listar todas las talks
// ---------------------------------------------------------------------------

interface TalkRef { talkId: number; leadId: number | null; origin: string; }

async function listAllTalks(): Promise<TalkRef[]> {
  const all: TalkRef[] = [];
  let page = 1;

  while (true) {
    const result = await listTalksPage(page, 250);
    if (!result.ok) {
      if (page === 1) throw new Error(`Kommo API: ${result.error.message}`);
      console.warn(`  ⚠  Página ${page} falló — corto acá`);
      break;
    }
    const { talks, hasNext } = result.value;
    all.push(...talks);
    process.stdout.write(`\r  📋 ${all.length} conversaciones listadas`);
    if (!hasNext || talks.length === 0) break;
    page++;
    await sleep(REQUEST_DELAY_MS);
  }
  process.stdout.write('\n');
  return all;
}

// ---------------------------------------------------------------------------
// 2. Metadatos por hilo
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
const SOLD_KEYWORDS = [
  'transferencia', 'comprobante', 'alias', 'cbu', 'cvu', 'ya te mando',
  'queda reservado', 'lo retirás', 'lo retiras', 'lo cerramos', 'seña',
];
const LOST_KEYWORDS = [
  'no me interesa', 'ya lo compré', 'ya lo compre', 'compré en otro lado',
  'conseguí por otro lado', 'no lo necesito', 'gracias igual',
];
const OBJECTION_PATTERNS: Array<{ keywords: string[]; label: string }> = [
  { keywords: ['caro', 'precio', 'plata', 'presupuesto'], label: 'precio' },
  { keywords: ['garantía', 'garantia', 'original', 'falso'], label: 'garantia' },
  { keywords: ['mercado libre', 'más barato', 'mas barato'], label: 'competencia' },
  { keywords: ['pienso', 'después', 'despues', 'lo consulto'], label: 'postergacion' },
  { keywords: ['batería', 'bateria'], label: 'bateria' },
];

function buildMetadata(messages: KommoChatMessage[], origin: string): KnowledgeChunkMetadata {
  const text = messages.map((m) => m.text.toLowerCase()).join(' ');
  const modelo = MODEL_PATTERNS.find((p) => text.includes(p));
  const resultado = SOLD_KEYWORDS.some((k) => text.includes(k))
    ? 'vendido'
    : LOST_KEYWORDS.some((k) => text.includes(k))
      ? 'no_vendido'
      : undefined;
  const objecion = OBJECTION_PATTERNS.find((o) => o.keywords.some((k) => text.includes(k)))?.label;

  return {
    ...(modelo && { producto: modelo }),
    ...(resultado && { resultado }),
    ...(objecion && { objecion_resuelta: objecion }),
    tags: [
      'kommo',
      origin,
      ...(resultado ? [resultado] : []),
      ...(modelo ? [modelo.replace('iphone ', 'iphone-')] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// 3. Chunk + embed + insert
// ---------------------------------------------------------------------------

interface ChunkToInsert { insert: KnowledgeChunkInsert; contentForEmbed: string; }

async function flushBatch(batch: ChunkToInsert[]): Promise<number> {
  if (batch.length === 0) return 0;
  const embedResult = await embedBatch(batch.map((b) => b.contentForEmbed));
  if (!embedResult.ok) {
    console.error(`\n  ✗ embedBatch: ${embedResult.error.message}`);
    return 0;
  }
  const inserts: KnowledgeChunkInsert[] = batch.map((b, i) => ({
    ...b.insert,
    embedding: toVectorString(embedResult.value[i]!),
  }));
  const { error } = await db.from('knowledge_chunks').insert(inserts as never);
  if (error) {
    console.error(`\n  ✗ insert: ${error.message}`);
    return 0;
  }
  return inserts.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('🔗 Listando conversaciones de Kommo…');
  let talks = await listAllTalks();

  if (ORIGIN_FILTER) talks = talks.filter((t) => t.origin === ORIGIN_FILTER);
  if (Number.isFinite(MAX_TALKS)) talks = talks.slice(0, MAX_TALKS);

  const byOrigin = talks.reduce<Record<string, number>>((acc, t) => {
    acc[t.origin] = (acc[t.origin] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`   ${talks.length} conversaciones a procesar · por canal:`, byOrigin);

  let totalChunks = 0;
  let totalInserted = 0;
  let importedThreads = 0;
  let firstSample = '';
  const batch: ChunkToInsert[] = [];

  for (let i = 0; i < talks.length; i++) {
    const talk = talks[i]!;
    const msgResult = await getTalkMessages(talk.talkId);
    await sleep(REQUEST_DELAY_MS);

    if (!msgResult.ok) {
      console.warn(`\n  ⚠  talk ${talk.talkId}: ${msgResult.error.message}`);
      continue;
    }
    const messages = msgResult.value;
    if (messages.length < MIN_MESSAGES_PER_THREAD) continue;

    const metadata = buildMetadata(messages, talk.origin);
    const firstDate = new Date((messages[0]!.createdAt || 0) * 1000).toISOString().slice(0, 10);
    const sourceId = `kommo_talk_${talk.talkId}`;

    const convForChunker = messages.map((m) => ({
      sender: m.direction === 'incoming' ? 'Cliente' : 'Vendedor',
      content: m.text,
      timestampMs: m.createdAt * 1000,
    }));
    const chunks = chunkConversation(convForChunker, {
      maxChars: CHUNK_MAX_CHARS,
      overlapChars: CHUNK_OVERLAP_CHARS,
    });

    if (!firstSample && chunks[0]) firstSample = chunks[0].content;
    importedThreads++;

    for (const chunk of chunks) {
      batch.push({
        contentForEmbed: chunk.content,
        insert: {
          source_type: 'historical_conversation',
          source_id: sourceId,
          content: `[${firstDate}] ${chunk.content}`,
          metadata: metadata as Record<string, unknown>,
        },
      });
      totalChunks++;

      if (!DRY_RUN && batch.length >= EMBED_BATCH_SIZE) {
        totalInserted += await flushBatch(batch.splice(0, EMBED_BATCH_SIZE));
      }
    }

    process.stdout.write(`\r  ⚙  ${i + 1}/${talks.length} talks · ${importedThreads} hilos · ${totalChunks} chunks`);
  }

  if (!DRY_RUN && batch.length > 0) totalInserted += await flushBatch(batch);
  process.stdout.write('\n');

  if (DRY_RUN) {
    console.log('\n— DRY RUN — ejemplo de hilo formateado:\n');
    console.log(firstSample.slice(0, 1200));
    console.log(`\n   ${importedThreads} hilos · ${totalChunks} chunks listos. Corré sin --dry-run para importar.`);
    return;
  }

  console.log('\n✅ Importación de Kommo completa:');
  console.log(`   Hilos importados:  ${importedThreads}`);
  console.log(`   Chunks generados:  ${totalChunks}`);
  console.log(`   Chunks insertados: ${totalInserted}`);
}

main().catch((err) => {
  console.error('\n✗ Error fatal:', err);
  process.exit(1);
});
