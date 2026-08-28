/**
 * Importación del historial de conversaciones de Kommo a knowledge_chunks (RAG).
 *
 * Descarga los mensajes de chat (entrantes + salientes) registrados en Kommo
 * vía /api/v4/events, los agrupa por lead en hilos cronológicos, genera
 * embeddings y los inserta en knowledge_chunks. Así el agente aprende el
 * estilo real de respuesta del vendedor.
 *
 * Uso:
 *   npm run import-kommo-history
 *   node --env-file .env --import tsx/esm scripts/import-kommo-history.ts
 *
 * Requiere en .env:
 *   KOMMO_SUBDOMAIN, KOMMO_ACCESS_TOKEN (long-lived token)
 *   OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
 *
 * Flags:
 *   --max-pages=N   límite de páginas de eventos a descargar (default: sin límite)
 *   --dry-run       descarga y arma los hilos pero no genera embeddings ni inserta
 */

import { getChatEventsPage, type KommoChatEvent } from '../src/integrations/kommo/client.js';
import { embedBatch } from '../src/rag/embed.js';
import { chunkConversation } from '../src/rag/chunker.js';
import { db, toVectorString } from '../src/db/client.js';
import type { KnowledgeChunkInsert } from '../src/db/schema.js';
import type { KnowledgeChunkMetadata } from '../src/types.js';

// ---------------------------------------------------------------------------
// Config / flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const MAX_PAGES = (() => {
  const flag = args.find((a) => a.startsWith('--max-pages='));
  return flag ? parseInt(flag.split('=')[1] ?? '0', 10) : Infinity;
})();

const EVENTS_PER_PAGE = 100;
const EMBED_BATCH_SIZE = 50;
const CHUNK_MAX_CHARS = 2_000;
const CHUNK_OVERLAP_CHARS = 200;
const MIN_MESSAGES_PER_THREAD = 3;

// ---------------------------------------------------------------------------
// 1. Descargar todos los eventos de chat
// ---------------------------------------------------------------------------

async function downloadAllEvents(): Promise<KommoChatEvent[]> {
  const all: KommoChatEvent[] = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const result = await getChatEventsPage(page, EVENTS_PER_PAGE);
    if (!result.ok) {
      if (page === 1) throw new Error(`Kommo API: ${result.error.message}`);
      console.warn(`  ⚠  Página ${page} falló (${result.error.message}) — corto acá`);
      break;
    }

    const { events, hasNext } = result.value;
    all.push(...events);
    process.stdout.write(`\r  📥 Página ${page} · ${all.length} mensajes acumulados`);

    if (!hasNext || events.length === 0) break;
    page++;
  }

  process.stdout.write('\n');
  return all;
}

// ---------------------------------------------------------------------------
// 2. Agrupar en hilos por lead
// ---------------------------------------------------------------------------

interface Thread {
  leadId: number;
  messages: Array<{ sender: string; content: string; timestampMs: number }>;
}

function groupIntoThreads(events: KommoChatEvent[]): Thread[] {
  const byLead = new Map<number, KommoChatEvent[]>();
  for (const ev of events) {
    const list = byLead.get(ev.leadId) ?? [];
    list.push(ev);
    byLead.set(ev.leadId, list);
  }

  const threads: Thread[] = [];
  for (const [leadId, evs] of byLead) {
    const messages = evs
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((e) => ({
        sender: e.direction === 'incoming' ? 'Cliente' : 'Vendedor',
        content: e.text,
        timestampMs: e.createdAt * 1000,
      }));
    if (messages.length >= MIN_MESSAGES_PER_THREAD) {
      threads.push({ leadId, messages });
    }
  }
  return threads;
}

// ---------------------------------------------------------------------------
// 3. Metadatos por hilo (mismo criterio que import-history.ts)
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
  'queda reservado', 'lo retirás', 'lo retiras', 'cerrado', 'lo cerramos',
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

function buildMetadata(messages: Thread['messages']): KnowledgeChunkMetadata {
  const text = messages.map((m) => m.content.toLowerCase()).join(' ');
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
      ...(resultado ? [resultado] : []),
      ...(modelo ? [modelo.replace('iphone ', 'iphone-')] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// 4. Chunk + embed + insert
// ---------------------------------------------------------------------------

interface ChunkToInsert {
  insert: KnowledgeChunkInsert;
  contentForEmbed: string;
}

async function flushBatch(batch: ChunkToInsert[]): Promise<number> {
  if (batch.length === 0) return 0;

  const embedResult = await embedBatch(batch.map((b) => b.contentForEmbed));
  if (!embedResult.ok) {
    console.error(`  ✗ embedBatch: ${embedResult.error.message}`);
    return 0;
  }

  const inserts: KnowledgeChunkInsert[] = batch.map((b, i) => ({
    ...b.insert,
    embedding: toVectorString(embedResult.value[i]!),
  }));

  const { error } = await db.from('knowledge_chunks').insert(inserts as never);
  if (error) {
    console.error(`  ✗ insert: ${error.message}`);
    return 0;
  }
  return inserts.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('🔗 Descargando historial de Kommo…');
  const events = await downloadAllEvents();
  console.log(`   ${events.length} mensajes de chat descargados`);

  const threads = groupIntoThreads(events);
  console.log(`   ${threads.length} hilos con ≥${MIN_MESSAGES_PER_THREAD} mensajes`);

  if (threads.length === 0) {
    console.warn('   Nada para importar. ¿El token tiene scope de eventos? ¿Hay chats en la cuenta?');
    return;
  }

  if (DRY_RUN) {
    const sample = threads[0]!;
    console.log('\n— DRY RUN — ejemplo de hilo:');
    console.log(chunkConversation(sample.messages, { maxChars: CHUNK_MAX_CHARS }).at(0)?.content.slice(0, 800));
    console.log(`\n   (${threads.length} hilos listos para importar; corré sin --dry-run)`);
    return;
  }

  let totalChunks = 0;
  let totalInserted = 0;
  const batch: ChunkToInsert[] = [];

  for (let t = 0; t < threads.length; t++) {
    const thread = threads[t]!;
    const metadata = buildMetadata(thread.messages);
    const firstDate = new Date(thread.messages[0]!.timestampMs).toISOString().slice(0, 10);
    const sourceId = `kommo_lead_${thread.leadId}`;

    const chunks = chunkConversation(thread.messages, {
      maxChars: CHUNK_MAX_CHARS,
      overlapChars: CHUNK_OVERLAP_CHARS,
    });

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

      if (batch.length >= EMBED_BATCH_SIZE) {
        totalInserted += await flushBatch(batch.splice(0, EMBED_BATCH_SIZE));
        process.stdout.write(`\r  ↑ ${totalInserted}/${totalChunks} chunks insertados`);
      }
    }
  }

  if (batch.length > 0) totalInserted += await flushBatch(batch);
  process.stdout.write('\n');

  console.log('\n✅ Importación de Kommo completa:');
  console.log(`   Hilos:             ${threads.length}`);
  console.log(`   Chunks generados:  ${totalChunks}`);
  console.log(`   Chunks insertados: ${totalInserted}`);
}

main().catch((err) => {
  console.error('✗ Error fatal:', err);
  process.exit(1);
});
