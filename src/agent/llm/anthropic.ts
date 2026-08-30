/**
 * Proveedor Anthropic (Claude). Usa tool_use forzado con `responder_cliente`.
 * Aplica prompt caching vía el header beta.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ok, err, AgentError, type Result } from '../../types.js';
import type { BuiltPrompt } from '../prompt.js';
import { RESPONDER_CLIENTE_TOOL } from '../prompt.js';
import type { LlmProvider } from './provider.js';

let _client: Anthropic | null = null;

function client(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new AgentError('ANTHROPIC_API_KEY no definida', { env: 'ANTHROPIC_API_KEY' });
  _client = new Anthropic({
    apiKey,
    defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
  });
  return _client;
}

export function createAnthropicProvider(): LlmProvider {
  const model = process.env['AGENT_MODEL'] ?? 'claude-haiku-4-5';

  return {
    name: `anthropic:${model}`,
    async complete(prompt: BuiltPrompt): Promise<Result<Record<string, unknown>>> {
      try {
        const res = await client().messages.create({
          model,
          max_tokens: 768,
          system: prompt.system as Anthropic.TextBlockParam[],
          messages: prompt.messages,
          tools: prompt.tools as Anthropic.Tool[],
          tool_choice: { type: 'tool', name: RESPONDER_CLIENTE_TOOL.name },
        });

        const toolUse = res.content.find(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        if (!toolUse) {
          return err(new AgentError('Claude no devolvió tool_use', {
            stop_reason: res.stop_reason,
          }));
        }
        return ok(toolUse.input as Record<string, unknown>);
      } catch (error) {
        return err(new AgentError(
          `Error llamando a Anthropic: ${error instanceof Error ? error.message : String(error)}`,
          { model },
        ));
      }
    },
  };
}
