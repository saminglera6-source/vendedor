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
import { createGeminiProvider } from './gemini.js';

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

  const primary = await tryProvider(getProvider());
  if (primary.ok) return primary;

  const fallback = getFallback();
  if (fallback) {
    console.warn(`[llm] primario falló (${primary.error.message.slice(0, 120)}) → probando ${fallback.name}`);
    const alt = await tryProvider(fallback);
    if (alt.ok) return alt;
    console.error(`[llm] fallback también falló: ${alt.error.message.slice(0, 120)}`);
  }
  return primary;
}
