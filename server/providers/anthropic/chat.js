import { createTextChatHandler } from '../common/textChat.js';
import { invalidCalls } from '../common/textTools.js';
import { textInstructions } from '../common/textInstructions.js';
import { GEV_REALTIME_TOOLS, offeredTools } from '../openai/tools.js';
import { assistantShape, validMessages } from '../openai/chat.js';
import { resolveOverpassUpstreams } from '../overpass/constants.js';

// Claude backs typed chat behind the same browser wire format as OpenAI chat
// (Chat Completions messages), so the browser text loop is unchanged. This
// module translates that history to the Anthropic Messages API and the reply
// back. Thinking blocks are never replayed: the browser keeps only text and
// tool calls, and it trims and compacts history, which would fail the
// history-editing check on replayed thinking blocks.
export const ANTHROPIC_DEFAULT_PER_MIN = 30;
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const REFUSAL_TEXT = 'Claude declined this request.';

const parseArgs = (raw) => {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
};

/** OpenAI-format history (already validated) -> Anthropic messages. */
export function toAnthropicMessages(messages) {
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === 'user') {
      push('user', [{ type: 'text', text: message.content || ' ' }]);
    } else if (message.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: message.content || '{}',
        },
      ]);
    } else {
      const blocks = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls || [])
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseArgs(call.function.arguments),
        });
      push('assistant', blocks);
    }
  }
  return out;
}

const FINISH = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  refusal: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  pause_turn: 'length',
};

/** Anthropic Messages response -> OpenAI-shaped assistant message. */
export function fromAnthropicResponse(data) {
  if (data?.type !== 'message' || !Array.isArray(data.content)) return null;
  const text = data.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
  const toolCalls = data.content
    .filter((block) => block?.type === 'tool_use')
    .map((block) => ({
      id: String(block.id),
      type: 'function',
      function: {
        name: String(block.name),
        arguments: JSON.stringify(block.input ?? {}),
      },
    }));
  const refused = data.stop_reason === 'refusal';
  const content = {
    role: 'assistant',
    content: text || (refused || !toolCalls.length ? REFUSAL_TEXT : null),
    ...(toolCalls.length && !refused ? { tool_calls: toolCalls } : {}),
  };
  return { content, finishReason: FINISH[data.stop_reason] ?? 'stop' };
}

export function createAnthropicChatHandler({
  annotationGuidance,
  tools = GEV_REALTIME_TOOLS,
  overpassConfigured = () => resolveOverpassUpstreams().length > 0,
  resolveApiKey = () => process.env.ANTHROPIC_API_KEY,
  resolveChatModel = () =>
    process.env.ANTHROPIC_CHAT_MODEL || 'claude-opus-5-5',
  resolveEffort = () => process.env.ANTHROPIC_CHAT_EFFORT || 'low',
  resolveProviderRateLimit = () => process.env.GEV_RATELIMIT_ANTHROPIC_PER_MIN,
  ...options
} = {}) {
  return createTextChatHandler({
    timeoutMs: 85000,
    ...options,
    provider: 'anthropic',
    resolveApiKey,
    resolveProviderRateLimit,
    providerPerMin: ANTHROPIC_DEFAULT_PER_MIN,
    prepare(input) {
      const model = String(resolveChatModel()).trim();
      if (!/^claude-[a-z0-9.-]{1,100}$/.test(model))
        return { errorStatus: 503 };
      const effort = String(resolveEffort()).trim();
      if (
        !input ||
        typeof input !== 'object' ||
        Object.keys(input).some((key) => key !== 'messages') ||
        !validMessages(input.messages)
      )
        return null;
      const overpass = overpassConfigured();
      return {
        endpoint: ENDPOINT,
        headers: (key) => ({
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          // Re-runs a refused request on a fallback model inside the same call.
          'anthropic-beta': 'server-side-fallback-2026-07-01',
        }),
        body: {
          model,
          max_tokens: 16000,
          cache_control: { type: 'ephemeral' },
          system: textInstructions(annotationGuidance, { overpass }),
          tools: offeredTools(tools, { overpass }).map(
            ({ name, description, parameters }) => ({
              name,
              description,
              input_schema: parameters,
            }),
          ),
          messages: toAnthropicMessages(input.messages),
          ...(['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
            ? { output_config: { effort } }
            : {}),
          fallbacks: 'default',
        },
      };
    },
    parse(data) {
      const result = fromAnthropicResponse(data);
      if (!result || !assistantShape(result.content)) return null;
      const calls = (result.content.tool_calls || []).map((call) => ({
        name: call.function.name,
        args: JSON.parse(call.function.arguments),
      }));
      return {
        ...result,
        invalidCalls: invalidCalls(
          calls,
          offeredTools(tools, { overpass: overpassConfigured() }),
        ),
      };
    },
  });
}

/**
 * Which backend serves /api/openai/chat. GEV_CHAT_PROVIDER=anthropic|openai
 * pins it; otherwise an Anthropic key, when present, selects Claude.
 */
export function chatUsesAnthropic(environment = process.env) {
  const pinned = String(environment.GEV_CHAT_PROVIDER || '')
    .trim()
    .toLowerCase();
  if (pinned === 'openai') return false;
  if (pinned === 'anthropic') return true;
  return Boolean(String(environment.ANTHROPIC_API_KEY || '').trim());
}
