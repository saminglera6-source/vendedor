/**
 * Selección de proveedor LLM + generación validada del AgentResponse.
 *
 * LLM_PROVIDER en .env elige: 'anthropic' (default) | 'gemini'.
 * El resto del pipeline no sabe qué proveedor se usa.
 */

import { ok, err, AgentError, type Result, type AgentResponse, type AgentContext } from '../../types.js';
import { buildPrompt } from '../prompt.js';
import { AgentResponseSchema } from '../parser.js';
import type { LlmProvider } from './provider.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider, isGeminiSaturation } from './gemini.js';

// ── Estrategia de espera cuando Gemini está saturado (503) ──────────────────
// Para leads poco interesados conviene esperar a que Gemini se libere (es más
// barato). Para leads calientes, caer rápido a Anthropic y no perder la venta.
const INTEREST_THRESHOLD = Number(process.env['LLM_INTEREST_THRESHOLD'] ?? 40);
const WAIT_LOW_MS = Number(process.env['LLM_GEMINI_WAIT_LOW_MS'] ?? 30 * 60_000);  // 30 min
const WAIT_HIGH_MS = Number(process.env['LLM_GEMINI_WAIT_HIGH_MS'] ?? 5 * 60_000); //  5 min
const RETRY_EVERY_MS = Number(process.env['LLM_GEMINI_RETRY_EVERY_MS'] ?? 45_000);

export interface GenerateOpts {
  /** Score de interés del lead (0-100). Decide cuánto esperar a Gemini. */
  interestScore?: number;
  /**
   * true (WhatsApp/Kommo): se puede esperar minutos a que Gemini se libere.
   * false (API directa / simulador): fallback inmediato, sin esperas largas.
   */
  patient?: boolean;
}

let _primary: LlmProvider | null = null;
let _fallback: LlmProvider | null | undefined = undefined;

function makeProvider(name: string): LlmProvider {
  return name === 'gemini' ? createGeminiProvider() : createAnthropicProvider();
}

export function getProvider(): LlmProvider {
  if (_primary) return _primary;
  const name = (process.env['LLM_PROVIDER'] ?? 'anthropic').toLowerCase();
  _primary = makeProvider(name);
  console.info(`[llm] proveedor: ${_primary.name}`);
  return _primary;
}

/**
 * Proveedor de respaldo: el "otro" (si su key está configurada).
 * Se usa solo si el primario falla — para no depender de un solo servicio.
 */
function getFallback(): LlmProvider | null {
  if (_fallback !== undefined) return _fallback;
  const primaryName = (process.env['LLM_PROVIDER'] ?? 'anthropic').toLowerCase();
  if (process.env['LLM_FALLBACK'] === 'off') {
    _fallback = null;
  } else if (primaryName === 'gemini' && process.env['ANTHROPIC_API_KEY']) {
    _fallback = makeProvider('anthropic');
  } else if (primaryName !== 'gemini' && process.env['GEMINI_API_KEY']) {
    _fallback = makeProvider('gemini');
  } else {
    _fallback = null;
  }
  if (_fallback) console.info(`[llm] fallback disponible: ${_fallback.name}`);
  return _fallback;
}

/** Solo para tests / cambios en caliente. */
export function resetProvider(): void {
  _primary = null;
  _fallback = undefined;
}

/**
 * Arma el prompt, llama al proveedor activo y valida la salida con Zod.
 * Devuelve el AgentResponse tipado o un error.
 */
export async function generateAgentResponse(
  context: AgentContext,
  opts: GenerateOpts = {},
): Promise<Result<AgentResponse>> {
  const prompt = buildPrompt(context);

  const tryProvider = async (p: LlmProvider): Promise<Result<AgentResponse>> => {
    const raw = await p.complete(prompt);
    if (!raw.ok) return err(raw.error);

    const parsed = AgentResponseSchema.safeParse(raw.value);
    if (!parsed.success) {
      console.error(`[llm] ${p.name} salida inválida:`,
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · '),
        '\nraw:', JSON.stringify(raw.value).slice(0, 600));
      return err(new AgentError(`Respuesta de ${p.name} no cumple el esquema`, {}));
    }

    const r = parsed.data as AgentResponse;
    // Sin respuesta y sin derivación explícita = el modelo falló en serio.
    if (!r.respuesta.trim() && !r.fragmentos?.length && !r.pasar_a_humano) {
      console.error(`[llm] ${p.name} devolvió respuesta vacía sin pasar_a_humano. raw:`,
        JSON.stringify(raw.value).slice(0, 600));
      return err(new AgentError(`Respuesta de ${p.name} vacía`, {}));
    }
    // Coherencia: si hay fragmentos, respuesta = fragmentos unidos
    if (r.fragmentos?.length && r.respuesta.trim() !== r.fragmentos.join('\n\n').trim()) {
      r.respuesta = r.fragmentos.join('\n\n');
    }
    return ok(r);
  };

  const provider = getProvider();
  const fallback = getFallback();
  const isGemini = provider.name.startsWith('gemini:');

  let last = await tryProvider(provider);
  if (last.ok) return last;

  // Si el primario es Gemini y está SATURADO (no un error real), reintentar
  // según la paciencia permitida por el interés del lead.
  if (isGemini && opts.patient && isGeminiSaturation(last.error.message)) {
    const score = opts.interestScore ?? 0;
    const budget = score >= INTEREST_THRESHOLD ? WAIT_HIGH_MS : WAIT_LOW_MS;
    const deadline = Date.now() + budget;
    console.warn(`[llm] Gemini saturado · lead score ${score} → espero hasta ${Math.round(budget / 60000)} min`);

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, RETRY_EVERY_MS));
      last = await tryProvider(provider);
      if (last.ok) {
        console.info('[llm] Gemini se liberó, respondió');
        return last;
      }
      if (!isGeminiSaturation(last.error.message)) break; // error real → cortar
    }
    console.warn('[llm] se agotó la espera de Gemini → fallback');
  }

  // Fallback al otro proveedor
  if (fallback) {
    console.warn(`[llm] ${provider.name} falló (${last.error.message.slice(0, 100)}) → ${fallback.name}`);
    const alt = await tryProvider(fallback);
    if (alt.ok) return alt;
    console.error(`[llm] fallback también falló: ${alt.error.message.slice(0, 100)}`);
  }
  return last;
}
