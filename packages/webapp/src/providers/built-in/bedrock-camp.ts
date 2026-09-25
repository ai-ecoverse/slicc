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
  ToolCall,
} from '@earendil-works/pi-ai';
import {
  calculateCost,
  createAssistantMessageEventStream,
  registerApiProvider,
} from '@earendil-works/pi-ai/compat';
import {
  adjustMaxTokensForThinking,
  buildBaseOptions,
  clampReasoning,
} from '@earendil-works/pi-ai/dist/api/simple-options.js';
import { transformMessages } from '@earendil-works/pi-ai/dist/api/transform-messages.js';
import {
  claudeSupportsAdaptiveThinking,
  claudeSupportsMaxEffort,
  claudeSupportsNativeXhighEffort,
  claudeSupportsPromptCaching,
} from '../claude-model-version.js';
import { modelSupportsTemperature } from '../temperature-support.js';
import type { ProviderConfig } from '../types.js';
import { type BedrockCampEffortMap, bedrockCampOpenAIEffortMap } from './bedrock-camp-compat.js';

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
  defaultModelId: 'claude-opus-5-5',
};

const BEDROCK_CAMP_INFERENCE_PROFILE_RE = /^(us|eu|global|apac|au|jp)\./;
const BEDROCK_CAMP_CLAUDE_RE = /\.anthropic\.claude-(opus|sonnet|haiku|fable)-(?:[4-9]|\d\d)/;

const BEDROCK_CAMP_ALLOWED_NON_CLAUDE_RE =
  /\.(?:openai\.(?:gpt-5\.6-(?:sol|terra|luna)|gpt-6-(?:sol|luna|astra))|moonshotai\.kimi-k3)$/;

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

const JP_REGIONS = new Set(['ap-northeast-1', 'ap-northeast-3']);
const AU_REGIONS = new Set(['ap-southeast-2', 'ap-southeast-4']);

function profileMatchesRegion(prefix: string, region: string): boolean {
  if (prefix === 'global') return true;
  if (prefix === 'us') return region.startsWith('us-');
  if (prefix === 'eu') return region.startsWith('eu-');
  if (prefix === 'apac') return region.startsWith('ap-');
  if (prefix === 'jp') return JP_REGIONS.has(region);
  if (prefix === 'au') return AU_REGIONS.has(region);
  return false;
}

export function isBedrockCampCompatible(model: { id: string }, region?: string | null): boolean {
  if (!BEDROCK_CAMP_INFERENCE_PROFILE_RE.test(model.id)) return false;
  if (
    !BEDROCK_CAMP_CLAUDE_RE.test(model.id) &&
    !BEDROCK_CAMP_ALLOWED_NON_CLAUDE_RE.test(model.id)
  ) {
    return false;
  }
  if (!region) return true;
  const prefix = model.id.split('.', 1)[0];
  return profileMatchesRegion(prefix, region);
}

function supportsTemperature(modelId: string, modelName?: string): boolean {
  return modelSupportsTemperature(modelId, modelName);
}

export type BedrockCampThinkingDisplay = 'summarized' | 'omitted';

type BedrockCampImageSource = {
  source: { bytes: string };
  format: string;
};

type BedrockCampTextBlock = { text: string };
type BedrockCampImageBlock = { image: BedrockCampImageSource };
type BedrockCampCachePoint = {
  cachePoint: { type: 'default'; ttl?: '1h' };
};
type BedrockCampReasoningBlock = {
  reasoningContent: {
    reasoningText: {
      text: string;
      signature?: string;
    };
  };
};
type BedrockCampToolUseBlock = {
  toolUse: {
    toolUseId: string;
    name: string;
    input: ToolCall['arguments'];
  };
};

type BedrockCampContentBlock =
  | BedrockCampTextBlock
  | BedrockCampImageBlock
  | BedrockCampReasoningBlock
  | BedrockCampToolUseBlock
  | BedrockCampCachePoint;

type BedrockCampToolResultContent = BedrockCampTextBlock | BedrockCampImageBlock;

type BedrockCampToolResultBlock = {
  toolResult: {
    toolUseId: string;
    content: BedrockCampToolResultContent[];
    status: 'error' | 'success';
  };
};

type BedrockCampUserMessageContent = BedrockCampContentBlock | BedrockCampToolResultBlock;

type BedrockCampUserMessage = {
  role: 'user';
  content: BedrockCampUserMessageContent[];
};

type BedrockCampAssistantMessage = {
  role: 'assistant';
  content: BedrockCampContentBlock[];
};

type BedrockCampConvertedMessage = BedrockCampUserMessage | BedrockCampAssistantMessage;

type BedrockCampSystemBlock = BedrockCampTextBlock | BedrockCampCachePoint;

type BedrockCampToolChoice =
  | { auto: Record<string, never> }
  | { any: Record<string, never> }
  | { tool: { name: string } };

type BedrockCampToolConfig = {
  tools: Array<{
    toolSpec: {
      name: string;
      description: string;
      inputSchema: { json: NonNullable<Context['tools']>[number]['parameters'] };
    };
  }>;
  toolChoice?: BedrockCampToolChoice;
};

type BedrockCampAdaptiveFields = {
  thinking: {
    type: 'adaptive';
    display?: BedrockCampThinkingDisplay;
  };
  output_config: { effort: string };
};

type BedrockCampLegacyThinkingFields = {
  thinking: {
    type: 'enabled';
    budget_tokens: number;
    display?: BedrockCampThinkingDisplay;
  };
  anthropic_beta?: ['interleaved-thinking-2025-05-14'];
};

type BedrockCampOpenAIReasoningFields = {
  reasoning: { effort: string };
};

type BedrockCampAdditionalModelRequestFields =
  | BedrockCampAdaptiveFields
  | BedrockCampLegacyThinkingFields
  | BedrockCampOpenAIReasoningFields;

type BedrockCampInferenceConfig = {
  maxTokens?: number;
  temperature?: number;
};

type BedrockCampConverseRequestBody = {
  modelId: string;
  messages: BedrockCampConvertedMessage[];
  system?: BedrockCampSystemBlock[];
  inferenceConfig: BedrockCampInferenceConfig;
  toolConfig?: BedrockCampToolConfig;
  additionalModelRequestFields?: BedrockCampAdditionalModelRequestFields;
  requestMetadata?: Record<string, string>;
};

type BedrockCampConverseContentBlock = {
  text?: string;
  toolUse?: {
    toolUseId?: string;
    name?: string;
    input?: ToolCall['arguments'];
  };
  reasoningContent?: {
    reasoningText?: {
      text?: string;
      signature?: string;
    };
  };
};

type BedrockCampConverseResponse = {
  output?: {
    message?: {
      content?: BedrockCampConverseContentBlock[];
    };
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
    totalTokens?: number;
  };
  stopReason?: string;
};

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

  thinkingDisplay?: BedrockCampThinkingDisplay;

  interleavedThinking?: boolean;

  requestMetadata?: Record<string, string>;

  effort?: string;
}

type BedrockCampSimpleOptions = Omit<SimpleStreamOptions, 'onPayload' | 'onResponse'> & {
  onPayload?: BedrockCampOnPayload;
  onResponse?: BedrockCampOnResponse;
  toolChoice?: BedrockCampOptions['toolChoice'];
  thinkingDisplay?: BedrockCampThinkingDisplay;
  interleavedThinking?: boolean;
  requestMetadata?: Record<string, string>;
  effort?: string;
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
  | 'effort'
> {
  return {
    onPayload: options.onPayload,
    onResponse: options.onResponse,
    toolChoice: options.toolChoice,
    thinkingDisplay: options.thinkingDisplay,
    interleavedThinking: options.interleavedThinking,
    requestMetadata: options.requestMetadata,
    effort: options.effort,
  };
}

function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
  const values = modelName ? [modelId, modelName] : [modelId];
  return values.flatMap((value) => {
    const lower = value.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/g, '-')];
  });
}

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

function convertUserContentItem(content: unknown): BedrockCampContentBlock {
  const item = content as { type?: string; text?: string; mimeType?: string; data?: string };
  if (item.type === 'text') return { text: sanitize(item.text) };
  if (item.type === 'image')
    return { image: createImageBlock(item.mimeType ?? '', item.data ?? '') };
  throw new Error(`Unknown user content type: ${item.type ?? 'unknown'}`);
}

function convertUserMessage(m: { content: string | unknown[] }): BedrockCampUserMessage {
  const content =
    typeof m.content === 'string'
      ? [{ text: sanitize(m.content) }]
      : m.content.map(convertUserContentItem);
  return { role: 'user', content };
}

function thinkingBlockForModel(
  content: { thinking?: string; thinkingSignature?: string },
  model: Model<Api>
): BedrockCampContentBlock | null {
  const thinking = content.thinking ?? '';
  if (thinking.trim().length === 0) return null;
  if (!supportsThinkingSignature(model)) {
    return { reasoningContent: { reasoningText: { text: sanitize(thinking) } } };
  }

  if (!content.thinkingSignature || content.thinkingSignature.trim().length === 0) {
    return { text: sanitize(thinking) };
  }
  return {
    reasoningContent: {
      reasoningText: {
        text: sanitize(thinking),
        signature: content.thinkingSignature,
      },
    },
  };
}

function convertAssistantContentItem(
  content: unknown,
  model: Model<Api>
): BedrockCampContentBlock | null {
  const item = content as {
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    arguments?: ToolCall['arguments'];
    thinking?: string;
    thinkingSignature?: string;
  };
  switch (item.type) {
    case 'text':
      return (item.text ?? '').trim().length === 0 ? null : { text: sanitize(item.text ?? '') };
    case 'toolCall':
      return {
        toolUse: { toolUseId: item.id ?? '', name: item.name ?? '', input: item.arguments ?? {} },
      };
    case 'thinking':
      return thinkingBlockForModel(item, model);
    default:
      return null;
  }
}

function convertAssistantMessage(
  m: { content: unknown[] },
  model: Model<Api>
): BedrockCampAssistantMessage | null {
  if (m.content.length === 0) return null;
  const blocks: BedrockCampContentBlock[] = [];
  for (const c of m.content) {
    const block = convertAssistantContentItem(c, model);
    if (block !== null) blocks.push(block);
  }
  if (blocks.length === 0) return null;
  return { role: 'assistant', content: blocks };
}

function convertToolResultContentItem(content: unknown): BedrockCampToolResultContent {
  const item = content as {
    type?: string;
    mimeType?: string;
    data?: string;
    text?: string;
    json?: unknown;
  };
  return item.type === 'image'
    ? { image: createImageBlock(item.mimeType ?? '', item.data ?? '') }
    : {
        text: sanitize(
          item.text ??
            (typeof item.json === 'string' ? item.json : JSON.stringify(item.json ?? item))
        ),
      };
}

function buildToolResultEntry(m: {
  toolCallId?: string;
  content: unknown[];
  isError?: boolean;
}): BedrockCampToolResultBlock {
  return {
    toolResult: {
      toolUseId: m.toolCallId ?? '',
      content: m.content.map(convertToolResultContentItem),
      status: m.isError ? 'error' : 'success',
    },
  };
}

function coalesceToolResults(
  transformed: Array<{ role: string; content: unknown[]; toolCallId?: string; isError?: boolean }>,
  startIndex: number
): {
  message: BedrockCampUserMessage;
  nextIndex: number;
} {
  const toolResults = [buildToolResultEntry(transformed[startIndex])];
  let j = startIndex + 1;
  while (j < transformed.length && transformed[j].role === 'toolResult') {
    toolResults.push(buildToolResultEntry(transformed[j]));
    j++;
  }
  return { message: { role: 'user', content: toolResults }, nextIndex: j - 1 };
}

function appendCachePointToLastUser(
  result: BedrockCampConvertedMessage[],
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
): BedrockCampConvertedMessage[] {
  const result: BedrockCampConvertedMessage[] = [];
  const transformed = transformMessages(context.messages, model, normalizeToolCallId) as Array<{
    role: string;
    content: unknown[];
    toolCallId?: string;
    isError?: boolean;
  }>;

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

function createImageBlock(mime: string, data: string): BedrockCampImageSource {
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

function supportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
  return claudeSupportsAdaptiveThinking(modelId, modelName);
}

function supportsNativeXhighEffort(modelId: string, modelName?: string): boolean {
  return claudeSupportsNativeXhighEffort(modelId, modelName);
}

function supportsMaxEffort(modelId: string, modelName?: string): boolean {
  return claudeSupportsMaxEffort(modelId, modelName);
}

function convertToolConfig(
  tools: Context['tools'],
  toolChoice?: BedrockCampOptions['toolChoice']
): BedrockCampToolConfig | undefined {
  if (!tools?.length || toolChoice === 'none') return undefined;
  const bedrockTools = tools.map((t) => ({
    toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } },
  }));
  let choice: BedrockCampToolChoice | undefined;
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

function isGovCloudTarget(model: Model<Api>): boolean {
  const region = bedrockCampRegionFromBaseUrl(model.baseUrl);
  if (region?.toLowerCase().startsWith('us-gov-')) return true;
  const id = model.id.toLowerCase();
  return id.startsWith('us-gov.') || id.startsWith('arn:aws-us-gov:');
}

const OPENAI_EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function openAIReasoningEffort(
  map: BedrockCampEffortMap,
  options: BedrockCampOptions
): string | undefined {
  if (!options.reasoning) return map.off ?? undefined;
  if (options.effort === 'max' && map.max) return map.max;
  const start = OPENAI_EFFORT_ORDER.indexOf(options.reasoning);
  for (const level of OPENAI_EFFORT_ORDER.slice(Math.max(start, 0))) {
    const mapped = map[level];
    if (mapped) return mapped;
  }
  return undefined;
}

function buildAdditionalModelRequestFields(
  model: Model<Api>,
  options: BedrockCampOptions
): BedrockCampAdditionalModelRequestFields | undefined {
  const effortMap = bedrockCampOpenAIEffortMap(model);
  if (effortMap) {
    const effort = openAIReasoningEffort(effortMap, options);
    return effort === undefined ? undefined : { reasoning: { effort } };
  }
  if (!options.reasoning || !model.reasoning) return undefined;
  if (!isAnthropicClaudeModel(model)) return undefined;

  const display = isGovCloudTarget(model) ? undefined : (options.thinkingDisplay ?? 'summarized');

  if (supportsAdaptiveThinking(model.id, model.name)) {
    const adaptive: BedrockCampAdaptiveFields = {
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
  const legacy: BedrockCampLegacyThinkingFields = {
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
  return claudeSupportsPromptCaching(model.id, model.name);
}

function buildCachePoint(cacheRetention: CacheRetention): BedrockCampCachePoint {
  return {
    cachePoint: {
      type: 'default',
      ...(cacheRetention === 'long' ? { ttl: '1h' } : {}),
    },
  };
}

function buildSystemPrompt(
  systemPrompt: string | undefined,
  model: Model<Api>,
  cacheRetention: CacheRetention
): BedrockCampSystemBlock[] | undefined {
  if (!systemPrompt) return undefined;
  const blocks: BedrockCampSystemBlock[] = [{ text: sanitize(systemPrompt) }];
  if (cacheRetention !== 'none' && supportsPromptCaching(model)) {
    blocks.push(buildCachePoint(cacheRetention));
  }
  return blocks;
}

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

function formatHttpError(status: number, body: string): string {
  let prefix = `Bedrock CAMP API error (${status})`;
  if (status === 429) prefix = `Throttling error: ${prefix}`;
  else if (status === 503) prefix = `Service unavailable: ${prefix}`;
  else if (status === 502 || status === 504) prefix = `Internal server error: ${prefix}`;
  else if (status >= 500) prefix = `Internal server error: ${prefix}`;
  else if (status === 400) prefix = `Validation error: ${prefix}`;
  return `${prefix}: ${body}`;
}

function parseConverseResponse(
  body: unknown,
  model: Model<Api>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream
): void {
  const response = body as BedrockCampConverseResponse;
  stream.push({ type: 'start', partial: output });

  const message = response.output?.message;
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

  if (response.usage) {
    output.usage.input = response.usage.inputTokens || 0;
    output.usage.output = response.usage.outputTokens || 0;
    output.usage.cacheRead = response.usage.cacheReadInputTokens || 0;
    output.usage.cacheWrite = response.usage.cacheWriteInputTokens || 0;
    output.usage.totalTokens =
      response.usage.totalTokens || output.usage.input + output.usage.output;
    calculateCost(model, output.usage);
  }

  output.stopReason = mapStopReason(response.stopReason || 'end_turn');
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
): BedrockCampInferenceConfig {
  const inferenceConfig: BedrockCampInferenceConfig = {};
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
): BedrockCampConverseRequestBody {
  const system = buildSystemPrompt(context.systemPrompt, model, cacheRetention);
  const toolConfig = convertToolConfig(context.tools, options.toolChoice);
  const additionalModelRequestFields = buildAdditionalModelRequestFields(model, options);

  const body: BedrockCampConverseRequestBody = {
    modelId: model.id,
    messages: convertMessages(context, model, cacheRetention),
    inferenceConfig: buildInferenceConfig(model, options),
    ...(system !== undefined ? { system } : {}),
    ...(toolConfig !== undefined ? { toolConfig } : {}),
    ...(additionalModelRequestFields !== undefined ? { additionalModelRequestFields } : {}),
    ...(options.requestMetadata !== undefined ? { requestMetadata: options.requestMetadata } : {}),
  };

  return body;
}

async function applyOnPayloadHook(
  body: BedrockCampConverseRequestBody,
  model: Model<Api>,
  options: BedrockCampOptions
): Promise<BedrockCampConverseRequestBody> {
  if (!options.onPayload) return body;
  const replacement = await options.onPayload(body, model);
  if (replacement === undefined) return body;
  if (!isBedrockCampConverseRequestBody(replacement)) {
    throw new Error('Bedrock CAMP onPayload hook must return a converse request body');
  }
  return replacement;
}

function isBedrockCampConverseRequestBody(value: unknown): value is BedrockCampConverseRequestBody {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'modelId' in value &&
    typeof value.modelId === 'string' &&
    'messages' in value &&
    Array.isArray(value.messages)
  );
}

async function performConverseFetch(
  targetUrl: string,
  apiKey: string,
  body: BedrockCampConverseRequestBody,
  model: Model<Api>,
  options: BedrockCampOptions
): Promise<Response> {
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
    const mutableBlock = block as { index?: unknown; partialJson?: unknown };
    delete mutableBlock.index;
    delete mutableBlock.partialJson;
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

  const targetUrl = `${baseUrl.replace(/\/$/, '')}/model/${model.id}/converse`;

  const response = await performConverseFetch(targetUrl, apiKey, body, model, options);

  const responseBody = await response.json();
  parseConverseResponse(responseBody, model, output, stream);

  if (output.stopReason === 'pending') {
    throw new Error('Bedrock CAMP response ended without a stop reason');
  }
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
  const output = createInitialOutput(model);
  void runBedrockCampStream(model, context, options, output, stream).catch((error) => {
    handleStreamError(error, output, options, stream);
  });
  return stream;
};

async function runBedrockCampStream(
  model: Model<Api>,
  context: Context,
  options: BedrockCampOptions,
  output: AssistantMessage,
  stream: AssistantMessageEventStream
): Promise<void> {
  await runConverseRequest(model, context, options, output, stream);
}

export const streamSimpleBedrockCamp = (
  model: Model<Api>,
  context: Context,
  options?: BedrockCampSimpleOptions
): AssistantMessageEventStream => {
  const base = (buildBaseOptions as Function)(model, context, options) as ReturnType<
    typeof buildBaseOptions
  >;
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

export function register(): void {
  registerApiProvider({
    api: 'bedrock-camp-converse' as Api,
    stream: streamBedrockCamp,
    streamSimple: streamSimpleBedrockCamp,
  });
}
