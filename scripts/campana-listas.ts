/**
 * Campaña de Aniversario — genera DOS listas (WhatsApp e Instagram) de los leads
 * en "Venta Perdida", con el mensaje personalizado listo para que los chicos
 * copien y peguen a mano.
 *
 * NO manda nada. Solo lee Kommo y escribe dos CSV en la raíz del repo:
 *   campana-whatsapp.csv   → nombre, telefono, link wa.me, modelo, mensaje
 *   campana-instagram.csv  → nombre, link al lead en Kommo, modelo, mensaje
 *
 * Uso:
 *   node --env-file .env --import tsx/esm scripts/campana-listas.ts
 *   node --env-file .env --import tsx/esm scripts/campana-listas.ts --limit=30
 */

import { writeFileSync } from 'node:fs';
import {
  kommoGet,
  listTalksPage,
  getTalkMessages,
} from '../src/integrations/kommo/client.js';
import {
  getPricing,
  findPrecios,
  detectModelosMencionados,
} from '../src/services/pricing.service.js';
import { normalizeModel, formatPrice } from '../src/services/product-matching.service.js';

const PIPELINE_ID = '14337519';
const STATUS_ID = '143'; // Venta Perdida
const SUBDOMINIO = process.env['KOMMO_SUBDOMAIN'] ?? 'lolaso';

// motivos de cierre que NO van a la campaña
const MOTIVOS_EXCLUIR = new Set(['Contacto equivocado / spam', 'Contacto sin datos']);

const args = process.argv.slice(2);
const LIMIT = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '0') || Infinity;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────────────────────────────────────────────────────
// Mensaje
// ───────────────────────────────────────────────────────────────────────────

interface Pricing { find: (m: string) => { modelo: string; almacenamiento: string; preventaARS: number }[] }

function armarMensaje(nombre: string, modelo: string | null, p: Pricing): string {
  const saludo = nombre && !/^\+?\d+$/.test(nombre) ? `Hola ${nombre.split(' ')[0]}! ` : 'Hola! ';
  const hook =
    'Te escribimos de GreatPhones — estamos de aniversario y lo festejamos a lo grande!! ' +
    'Promos fuertes en toda la línea de iPhone hasta el 16/9, con hasta $100.000 de descuento';
  const cierre =
    'Si querés lo pasás a ver al local sin compromiso, o preguntame lo que necesites 🎉';

  const norm = modelo ? normalizeModel(modelo) : null;
  if (norm) {
    const filas = p.find(norm).sort((a, b) => a.preventaARS - b.preventaARS);
    if (filas.length > 0) {
      const f = filas[0]!;
      return (
        `${saludo}${hook}. Y justo el ${f.modelo} de ${f.almacenamiento} que habías consultado quedó a ` +
        `${formatPrice(f.preventaARS)} a pedido — bastante abajo de lo que sale siempre, y es por pocos días. ${cierre}`
      );
    }
    return `${saludo}${hook}. Me acordé de vos por el ${norm} que consultaste — decime la capacidad y te paso el precio con el descuento del cumple. ${cierre}`;
  }
  return `${saludo}${hook}. Contame qué modelo tenías ganas y te paso el precio con la promo del aniversario. ${cierre}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Kommo helpers
// ───────────────────────────────────────────────────────────────────────────

interface KLead {
  id: number;
  name: string;
  _embedded?: {
    contacts?: Array<{ id: number }>;
    loss_reason?: Array<{ name: string }>;
  };
}
interface LeadsPage { _embedded?: { leads?: KLead[] }; _links?: { next?: { href?: string } } }

async function* iterLostLeads(): AsyncGenerator<KLead> {
  let page = 1;
  for (;;) {
    const res = await kommoGet<LeadsPage>(
      `/api/v4/leads?limit=250&page=${page}&with=contacts,loss_reason` +
      `&filter[statuses][0][pipeline_id]=${PIPELINE_ID}&filter[statuses][0][status_id]=${STATUS_ID}`,
    );
    if (!res.ok) { console.error('[listas] error leads:', res.error.message); return; }
    const leads = res.value?._embedded?.leads ?? [];
    if (leads.length === 0) return;
    for (const l of leads) yield l;
    if (!res.value?._links?.next?.href) return;
    page += 1;
  }
}

/** Mapa entity_id (lead) → { talkId, origin }. */
async function buildTalkMap(): Promise<Map<number, { talkId: number; origin: string }>> {
  const map = new Map<number, { talkId: number; origin: string }>();
  for (let page = 1; page <= 40; page++) {
    const res = await listTalksPage(page, 250);
    if (!res.ok) break;
    for (const t of res.value.talks) {
      if (t.leadId && !map.has(t.leadId)) map.set(t.leadId, { talkId: t.talkId, origin: t.origin });
    }
    if (!res.value.hasNext) break;
  }
  return map;
}

async function modeloDesdeHistorial(talkId: number): Promise<string | null> {
  const res = await getTalkMessages(talkId);
  if (!res.ok) return null;
  const texto = res.value.filter((m) => m.direction === 'incoming').map((m) => m.text).join('  ·  ');
  return detectModelosMencionados(texto)[0] ?? null;
}

interface KContact { id: number; name: string; custom_fields_values: Array<{ field_code?: string; values: Array<{ value: unknown }> }> | null }

/** Trae los teléfonos de un lote de contactos: id → phone (o null). */
async function fetchPhones(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    const qs = batch.map((id) => `filter[id][]=${id}`).join('&');
    const res = await kommoGet<{ _embedded?: { contacts?: KContact[] } }>(`/api/v4/contacts?limit=250&${qs}`);
    if (res.ok) {
      for (const c of res.value?._embedded?.contacts ?? []) {
        const ph = c.custom_fields_values?.find((f) => f.field_code === 'PHONE')?.values?.[0]?.value;
        if (typeof ph === 'string' && ph.trim()) out.set(c.id, ph.trim());
      }
    }
    await sleep(200);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────

function csvCell(s: string): string {
  return `"${String(s).replace(/"/g, '""')}"`;
}

function waLink(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits}`;
}

async function main(): Promise<void> {
  console.log('[listas] cargando pricing…');
  const pr = await getPricing();
  if (!pr.ok) { console.error('pricing falló:', pr.error.message); process.exit(1); }
  const pricing: Pricing = { find: (m) => findPrecios(pr.value, m) };

  console.log('[listas] mapeando conversaciones…');
  const talkMap = await buildTalkMap();
  console.log(`[listas] ${talkMap.size} conversaciones`);

  const leads: KLead[] = [];
  for await (const l of iterLostLeads()) {
    if (leads.length >= LIMIT) break;
    const motivo = l._embedded?.loss_reason?.[0]?.name ?? '';
    if (MOTIVOS_EXCLUIR.has(motivo)) continue;
    leads.push(l);
  }
  console.log(`[listas] ${leads.length} leads (sin spam / sin datos)`);

  // teléfonos de todos los contactos linkeados
  const contactIds = [...new Set(leads.flatMap((l) => l._embedded?.contacts?.map((c) => c.id) ?? []))];
  console.log(`[listas] trayendo teléfonos de ${contactIds.length} contactos…`);
  const phones = await fetchPhones(contactIds);

  const wa: string[] = ['nombre,telefono,link_whatsapp,modelo,mensaje'];
  const ig: string[] = ['nombre,link_kommo,modelo,mensaje'];
  let nWa = 0, nIg = 0, nSin = 0;

  for (const l of leads) {
    const info = talkMap.get(l.id);
    const cid = l._embedded?.contacts?.[0]?.id;
    const phone = cid ? phones.get(cid) : undefined;

    // modelo desde historial
    let modelo: string | null = null;
    if (info?.talkId) modelo = await modeloDesdeHistorial(info.talkId);
    const mensaje = armarMensaje(l.name, modelo, pricing);
    const leadUrl = `https://${SUBDOMINIO}.kommo.com/leads/detail/${l.id}`;

    if (phone) {
      wa.push([csvCell(l.name), csvCell(phone), csvCell(waLink(phone)), csvCell(modelo ?? ''), csvCell(mensaje)].join(','));
      nWa += 1;
    } else if (info?.origin === 'instagram_business') {
      ig.push([csvCell(l.name), csvCell(leadUrl), csvCell(modelo ?? ''), csvCell(mensaje)].join(','));
      nIg += 1;
    } else {
      nSin += 1;
    }
    await sleep(120);
  }

  writeFileSync('campana-whatsapp.csv', wa.join('\n') + '\n', 'utf8');
  writeFileSync('campana-instagram.csv', ig.join('\n') + '\n', 'utf8');

  console.log(
    `\n=== Listo ===\n` +
    `campana-whatsapp.csv   → ${nWa} leads con teléfono\n` +
    `campana-instagram.csv  → ${nIg} leads solo Instagram (abrir en Kommo y mandar desde ahí)\n` +
    `sin canal usable:        ${nSin}\n`,
  );
}

main().catch((e: unknown) => { console.error('[listas] fatal:', e); process.exit(1); });
