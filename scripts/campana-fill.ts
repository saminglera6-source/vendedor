/**
 * Campaña de Aniversario — llena el campo "RESPUESTA DE IA" (389576) de cada lead
 * en "Venta Perdida" (status 143) con un pitch personalizado, para que la
 * plantilla aprobada de WhatsApp lo use como variable.
 *
 * NO manda nada. Solo escribe el campo. La difusión se lanza después, a mano,
 * desde Kommo.
 *
 * Uso:
 *   node --env-file .env --import tsx/esm scripts/campana-fill.ts --dry-run
 *   node --env-file .env --import tsx/esm scripts/campana-fill.ts --limit=20
 *   node --env-file .env --import tsx/esm scripts/campana-fill.ts
 *
 * Flags:
 *   --dry-run       no escribe nada, solo imprime qué pondría en cada lead
 *   --limit=N       procesa como mucho N leads
 *   --delay=MS      pausa entre escrituras (default 400ms)
 *   --pipeline=ID   pipeline de Kommo (default 14337519)
 *   --status=ID     status a filtrar (default 143 = Venta Perdida)
 */

import {
  kommoGet,
  updateLeadCustomField,
  listTalksPage,
  getTalkMessages,
} from '../src/integrations/kommo/client.js';
import {
  getPricing,
  findPrecios,
  detectModelosMencionados,
} from '../src/services/pricing.service.js';
import { normalizeModel, formatPrice } from '../src/services/product-matching.service.js';

// ── IDs de campos personalizados en Kommo (lolaso) ──────────────────────────
const FIELD_MODELO_CONSULTADO = 289540;
const FIELD_RESPUESTA_IA = 389576;

// ── args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f: string): boolean => args.includes(f);
const val = (f: string, def: string): string =>
  args.find((a) => a.startsWith(`${f}=`))?.split('=')[1] ?? def;

const DRY_RUN = has('--dry-run');
const FORCE = has('--force'); // reescribe aunque el campo ya tenga algo
const LIMIT = Number(val('--limit', '0')) || Infinity;
const DELAY_MS = Number(val('--delay', '400'));
const PIPELINE_ID = val('--pipeline', '14337519');
const STATUS_ID = val('--status', '143');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────────────────────────────────────────────────────
// Armado del pitch
// ───────────────────────────────────────────────────────────────────────────

interface Pricing {
  find: (modelo: string) => { modelo: string; almacenamiento: string; preventaARS: number }[];
}

/**
 * El texto que va en la variable de la plantilla. La plantilla ya trae
 * "Hola! Te escribimos de GreatPhones " antes y " 🎉" después, así que esto
 * arranca en minúscula (o con guión) y no repite el saludo ni cierra con emoji.
 */
function armarPitch(modeloConsultado: string | null, p: Pricing): string {
  const cierre =
    'Si querés lo pasás a ver al local sin compromiso, o preguntame lo que necesites';

  const hook =
    '— estamos de aniversario y lo festejamos a lo grande!! Promos fuertes en toda la línea de iPhone hasta el 16/9, con hasta $100.000 de descuento';

  const norm = modeloConsultado ? normalizeModel(modeloConsultado) : null;
  if (norm) {
    const filas = p.find(norm).sort((a, b) => a.preventaARS - b.preventaARS);
    if (filas.length > 0) {
      const f = filas[0]!;
      return (
        `${hook}. Y justo el ${f.modelo} de ${f.almacenamiento} que habías consultado quedó a ` +
        `${formatPrice(f.preventaARS)} a pedido — bastante abajo de lo que sale siempre, y es por pocos días. ` +
        cierre
      );
    }
    // modelo conocido pero sin precio en la lista
    return (
      `${hook}. Me acordé de vos por el ${norm} que habías consultado — decime la capacidad y te paso ` +
      `el precio con el descuento del cumple. ` +
      cierre
    );
  }

  // sin modelo → genérico, igual con onda
  return (
    `${hook}. Contame qué modelo tenías ganas y te paso el precio con la promo del aniversario`
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Kommo
// ───────────────────────────────────────────────────────────────────────────

interface KommoLeadLite {
  id: number;
  name: string;
  custom_fields_values: Array<{
    field_id: number;
    values: Array<{ value: unknown }>;
  }> | null;
}

interface LeadsPage {
  _embedded?: { leads?: KommoLeadLite[] };
  _links?: { next?: { href?: string } };
}

function readField(lead: KommoLeadLite, fieldId: number): string | null {
  const f = lead.custom_fields_values?.find((x) => x.field_id === fieldId);
  const v = f?.values?.[0]?.value;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Mapa entity_id (lead) → talk_id, armado paginando todas las conversaciones. */
async function buildTalkMap(): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for (let page = 1; page <= 40; page++) {
    const res = await listTalksPage(page, 250);
    if (!res.ok) break;
    for (const t of res.value.talks) {
      if (t.leadId && !map.has(t.leadId)) map.set(t.leadId, t.talkId);
    }
    if (!res.value.hasNext) break;
  }
  return map;
}

/** Saca el modelo consultado del historial de la conversación del lead. */
async function modeloDesdeHistorial(talkId: number): Promise<string | null> {
  const res = await getTalkMessages(talkId);
  if (!res.ok) return null;
  // Solo lo que escribió el cliente (incoming), del más viejo al más nuevo.
  const texto = res.value
    .filter((m) => m.direction === 'incoming')
    .map((m) => m.text)
    .join('  ·  ');
  const modelos = detectModelosMencionados(texto);
  return modelos[0] ?? null;
}

async function* iterLostLeads(): AsyncGenerator<KommoLeadLite> {
  let page = 1;
  for (;;) {
    const path =
      `/api/v4/leads?limit=250&page=${page}` +
      `&filter[statuses][0][pipeline_id]=${PIPELINE_ID}` +
      `&filter[statuses][0][status_id]=${STATUS_ID}`;
    const res = await kommoGet<LeadsPage>(path);
    if (!res.ok) {
      console.error(`[campaña] error leyendo leads (page ${page}): ${res.error.message}`);
      return;
    }
    const leads = res.value?._embedded?.leads ?? [];
    if (leads.length === 0) return;
    for (const l of leads) yield l;
    if (!res.value?._links?.next?.href) return;
    page += 1;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// main
// ───────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(
    `\n=== Campaña Aniversario — llenar RESPUESTA DE IA ===\n` +
    `pipeline=${PIPELINE_ID} status=${STATUS_ID} ` +
    `${DRY_RUN ? '· DRY RUN (no escribe)' : '· ESCRIBE en Kommo'} ` +
    `${LIMIT !== Infinity ? `· limit=${LIMIT}` : ''}\n`,
  );

  const pricingRes = await getPricing();
  if (!pricingRes.ok) {
    console.error(`[campaña] no se pudo cargar el pricing: ${pricingRes.error.message}`);
    process.exit(1);
  }
  const data = pricingRes.value;
  const pricing: Pricing = { find: (m) => findPrecios(data, m) };

  console.log('[campaña] mapeando conversaciones…');
  const talkMap = await buildTalkMap();
  console.log(`[campaña] ${talkMap.size} conversaciones mapeadas\n`);

  let n = 0;
  let escritos = 0;
  let conModelo = 0;
  let fallidos = 0;

  let saltados = 0;

  for await (const lead of iterLostLeads()) {
    if (n >= LIMIT) break;
    n += 1;

    // Idempotencia: si ya tiene el campo lleno y no es --force, saltar.
    if (!FORCE && readField(lead, FIELD_RESPUESTA_IA)) {
      saltados += 1;
      continue;
    }

    // 1) campo "Modelo consultado"  2) fallback: historial de la conversación
    let modelo = readField(lead, FIELD_MODELO_CONSULTADO);
    if (!modelo) {
      const talkId = talkMap.get(lead.id);
      if (talkId) modelo = await modeloDesdeHistorial(talkId);
    }
    if (modelo) conModelo += 1;
    const pitch = armarPitch(modelo, pricing);

    const etiqueta = `[${lead.id}] ${lead.name || '(sin nombre)'}  modelo="${modelo ?? '—'}"`;
    if (DRY_RUN) {
      console.log(`\n${etiqueta}\n   → ${pitch}`);
      continue;
    }

    const upd = await updateLeadCustomField(lead.id, FIELD_RESPUESTA_IA, pitch);
    if (upd.ok) {
      escritos += 1;
      console.log(`✓ ${etiqueta}`);
    } else {
      fallidos += 1;
      console.error(`✗ ${etiqueta}  — ${upd.error.message}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(
    `\n=== Resumen ===\n` +
    `leads vistos:        ${n}\n` +
    `saltados (ya tenían): ${saltados}\n` +
    `con modelo conocido: ${conModelo}\n` +
    (DRY_RUN
      ? `(dry run — no se escribió nada)\n`
      : `campos escritos:    ${escritos}\n` +
        `fallidos:           ${fallidos}\n`),
  );
}

main().catch((e: unknown) => {
  console.error('[campaña] error fatal:', e);
  process.exit(1);
});
