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

let _provider: LlmProvider | null = null;

export function getProvider(): LlmProvider {
  if (_provider) return _provider;
  const name = (process.env['LLM_PROVIDER'] ?? 'anthropic').toLowerCase();
  _provider =
    name === 'gemini' ? createGeminiProvider() : createAnthropicProvider();
  console.info(`[llm] proveedor: ${_provider.name}`);
  return _provider;
}

/** Solo para tests / cambios en caliente. */
export function resetProvider(): void {
  _provider = null;
}

/**
 * Arma el prompt, llama al proveedor activo y valida la salida con Zod.
 * Devuelve el AgentResponse tipado o un error.
 */
export async function generateAgentResponse(
  context: AgentContext,
): Promise<Result<AgentResponse>> {
  const prompt = buildPrompt(context);
  const raw = await getProvider().complete(prompt);
  if (!raw.ok) return err(raw.error);

  const parsed = AgentResponseSchema.safeParse(raw.value);
  if (!parsed.success) {
    return err(new AgentError('Respuesta del LLM no cumple el esquema', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    }));
  }
  return ok(parsed.data as AgentResponse);
}
