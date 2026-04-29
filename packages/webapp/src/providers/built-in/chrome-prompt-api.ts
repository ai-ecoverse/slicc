/**
 * Chrome on-device Prompt API (Gemini Nano) provider.
 *
 * Uses the browser-native `window.LanguageModel` surface exposed by Chrome's
 * Built-in AI / Multimodal Prompt API origin trial. No network or API key —
 * the model runs locally on the user's device.
 *
 * Requires Chrome ~139+ launched with:
 *   --enable-features=OptimizationGuideOnDeviceModel:on_device_model_image_input/true
 *   --enable-blink-features=AIPromptAPIMultimodalInput
 *
 * Or `chrome://flags/#optimization-guide-on-device-model` +
 * `#prompt-api-for-gemini-nano-multimodal-input` set to Enabled.
 *
 * Tools are not supported by the Prompt API and are silently ignored.
 */

import type { ProviderConfig } from '../types.js';
import { registerApiProvider, createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import type { AssistantMessageEventStream } from '@mariozechner/pi-ai';
import type {
  Api,
  Model,
  Context,
  SimpleStreamOptions,
  AssistantMessage,
  TextContent,
} from '@mariozechner/pi-ai';

// ── Provider config ────────────────────────────────────────────────

const PROVIDER_ID = 'chrome-prompt-api';
const API_NAME = 'chrome-prompt-api-openai' as Api;

export const config: ProviderConfig = {
  id: PROVIDER_ID,
  name: 'Chrome (Gemini Nano)',
  description: 'On-device Prompt API — runs locally in Chrome (no API key)',
  requiresApiKey: false,
  requiresBaseUrl: false,
  // The Prompt API only ever exposes one local model at a time. Mark it as
  // openai-flavoured purely so getProviderModels routes through our custom
  // api name; the streaming function we register handles the real shape.
  getModelIds: () => [
    {
      id: 'gemini-nano',
      name: 'Gemini Nano (on-device)',
      api: 'openai',
      input: ['text', 'image'],
      context_window: 6144,
      max_tokens: 1024,
      reasoning: false,
    },
  ],
};

// ── Prompt API typings (subset of the origin trial) ────────────────

type LMInputType = 'text' | 'image' | 'audio';

interface LMExpectedInput {
  type: LMInputType;
  languages?: string[];
}

interface LMMessageContent {
  type: LMInputType;
  value: string | Blob | ImageBitmap | HTMLImageElement;
}

interface LMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LMMessageContent[];
}

interface LMSessionCreateOptions {
  expectedInputs?: LMExpectedInput[];
  initialPrompts?: LMMessage[];
  signal?: AbortSignal;
}

interface LMSession {
  promptStreaming(input: LMMessage[], options?: { signal?: AbortSignal }): ReadableStream<string>;
  destroy(): void;
}

interface LanguageModelGlobal {
  availability(options?: {
    expectedInputs?: LMExpectedInput[];
  }): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
  create(options?: LMSessionCreateOptions): Promise<LMSession>;
}

declare global {
  interface Window {
    LanguageModel?: LanguageModelGlobal;
  }
  // Chromium also exposes it as a bare global in some channels.
  var LanguageModel: LanguageModelGlobal | undefined;
}

function getLanguageModel(): LanguageModelGlobal | undefined {
  if (typeof window !== 'undefined' && window.LanguageModel) return window.LanguageModel;
  if (
    typeof globalThis !== 'undefined' &&
    (globalThis as { LanguageModel?: LanguageModelGlobal }).LanguageModel
  ) {
    return (globalThis as { LanguageModel?: LanguageModelGlobal }).LanguageModel;
  }
  return undefined;
}

// ── Message conversion ─────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  source?: { data?: string; mediaType?: string; media_type?: string };
}

interface ConversationMessage {
  role: string;
  content: string | ContentBlock[];
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function blocksToLMContent(blocks: ContentBlock[]): LMMessageContent[] {
  const parts: LMMessageContent[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push({ type: 'text', value: b.text });
    } else if (b.type === 'image') {
      const data = b.data ?? b.source?.data;
      const mime = b.mimeType ?? b.source?.mediaType ?? b.source?.media_type ?? 'image/png';
      if (data) parts.push({ type: 'image', value: base64ToBlob(data, mime) });
    }
  }
  return parts;
}

function convertMessages(context: Context): {
  initialPrompts: LMMessage[];
  tail: LMMessage[];
  hasMultimodal: boolean;
} {
  const initialPrompts: LMMessage[] = [];
  if (context.systemPrompt) {
    initialPrompts.push({ role: 'system', content: context.systemPrompt });
  }

  // We treat the conversation as a sequential turn list; the most recent
  // user message becomes the streamed prompt while everything before it is
  // seeded as initialPrompts on the session.
  const all = context.messages as ConversationMessage[];
  let hasMultimodal = false;

  const toLM = (m: ConversationMessage): LMMessage | null => {
    const role: LMMessage['role'] =
      m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
    if (typeof m.content === 'string') return { role, content: m.content };
    const parts = blocksToLMContent(m.content);
    if (parts.length === 0) return null;
    if (parts.some((p) => p.type === 'image')) hasMultimodal = true;
    if (parts.length === 1 && parts[0].type === 'text') {
      return { role, content: parts[0].value as string };
    }
    return { role, content: parts };
  };

  // Find last user message; everything else (including any trailing
  // toolResult blocks we cannot represent) is dropped from the tail.
  let lastUserIdx = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx < 0) {
    return { initialPrompts, tail: [], hasMultimodal };
  }

  for (let i = 0; i < lastUserIdx; i++) {
    const lm = toLM(all[i]);
    if (lm) initialPrompts.push(lm);
  }
  const tail: LMMessage[] = [];
  const lm = toLM(all[lastUserIdx]);
  if (lm) tail.push(lm);
  return { initialPrompts, tail, hasMultimodal };
}

// ── Stream function ────────────────────────────────────────────────

function emptyAssistant(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: API_NAME,
    provider: PROVIDER_ID,
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

const streamChromePromptApi = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions = {}
): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output = emptyAssistant(model);

    try {
      const lm = getLanguageModel();
      if (!lm) {
        throw new Error(
          'Chrome Prompt API is not available. Launch Chrome with --enable-blink-features=AIPromptAPIMultimodalInput, or enable chrome://flags/#prompt-api-for-gemini-nano-multimodal-input.'
        );
      }

      const { initialPrompts, tail, hasMultimodal } = convertMessages(context);
      if (tail.length === 0) throw new Error('No user message to send to the Prompt API.');

      const expectedInputs: LMExpectedInput[] = [{ type: 'text' }];
      if (hasMultimodal) expectedInputs.push({ type: 'image' });

      const availability = await lm.availability({ expectedInputs });
      if (availability === 'unavailable') {
        throw new Error(
          'Gemini Nano is unavailable on this device. Check chrome://on-device-internals.'
        );
      }

      const session = await lm.create({
        expectedInputs,
        initialPrompts,
        signal: options.signal,
      });

      stream.push({ type: 'start', partial: output });

      const textBlock: TextContent = { type: 'text', text: '' };
      output.content.push(textBlock);
      const idx = output.content.length - 1;
      stream.push({ type: 'text_start', contentIndex: idx, partial: output });

      try {
        const reader = session.promptStreaming(tail, { signal: options.signal }).getReader();
        // The Prompt API emits incremental string deltas (per-token-ish).
        // Some Chrome versions emit cumulative strings instead — handle both.
        let lastSeen = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (typeof value !== 'string' || value.length === 0) continue;
          let delta = value;
          if (value.startsWith(textBlock.text) && value.length >= textBlock.text.length) {
            // Cumulative mode: strip the already-emitted prefix.
            delta = value.slice(textBlock.text.length);
            if (delta.length === 0) continue;
          } else if (value === lastSeen) {
            continue;
          }
          lastSeen = value;
          textBlock.text += delta;
          stream.push({
            type: 'text_delta',
            contentIndex: idx,
            delta,
            partial: output,
          });
        }
      } finally {
        try {
          session.destroy();
        } catch {
          /* noop */
        }
      }

      stream.push({
        type: 'text_end',
        contentIndex: idx,
        content: textBlock.text,
        partial: output,
      });

      output.usage.output = Math.ceil(textBlock.text.length / 4);
      output.usage.totalTokens = output.usage.output;

      stream.push({ type: 'done', reason: 'stop', message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

// ── Registration ───────────────────────────────────────────────────

export function register(): void {
  registerApiProvider({
    api: API_NAME,
    stream: streamChromePromptApi as Parameters<typeof registerApiProvider>[0]['stream'],
    streamSimple: streamChromePromptApi as Parameters<
      typeof registerApiProvider
    >[0]['streamSimple'],
  });
}
