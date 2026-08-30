/**
 * Proveedor Google Gemini.
 *
 * Gemini no tiene el mismo tool_use forzado que Claude, así que se usa modo
 * JSON (`responseMimeType: application/json`) + el contrato de salida en el
 * system instruction. La validación con Zod (en generateAgentResponse) es la
 * red de seguridad.
 *
 * El prompt se arma con shape Anthropic; acá se traduce:
 *  - system blocks  → systemInstruction (texto concatenado) + JSON_CONTRACT
 *  - messages       → contents (role 'assistant' → 'model')
 *  - tools          → se ignoran (el contrato va en el system instruction)
 */

import { GoogleGenAI } from '@google/genai';

// Timeout corto a propósito: si Gemini está lento, cortamos y decide el orquestador.
const REQUEST_TIMEOUT_MS = Number(process.env['GEMINI_TIMEOUT_MS'] ?? 15_000);

/** ¿El error es por saturación de Gemini (temporal, vale la pena reintentar)? */
export function isGeminiSaturation(msg: string): boolean {
  return /\b503\b|\b429\b|UNAVAILABLE|overloaded|high demand|timed?\s*out|abort|ETIMEDOUT|RESOURCE_EXHAUSTED/i.test(msg);
}
import { ok, err, AgentError, type Result } from '../../types.js';
import type { BuiltPrompt } from '../prompt.js';
import { type LlmProvider, JSON_CONTRACT } from './provider.js';

let _client: GoogleGenAI | null = null;

function client(): GoogleGenAI {
  if (_client) return _client;
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) throw new AgentError('GEMINI_API_KEY no definida', { env: 'GEMINI_API_KEY' });
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

function stripFences(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1]!.trim() : t;
}

export function createGeminiProvider(): LlmProvider {
  const model = process.env['GEMINI_MODEL'] ?? 'gemini-2.5-flash';

  return {
    name: `gemini:${model}`,
    async complete(prompt: BuiltPrompt): Promise<Result<Record<string, unknown>>> {
      try {
        const systemText =
          prompt.system
            .map((b) => (typeof b.text === 'string' ? b.text : ''))
            .filter(Boolean)
            .join('\n\n') +
          '\n\n' +
          JSON_CONTRACT;

        const contents = prompt.messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
        }));

        // Un solo intento con timeout corto. La estrategia de reintentos/espera
        // (según interés del lead) la maneja generateAgentResponse.
        const res = await client().models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: systemText,
            responseMimeType: 'application/json',
            temperature: 0.7,
            maxOutputTokens: 4096,
            abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            httpOptions: { timeout: REQUEST_TIMEOUT_MS },
          },
        });

        const finish = res.candidates?.[0]?.finishReason;
        const raw = stripFences(res.text ?? '');
        if (!raw) {
          return err(new AgentError('Gemini devolvió respuesta vacía', { model, finish }));
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return err(new AgentError('Gemini devolvió JSON inválido', {
            model,
            finish,
            raw: raw.slice(0, 500),
          }));
        }
        return ok(parsed as Record<string, unknown>);
      } catch (error) {
        return err(new AgentError(
          `Error llamando a Gemini: ${error instanceof Error ? error.message : String(error)}`,
          { model },
        ));
      }
    },
  };
}
