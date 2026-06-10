/**
 * Bedrock CAMP provider — config + stream function registration.
 *
 * Uses the Converse API with Bearer token auth instead of SigV4.
 * Issues a plain cross-origin fetch; CORS routing in CLI mode is handled
 * transparently by `llm-proxy-sw.ts` (rewrites to /api/fetch-proxy at
 * the SW layer). Extension mode bypasses CORS via host_permissions.
 * Registers as api: "bedrock-camp-converse" via pi-ai's registerApiProvider().
 *
 * Tracks pi-ai's `amazon-bedrock` provider (currently 0.74.0) where the
 * shapes overlap. The remaining intentional divergence is the transport:
 * non-streaming `POST /converse` over `fetch` versus pi's
 * `ConverseStreamCommand` over `@aws-sdk/client-bedrock-runtime`. Adopting
 * streaming would require parsing the `vnd.amazon.eventstream` framing
 * by hand; tracked as a follow-up.
 */

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  CacheRetention,
  Context,
  Model,
  ProviderResponse,
  SimpleStreamOptions,
  StreamOptions,
  ThinkingBudgets,
  ThinkingLevel,
} from '@earendil-works/pi-ai';
import {
  calculateCost,
  createAssistantMessageEventStream,
  registerApiProvider,
} from '@earendil-works/pi-ai';
import {
  adjustMaxTokensForThinking,
  buildBaseOptions,
  clampReasoning,
} from '@earendil-works/pi-ai/dist/providers/simple-options.js';
import { transformMessages } from '@earendil-works/pi-ai/dist/providers/transform-messages.js';
import {
  claudeSupportsAdaptiveThinking,
  claudeSupportsMaxEffort,
  claudeSupportsNativeXhighEffort,
} from '../claude-model-version.js';
import { modelSupportsTemperature } from '../temperature-support.js';
import type { ProviderConfig } from '../types.js';

export const config: ProviderConfig = {
  id: 'bedrock-camp',
  name: 'AWS Bedrock',
  description: 'Claude on AWS Bedrock via CAMP Bearer token',
  requiresApiKey: true,
  apiKeyPlaceholder: 'ABSK...',
  apiKeyEnvVar: 'BEDROCK_CAMP_API_KEY',
  requiresBaseUrl: true,
  baseUrlPlaceholder: 'https://bedrock-runtime.us-west-2.amazonaws.com',
  baseUrlDescription: 'Bedrock runtime endpoint from CAMP portal',
  defaultModelId: 'claude-sonnet-4-6',
};

// Picker filter: keep only Claude 4.x on an inference-profile prefix that
// is reachable from the configured endpoint region.
//
// 1. Inference profile (us./eu./global./apac.) — bare anthropic.* 400s with
//    "on-demand throughput isn't supported".
// 2. Claude 4.x only — older Claude 3.x are weaker at resisting prompt
//    injection; non-Claude Bedrock models (Nova, Llama, Writer, …) are
//    similarly risky, and DeepSeek R1 specifically 400s on toolConfig
//    ("This model doesn't support tool use") which breaks the agent loop.
// 3. Region must match the endpoint — e.g. `eu.*` IDs 400 with "invalid
//    model identifier" when sent to a `us-*` runtime, and vice versa.
//    `global.*` works anywhere.
const BEDROCK_CAMP_INFERENCE_PROFILE_RE = /^(us|eu|global|apac)\./;
const BEDROCK_CAMP_CLAUDE_4_RE = /\.anthropic\.claude-(opus|sonnet|haiku)-4/;
// Matches standard (us-east-1), FIPS (us-east-1-fips) and China
// (cn-north-1.amazonaws.com.cn) Bedrock runtime hosts.
const BEDROCK_RUNTIME_HOST_RE =
  /bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/i;

export function bedrockCampRegionFromBaseUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const { hostname } = new URL(baseUrl);
    return hostname.toLowerCase().match(BEDROCK_RUNTIME_HOST_RE)?.[1] ?? null;
  } catch {
    return null;
  }
}

function profileMatchesRegion(prefix: string, region: string): boolean {
  if (prefix === 'global') return true;
  if (prefix === 'us') return region.startsWith('us-');
  if (prefix === 'eu') return region.startsWith('eu-');
  if (prefix === 'apac') return region.startsWith('ap-');
  return false;
}

export function isBedrockCampCompatible(model: { id: string }, region?: string | null): boolean {
  if (!BEDROCK_CAMP_INFERENCE_PROFILE_RE.test(model.id)) return false;
  if (!BEDROCK_CAMP_CLAUDE_4_RE.test(model.id)) return false;
  if (!region) return true; // no endpoint configured yet — stay permissive
  const prefix = model.id.split('.', 1)[0];
  return profileMatchesRegion(prefix, region);
}

// `temperature` support is a model capability shared with the Adobe provider
// (both route Opus 4.7 / 4.8 to Bedrock, which rejects the param). The
// reject-list lives in ../temperature-support.ts so a new model is one edit.
function supportsTemperature(modelId: string, modelName?: string): boolean {
  return modelSupportsTemperature(modelId, modelName);
}

export type BedrockCampThinkingDisplay = 'summarized' | 'omitted';

type BedrockCampOnPayload = (
  payload: unknown,
  model: Model<Api>
) => unknown | undefined | Promise<unknown | undefined>;

type BedrockCampOnResponse = (
  response: ProviderResponse,
  model: Model<Api>
) => void | Promise<void>;

interface BedrockCampOptions extends Omit<StreamOptions, 'onPayload' | 'onResponse'> {
  onPayload?: BedrockCampOnPayload;
  onResponse?: BedrockCampOnResponse;
  toolChoice?: 'auto' | 'any' | 'none' | { type: 'tool'; name: string };
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
  /**
   * Controls how Claude's thinking content is returned (Opus 4.6+ / Mythos).
   * Defaults to "summarized" for parity with pi-ai's `amazon-bedrock`.
   */
  thinkingDisplay?: BedrockCampThinkingDisplay;
  /**
   * Send `anthropic_beta: ["interleaved-thinking-2025-05-14"]` for
   * non-adaptive Claude models that support extended thinking + tool use.
   * Defaults to true (matches pi-ai).
   */
  interleavedThinking?: boolean;
  /**
   * Key-value pairs attached to the inference request for cost allocation.
   * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
   */
  requestMetadata?: Record<string, string>;
}

type BedrockCampSimpleOptions = Omit<SimpleStreamOptions, 'onPayload' | 'onResponse'> & {
  onPayload?: BedrockCampOnPayload;
  onResponse?: BedrockCampOnResponse;
  toolChoice?: BedrockCampOptions['toolChoice'];
  thinkingDisplay?: BedrockCampThinkingDisplay;
  interleavedThinking?: boolean;
  requestMetadata?: Record<string, string>;
};

function pickCampExtras(
  options: BedrockCampSimpleOptions
): Pick<
  BedrockCampOptions,
  | 'onPayload'
  | 'onResponse'
  | 'toolChoice'
  | 'thinkingDisplay'
  | 'interleavedThinking'
  | 'requestMetadata'
> {
  return {
    onPayload: options.onPayload,
    onResponse: options.onResponse,
    toolChoice: options.toolChoice,
    thinkingDisplay: options.thinkingDisplay,
    interleavedThinking: options.interleavedThinking,
    requestMetadata: options.requestMetadata,
  };
}

// ── Model-name aware matching ───────────────────────────────────────
// Application inference profiles use opaque ARNs whose id does not contain
// the underlying model name. We check both `model.id` and `model.name`
// (when present), normalizing separators so e.g. "Claude Opus 4.6" matches
// "opus-4-6".

function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
  const values = modelName ? [modelId, modelName] : [modelId];
  return values.flatMap((value) => {
    const lower = value.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/g, '-')];
  });
}

// ── Message conversion ──────────────────────────────────────────────

function normalizeToolCallId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

function sanitize(text: string | undefined | null): string {
  if (!text) return '';
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD'
  );
}

function convertUserContentItem(c: any): any {
  if (c.type === 'text') return { text: sanitize(c.text) };
  if (c.type === 'image') return { image: createImageBlock(c.mimeType, c.data) };
  throw new Error(`Unknown user content type: ${c.type}`);
}

function convertUserMessage(m: any): any {
  const content =
    typeof m.content === 'string'
      ? [{ text: sanitize(m.content) }]
      : m.content.map(convertUserContentItem);
  return { role: 'user', content };
}

function thinkingBlockForModel(c: any, model: Model<Api>): any | null {
  if (c.thinking.trim().length === 0) return null;
  if (!supportsThinkingSignature(model)) {
    return { reasoningContent: { reasoningText: { text: sanitize(c.thinking) } } };
  }
  // Signatures arrive after thinking deltas. If a partial or externally
  // persisted message lacks a signature, Bedrock rejects the replayed
  // reasoning block. Fall back to plain text — matches pi-ai's
  // amazon-bedrock behavior.
  if (!c.thinkingSignature || c.thinkingSignature.trim().length === 0) {
    return { text: sanitize(c.thinking) };
  }
  return {
    reasoningContent: {
      reasoningText: {
        text: sanitize(c.thinking),
        signature: c.thinkingSignature,
      },
    },
  };
}

function convertAssistantContentItem(c: any, model: Model<Api>): any | null {
  switch (c.type) {
    case 'text':
      return c.text.trim().length === 0 ? null : { text: sanitize(c.text) };
    case 'toolCall':
      return { toolUse: { toolUseId: c.id, name: c.name, input: c.arguments } };
    case 'thinking':
      return thinkingBlockForModel(c, model);
    default:
      return null;
  }
}

function convertAssistantMessage(m: any, model: Model<Api>): any | null {
  if (m.content.length === 0) return null;
  const blocks: any[] = [];
  for (const c of m.content) {
    const block = convertAssistantContentItem(c, model);
    if (block !== null) blocks.push(block);
  }
  if (blocks.length === 0) return null;
  return { role: 'assistant', content: blocks };
}

function convertToolResultContentItem(c: any): any {
  return c.type === 'image'
    ? { image: createImageBlock(c.mimeType, c.data) }
    : { text: sanitize(c.text ?? c.json ?? JSON.stringify(c)) };
}

function buildToolResultEntry(m: any): any {
  return {
    toolResult: {
      toolUseId: m.toolCallId,
      content: m.content.map(convertToolResultContentItem),
      status: m.isError ? 'error' : 'success',
    },
  };
}

function coalesceToolResults(
  transformed: any[],
  startIndex: number
): { message: any; nextIndex: number } {
  const toolResults: any[] = [buildToolResultEntry(transformed[startIndex])];
  let j = startIndex + 1;
  while (j < transformed.length && transformed[j].role === 'toolResult') {
    toolResults.push(buildToolResultEntry(transformed[j]));
    j++;
  }
  return { message: { role: 'user', content: toolResults }, nextIndex: j - 1 };
}

function appendCachePointToLastUser(
  result: any[],
  model: Model<Api>,
  cacheRetention: CacheRetention
): void {
  if (cacheRetention === 'none' || !supportsPromptCaching(model) || result.length === 0) return;
  const lastMessage = result[result.length - 1];
  if (lastMessage.role === 'user' && Array.isArray(lastMessage.content)) {
    lastMessage.content.push(buildCachePoint(cacheRetention));
  }
}

function convertMessages(
  context: Context,
  model: Model<Api>,
  cacheRetention: CacheRetention
): any[] {
  const result: any[] = [];
  const transformed = transformMessages(context.messages, model, normalizeToolCallId);

  for (let i = 0; i < transformed.length; i++) {
    const m = transformed[i];
    if (m.role === 'user') {
      result.push(convertUserMessage(m));
    } else if (m.role === 'assistant') {
      const converted = convertAssistantMessage(m, model);
      if (converted !== null) result.push(converted);
    } else if (m.role === 'toolResult') {
      const { message, nextIndex } = coalesceToolResults(transformed, i);
      result.push(message);
      i = nextIndex;
    }
  }

  appendCachePointToLastUser(result, model, cacheRetention);
  return result;
}

function createImageBlock(
  mime: string,
  data: string
): { source: { bytes: string }; format: string } {
  return { source: { bytes: data }, format: mimeToFormat(mime) };
}

function mimeToFormat(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpeg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      throw new Error(`Unsupported image MIME type: ${mime}`);
  }
}

function supportsThinkingSignature(model: Model<Api>): boolean {
  return isAnthropicClaudeModel(model);
}

// Adaptive thinking is the `thinking:{type:"adaptive"}` + `output_config.effort`
// shape Claude Opus and Sonnet ship at version ≥ 4.6. Older Claude 4.x models
// stay on legacy `thinking.type=enabled` with a token budget. Delegates to the
// shared `claude-model-version` helper so new releases (Opus 4.9, Sonnet 4.7,
// future 5.x) work automatically.
function supportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
  return claudeSupportsAdaptiveThinking(modelId, modelName);
}

// Opus introduced a native `effort: "xhigh"` tier above `high` at 4.7 (and
// later releases inherit it). Opus 4.6 clamps xhigh to `"max"`. Anything else
// clamps to `"high"`.
function supportsNativeXhighEffort(modelId: string, modelName?: string): boolean {
  return claudeSupportsNativeXhighEffort(modelId, modelName);
}

function supportsMaxEffort(modelId: string, modelName?: string): boolean {
  return claudeSupportsMaxEffort(modelId, modelName);
}

// ── Tool config ─────────────────────────────────────────────────────

function convertToolConfig(
  tools: Context['tools'],
  toolChoice?: BedrockCampOptions['toolChoice']
): any | undefined {
  if (!tools?.length || toolChoice === 'none') return undefined;
  const bedrockTools = tools.map((t) => ({
    toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } },
  }));
  let choice: any;
  switch (toolChoice) {
    case 'auto':
      choice = { auto: {} };
      break;
    case 'any':
      choice = { any: {} };
      break;
    default:
      if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'tool') {
        choice = { tool: { name: toolChoice.name } };
      }
  }
  return { tools: bedrockTools, toolChoice: choice };
}

// ── Thinking / reasoning fields ─────────────────────────────────────

function mapThinkingLevelToEffort(
  level: ThinkingLevel | undefined,
  modelId: string,
  modelName?: string
): string {
  if (level === 'xhigh' && supportsNativeXhighEffort(modelId, modelName)) return 'xhigh';
  switch (level) {
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return supportsMaxEffort(modelId, modelName) ? 'max' : 'high';
    default:
      return 'high';
  }
}

// GovCloud Bedrock currently rejects the Claude `thinking.display` field
// and is detected either by region (us-gov-*) or by model id prefix.
function isGovCloudTarget(model: Model<Api>): boolean {
  const region = bedrockCampRegionFromBaseUrl(model.baseUrl);
  if (region?.toLowerCase().startsWith('us-gov-')) return true;
  const id = model.id.toLowerCase();
  return id.startsWith('us-gov.') || id.startsWith('arn:aws-us-gov:');
}

function buildAdditionalModelRequestFields(
  model: Model<Api>,
  options: BedrockCampOptions
): Record<string, unknown> | undefined {
  if (!options.reasoning || !model.reasoning) return undefined;
  if (!isAnthropicClaudeModel(model)) return undefined;

  const display = isGovCloudTarget(model) ? undefined : (options.thinkingDisplay ?? 'summarized');

  if (supportsAdaptiveThinking(model.id, model.name)) {
    const adaptive: Record<string, unknown> = {
      thinking: { type: 'adaptive', ...(display !== undefined ? { display } : {}) },
      output_config: { effort: mapThinkingLevelToEffort(options.reasoning, model.id, model.name) },
    };
    return adaptive;
  }

  const defaults: Record<string, number> = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
    xhigh: 16384,
  };
  const level = options.reasoning === 'xhigh' ? 'high' : options.reasoning;
  const budget =
    options.thinkingBudgets?.[level as keyof ThinkingBudgets] ?? defaults[options.reasoning];
  const legacy: Record<string, unknown> = {
    thinking: {
      type: 'enabled',
      budget_tokens: budget,
      ...(display !== undefined ? { display } : {}),
    },
  };
  if (options.interleavedThinking ?? true) {
    legacy.anthropic_beta = ['interleaved-thinking-2025-05-14'];
  }
  return legacy;
}

// ── Prompt caching ─────────────────────────────────────────────────

function isAnthropicClaudeModel(model: Model<Api>): boolean {
  const id = model.id.toLowerCase();
  const name = model.name?.toLowerCase() ?? '';
  return (
    id.includes('anthropic.claude') ||
    id.includes('anthropic/claude') ||
    name.includes('anthropic.claude') ||
    name.includes('anthropic/claude') ||
    name.includes('claude')
  );
}

function supportsPromptCaching(model: Model<Api>): boolean {
  const candidates = getModelMatchCandidates(model.id, model.name);
  if (!candidates.some((s) => s.includes('claude'))) return false;
  if (candidates.some((s) => s.includes('-4-'))) return true;
  if (candidates.some((s) => s.includes('claude-3-7-sonnet'))) return true;
  if (candidates.some((s) => s.includes('claude-3-5-haiku'))) return true;
  return false;
}

function buildCachePoint(cacheRetention: CacheRetention): Record<string, unknown> {
  return {
    cachePoint: {
      type: 'default',
      ...(cacheRetention === 'long' ? { ttl: '1h' } : {}),
    },
  };
}

// ── System prompt ───────────────────────────────────────────────────

function buildSystemPrompt(
  systemPrompt: string | undefined,
  model: Model<Api>,
  cacheRetention: CacheRetention
): any[] | undefined {
  if (!systemPrompt) return undefined;
  const blocks: any[] = [{ text: sanitize(systemPrompt) }];
  if (cacheRetention !== 'none' && supportsPromptCaching(model)) {
    blocks.push(buildCachePoint(cacheRetention));
  }
  return blocks;
}

// ── Stop reason mapping ─────────────────────────────────────────────

function mapStopReason(reason: string): 'stop' | 'length' | 'toolUse' | 'error' {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'toolUse';
    default:
      return 'error';
  }
}

// ── Error formatting ────────────────────────────────────────────────
// Stable human-readable prefixes mirror pi-ai's BEDROCK_ERROR_PREFIXES so
// downstream retry classification (`server.?error`, `service.?unavailable`,
// `throttl(?:ing|e)`) keeps working over CAMP.
function formatHttpError(status: number, body: string): string {
  let prefix = `Bedrock CAMP API error (${status})`;
  if (status === 429) prefix = `Throttling error: ${prefix}`;
  else if (status === 503) prefix = `Service unavailable: ${prefix}`;
  else if (status === 502 || status === 504) prefix = `Internal server error: ${prefix}`;
  else if (status >= 500) prefix = `Internal server error: ${prefix}`;
  else if (status === 400) prefix = `Validation error: ${prefix}`;
  return `${prefix}: ${body}`;
}

// ── Response parsing (non-streaming /converse) ──────────────────────

function parseConverseResponse(
  body: any,
  model: Model<Api>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream
): void {
  stream.push({ type: 'start', partial: output });

  const message = body.output?.message;
  if (message?.content) {
    for (let i = 0; i < message.content.length; i++) {
      const block = message.content[i];
      if (block.text !== undefined) {
        const textBlock = { type: 'text' as const, text: block.text };
        output.content.push(textBlock);
        const idx = output.content.length - 1;
        stream.push({ type: 'text_start', contentIndex: idx, partial: output });
        stream.push({ type: 'text_delta', contentIndex: idx, delta: block.text, partial: output });
        stream.push({ type: 'text_end', contentIndex: idx, content: block.text, partial: output });
      } else if (block.toolUse) {
        const toolBlock = {
          type: 'toolCall' as const,
          id: block.toolUse.toolUseId || '',
          name: block.toolUse.name || '',
          arguments: block.toolUse.input || {},
        };
        output.content.push(toolBlock);
        const idx = output.content.length - 1;
        stream.push({ type: 'toolcall_start', contentIndex: idx, partial: output });
        stream.push({
          type: 'toolcall_end',
          contentIndex: idx,
          toolCall: toolBlock,
          partial: output,
        });
      } else if (block.reasoningContent?.reasoningText) {
        const thinkingBlock = {
          type: 'thinking' as const,
          thinking: block.reasoningContent.reasoningText.text || '',
          thinkingSignature: block.reasoningContent.reasoningText.signature || '',
        };
        output.content.push(thinkingBlock);
        const idx = output.content.length - 1;
        stream.push({ type: 'thinking_start', contentIndex: idx, partial: output });
        stream.push({
          type: 'thinking_delta',
          contentIndex: idx,
          delta: thinkingBlock.thinking,
          partial: output,
        });
        stream.push({
          type: 'thinking_end',
          contentIndex: idx,
          content: thinkingBlock.thinking,
          partial: output,
        });
      }
    }
  }

  // Usage
  if (body.usage) {
    output.usage.input = body.usage.inputTokens || 0;
    output.usage.output = body.usage.outputTokens || 0;
    output.usage.cacheRead = body.usage.cacheReadInputTokens || 0;
    output.usage.cacheWrite = body.usage.cacheWriteInputTokens || 0;
    output.usage.totalTokens = body.usage.totalTokens || output.usage.input + output.usage.output;
    calculateCost(model, output.usage);
  }

  // Stop reason
  output.stopReason = mapStopReason(body.stopReason || 'end_turn');
}

function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
  return cacheRetention ?? 'short';
}

function extractResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

// ── Stream function ─────────────────────────────────────────────────

function createInitialOutput(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'bedrock-camp-converse' as Api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function buildInferenceConfig(
  model: Model<Api>,
  options: BedrockCampOptions
): Record<string, unknown> {
  const inferenceConfig: Record<string, unknown> = {};
  if (options.maxTokens !== undefined) inferenceConfig.maxTokens = options.maxTokens;
  if (options.temperature !== undefined && supportsTemperature(model.id, model.name)) {
    inferenceConfig.temperature = options.temperature;
  }
  return inferenceConfig;
}

function buildConverseRequestBody(
  model: Model<Api>,
  context: Context,
  options: BedrockCampOptions,
  cacheRetention: CacheRetention
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    modelId: model.id,
    messages: convertMessages(context, model, cacheRetention),
    system: buildSystemPrompt(context.systemPrompt, model, cacheRetention),
    inferenceConfig: buildInferenceConfig(model, options),
    toolConfig: convertToolConfig(context.tools, options.toolChoice),
    additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
    ...(options.requestMetadata !== undefined ? { requestMetadata: options.requestMetadata } : {}),
  };

  // Remove undefined fields
  if (!body.system) delete body.system;
  if (!body.toolConfig) delete body.toolConfig;
  if (!body.additionalModelRequestFields) delete body.additionalModelRequestFields;

  return body;
}

async function applyOnPayloadHook(
  body: Record<string, unknown>,
  model: Model<Api>,
  options: BedrockCampOptions
): Promise<Record<string, unknown>> {
  if (!options.onPayload) return body;
  const replacement = await options.onPayload(body, model);
  return replacement !== undefined ? (replacement as Record<string, unknown>) : body;
}

async function performConverseFetch(
  targetUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  model: Model<Api>,
  options: BedrockCampOptions
): Promise<Response> {
  // CORS routing in CLI mode is handled transparently by
  // `llm-proxy-sw.ts` — cross-origin fetches from the page get
  // rewritten to /api/fetch-proxy with the X-Target-URL header at
  // the SW layer. Extension mode bypasses CORS via host_permissions
  // and never registers the SW, so a direct fetch works there too.
  // Either way, this provider issues a plain fetch and lets the
  // platform handle transport.
  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...(options.headers ?? {}),
  };
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (options.onResponse) {
    await options.onResponse(
      { status: response.status, headers: extractResponseHeaders(response) },
      model
    );
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(formatHttpError(response.status, errorText));
  }

  return response;
}

function handleStreamError(
  error: unknown,
  output: AssistantMessage,
  options: BedrockCampOptions,
  stream: AssistantMessageEventStream
): void {
  for (const block of output.content) {
    delete (block as any).index;
    delete (block as any).partialJson;
  }
  output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
  output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
  stream.push({ type: 'error', reason: output.stopReason, error: output });
  stream.end();
}

async function runConverseRequest(
  model: Model<Api>,
  context: Context,
  options: BedrockCampOptions,
  output: AssistantMessage,
  stream: AssistantMessageEventStream
): Promise<void> {
  const apiKey = options.apiKey;
  if (!apiKey) throw new Error('API key is required for Bedrock CAMP');

  const baseUrl = model.baseUrl;
  if (!baseUrl) throw new Error('Base URL is required for Bedrock CAMP');

  const cacheRetention = resolveCacheRetention(options.cacheRetention);

  let body = buildConverseRequestBody(model, context, options, cacheRetention);
  body = await applyOnPayloadHook(body, model, options);

  // Build URL: POST {baseUrl}/model/{modelId}/converse
  const targetUrl = `${baseUrl.replace(/\/$/, '')}/model/${model.id}/converse`;

  const response = await performConverseFetch(targetUrl, apiKey, body, model, options);

  const responseBody = await response.json();
  parseConverseResponse(responseBody, model, output, stream);

  if (output.stopReason === 'error' || output.stopReason === 'aborted') {
    throw new Error('An unknown error occurred');
  }
  stream.push({ type: 'done', reason: output.stopReason, message: output });
  stream.end();
}

export const streamBedrockCamp = (
  model: Model<Api>,
  context: Context,
  options: BedrockCampOptions = {}
): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output = createInitialOutput(model);
    try {
      await runConverseRequest(model, context, options, output, stream);
    } catch (error) {
      handleStreamError(error, output, options, stream);
    }
  })();

  return stream;
};

// ── Simple stream wrapper ───────────────────────────────────────────

export const streamSimpleBedrockCamp = (
  model: Model<Api>,
  context: Context,
  options?: BedrockCampSimpleOptions
): AssistantMessageEventStream => {
  const base = buildBaseOptions(model, options, undefined);
  const extras = options ? pickCampExtras(options) : {};
  if (!options?.reasoning) {
    return streamBedrockCamp(model, context, { ...base, ...extras, reasoning: undefined });
  }
  if (isAnthropicClaudeModel(model)) {
    if (supportsAdaptiveThinking(model.id, model.name)) {
      return streamBedrockCamp(model, context, {
        ...base,
        ...extras,
        reasoning: options.reasoning,
        thinkingBudgets: options.thinkingBudgets,
      });
    }
    const adjusted = adjustMaxTokensForThinking(
      base.maxTokens || 0,
      model.maxTokens,
      options.reasoning,
      options.thinkingBudgets
    );
    return streamBedrockCamp(model, context, {
      ...base,
      ...extras,
      maxTokens: adjusted.maxTokens,
      reasoning: options.reasoning,
      thinkingBudgets: {
        ...(options.thinkingBudgets || {}),
        [clampReasoning(options.reasoning)!]: adjusted.budgetTokens,
      },
    });
  }
  return streamBedrockCamp(model, context, {
    ...base,
    ...extras,
    reasoning: options.reasoning,
    thinkingBudgets: options.thinkingBudgets,
  });
};

// ── Registration ────────────────────────────────────────────────────

export function register(): void {
  registerApiProvider({
    api: 'bedrock-camp-converse' as Api,
    stream: streamBedrockCamp,
    streamSimple: streamSimpleBedrockCamp,
  });
}
