import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model, Usage, UserMessage } from '@earendil-works/pi-ai';
import { completeSimple } from '@earendil-works/pi-ai/compat';

import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  shouldCompact,
} from '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';
import { createLogger } from '../base/logger.js';

const log = createLogger('context-compaction');

const DEFAULT_CONTEXT_WINDOW = 200000;

function hasRole(message: AgentMessage, role: string): boolean {
  return (message as { role: string }).role === role;
}

export function stripOrphanedToolResults(messages: AgentMessage[]): AgentMessage[] {
  let i = 0;
  while (i < messages.length && hasRole(messages[i], 'toolResult')) {
    const tr = messages[i] as { role: string; toolCallId?: string };
    log.warn('Dropping orphaned toolResult (no preceding assistant message)', {
      toolCallId: tr.toolCallId,
    });
    i++;
  }
  return i > 0 ? messages.slice(i) : messages;
}

export interface CompactionConfig {
  model: Model<Api>;
  getApiKey: () => string | undefined;
  contextWindow?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;

  hopelessMultiplier?: number;

  headers?: Record<string, string>;

  onMemoryUpdates?: (bullets: string) => Promise<void> | void;

  shouldExtractMemories?: () => boolean;

  onCompactionStateChange?: (state: CompactionState, detail: CompactionStateDetail) => void;

  onBeforeCompaction?: (
    messages: AgentMessage[],
    trigger: CompactionTrigger
  ) => Promise<CompactionSnapshot | undefined | void> | CompactionSnapshot | undefined | void;
}

export type CompactionTrigger = 'threshold' | 'overflow' | 'idle';

export interface CompactionSnapshot {
  transcriptPath: string;
}

export interface CompactionStateDetail {
  trigger: CompactionTrigger;

  transcriptPath?: string;

  failure?: CompactionFailureClass;

  roundId?: string;
}

export interface CompactionOptions {
  force?: boolean;

  deferMemoryExtraction?: (extract: () => Promise<void>) => void;

  trigger?: CompactionTrigger;

  roundId?: string;

  allowNaiveDrop?: boolean;
}

export type CompactionFailureClass =
  | 'rate-limit'
  | 'quota-exhausted'
  | 'authentication'
  | 'provider-unavailable'
  | 'empty-response'
  | 'invalid-response'
  | 'context-too-large'
  | 'unknown';

export type CompactionState =
  | 'summarizing'
  | 'extracting-memory'
  | 'fallback'
  | 'cancelled'
  | 'idle';

function serializeMessages(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const m = msg as {
      role: string;
      content?: unknown;
      command?: string;
      output?: string;
      summary?: string;
      toolName?: string;
    };
    switch (m.role) {
      case 'user': {
        lines.push(`<user>\n${extractText(m.content)}\n</user>`);
        break;
      }
      case 'assistant': {
        lines.push(`<assistant>\n${extractText(m.content)}\n</assistant>`);
        break;
      }
      case 'toolResult': {
        const name = m.toolName ?? 'tool';
        lines.push(`<tool-result name="${name}">\n${extractText(m.content)}\n</tool-result>`);
        break;
      }
      case 'bashExecution': {
        lines.push(`<bash>\n$ ${m.command ?? ''}\n${m.output ?? ''}\n</bash>`);
        break;
      }
      case 'branchSummary':
      case 'compactionSummary': {
        lines.push(`<prior-summary>\n${m.summary ?? ''}\n</prior-summary>`);
        break;
      }
      default: {
        lines.push(`<${m.role}>\n${extractText(m.content)}\n</${m.role}>`);
      }
    }
  }
  return lines.join('\n\n');
}

const TRANSCRIPT_POINTER_RE =
  /\n*The full transcript of the conversation before this compaction is saved at \S+ — read it when the summary is not enough\.?/g;

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.replace(TRANSCRIPT_POINTER_RE, '');
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    const b = block as {
      type?: string;
      text?: string;
      name?: string;
      arguments?: unknown;
      thinking?: string;
    };
    if (b.type === 'text' && b.text) out.push(b.text.replace(TRANSCRIPT_POINTER_RE, ''));
    else if (b.type === 'thinking' && b.thinking) out.push(`[thinking] ${b.thinking}`);
    else if (b.type === 'toolCall')
      out.push(`[tool-call ${b.name ?? '?'}] ${JSON.stringify(b.arguments ?? {})}`);
    else if (b.type === 'image') out.push('[image]');
  }
  return out.join('\n');
}

const SUMMARY_INSTRUCTION = `Produce a structured context checkpoint summary of the conversation above that another LLM can use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages. Output ONLY the summary, with no preamble or follow-up.`;

const MEMORY_INSTRUCTION = `From the conversation above, extract durable memories worth persisting to a global memory file shared across future sessions.

Focus on:
- User preferences, working style, opinions stated explicitly.
- Stable project facts (architecture decisions, conventions, constraints).
- Validated approaches the user accepted ("yes, exactly", "perfect"), not just corrections.
- External resources/links the user named.

DO NOT include:
- Ephemeral state (current task, in-progress work).
- Information already obvious from the codebase (file paths, function names, framework conventions).
- Generic restatements of what the conversation was about.

If nothing in the conversation is worth persisting, return exactly the single line:
NONE

Otherwise, output ONLY a markdown bullet list (one bullet per memory), no headers, no preamble, no follow-up. Each bullet is one line. Be specific. Prefer one fact per bullet over multi-clause sentences.`;

function buildSharedSystemPrompt(conversationText: string): string {
  return `You are a context compaction assistant. You are shown the prefix of a conversation between a user and an AI coding assistant, and asked to produce either a structured summary, durable memory bullets, or a short title — depending on the user's instruction.

Do NOT continue the conversation. Do NOT answer questions inside the conversation. Output ONLY what the user asks for in the format specified.

<conversation>
${conversationText}
</conversation>`;
}

class CompactionCallError extends Error {
  constructor(
    readonly failure: CompactionFailureClass,
    message: string
  ) {
    super(message);
    this.name = 'CompactionCallError';
  }
}

interface ProviderErrorLike {
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
}

function classifyCompactionFailure(error: unknown): CompactionFailureClass {
  if (error instanceof CompactionCallError) return error.failure;
  const candidate =
    typeof error === 'object' && error !== null ? (error as ProviderErrorLike) : undefined;
  const status = candidate?.status ?? candidate?.statusCode ?? candidate?.code;
  const message =
    typeof candidate?.message === 'string'
      ? candidate.message.toLowerCase()
      : String(error).toLowerCase();
  if (
    status === 429 ||
    status === '429' ||
    /rate[ -]?limit|too many requests|throttl/.test(message)
  ) {
    return 'rate-limit';
  }
  if (/quota|credit|budget|billing|allowance|resource exhausted/.test(message)) {
    return 'quota-exhausted';
  }
  if (
    status === 401 ||
    status === '401' ||
    /unauthori[sz]ed|authentication|invalid api.?key|invalid x-api-key|session expired/.test(
      message
    )
  ) {
    return 'authentication';
  }
  if (
    (typeof status === 'number' && status >= 500) ||
    (typeof status === 'string' && /^5\d\d$/.test(status)) ||
    /service unavailable|provider unavailable|overloaded|outage|timed? out|timeout|network|fetch failed|connection/.test(
      message
    )
  ) {
    return 'provider-unavailable';
  }
  return 'unknown';
}

interface CompactionResponseLike {
  stopReason?: unknown;
  errorMessage?: unknown;
  content?: unknown;
}

interface CompactionContentLike {
  type?: unknown;
  text?: unknown;
}

async function runCompactionCall(
  model: Model<Api>,
  apiKey: string,
  systemPrompt: string,
  userInstruction: string,
  maxTokens: number,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined
): Promise<string> {
  const userMessage: UserMessage = {
    role: 'user',
    content: [{ type: 'text', text: userInstruction }],
    timestamp: Date.now(),
  };
  const response = await completeSimple(
    model,
    { systemPrompt, messages: [userMessage] },
    { maxTokens, apiKey, headers, signal }
  );
  if (typeof response !== 'object' || response === null) {
    throw new CompactionCallError('invalid-response', 'Compaction call returned no response');
  }
  const reply = response as CompactionResponseLike;
  if (typeof reply.stopReason !== 'string' || !Array.isArray(reply.content)) {
    throw new CompactionCallError(
      'invalid-response',
      'Compaction call returned an invalid response envelope'
    );
  }
  if (reply.stopReason === 'error') {
    const providerMessage =
      typeof reply.errorMessage === 'string' ? reply.errorMessage : 'Unknown provider error';
    throw new CompactionCallError(
      classifyCompactionFailure(new Error(providerMessage)),
      `Compaction call failed: ${providerMessage}`
    );
  }
  const textBlocks = reply.content.filter(
    (content): content is CompactionContentLike =>
      typeof content === 'object' &&
      content !== null &&
      (content as CompactionContentLike).type === 'text'
  );
  if (textBlocks.some((content) => typeof content.text !== 'string')) {
    throw new CompactionCallError(
      'invalid-response',
      'Compaction call returned an invalid text block'
    );
  }
  const text = textBlocks
    .map((content) => content.text as string)
    .join('\n')
    .trim();
  if (!text) {
    throw new CompactionCallError('empty-response', 'Compaction call returned no summary text');
  }
  return text;
}

const DEFAULT_HOPELESS_MULTIPLIER = 4;

function approxContentBytes(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    const b = block as {
      type?: string;
      text?: string;
      thinking?: string;
      arguments?: unknown;
      source?: { data?: string };
    };
    if (b.type === 'text' && b.text) total += b.text.length;
    else if (b.type === 'thinking' && b.thinking) total += b.thinking.length;
    else if (b.type === 'toolCall' && b.arguments !== undefined) {
      try {
        total += JSON.stringify(b.arguments).length;
      } catch {}
    } else if (b.type === 'image' && b.source?.data) total += b.source.data.length;
  }
  return total;
}

function buildElisionStub(approxBytes: number, role: 'toolResult' | 'assistant'): string {
  const kb = Math.max(1, Math.round(approxBytes / 1024));
  const prefix = role === 'assistant' ? 'Assistant message elided' : 'Tool result elided';
  return `[${prefix}: ${kb} KB, exceeds half the context window. Re-run with smaller arguments — e.g. open --view --size low.]`;
}

function elideMessageContent(message: AgentMessage): AgentMessage {
  const role = (message as { role: string }).role as 'toolResult' | 'assistant';
  const content = (message as { content?: unknown }).content;
  const bytes = approxContentBytes(content);
  if (role === 'toolResult') {
    return {
      ...(message as object),
      content: [{ type: 'text', text: buildElisionStub(bytes, role) }],
    } as AgentMessage;
  }

  const toolCalls = Array.isArray(content)
    ? (content.filter((block) => (block as { type?: string }).type === 'toolCall') as Array<{
        type: string;
        id?: string;
        name?: string;
        arguments?: unknown;
      }>)
    : [];
  const elidedToolCalls = toolCalls.map((toolCall) => {
    let argumentBytes = 0;
    if (toolCall.arguments !== undefined) {
      try {
        argumentBytes = JSON.stringify(toolCall.arguments).length;
      } catch {}
    }
    return {
      type: toolCall.type,
      id: toolCall.id,
      name: toolCall.name,
      arguments: { elided: true, originalBytes: argumentBytes },
    };
  });
  return {
    ...(message as object),
    content: [{ type: 'text', text: buildElisionStub(bytes, role) }, ...elidedToolCalls],
  } as AgentMessage;
}

function elideOversizedMessages(
  messages: AgentMessage[],
  contextWindow: number,
  reserveTokens: number
): { messages: AgentMessage[]; elidedCount: number; elidedBytes: number } {
  const perMessageThreshold = (contextWindow - reserveTokens) / 2;
  let elidedCount = 0;
  let elidedBytes = 0;

  const out = messages.map((msg) => {
    const tokens = estimateMessageTokens(msg);
    if (tokens <= perMessageThreshold) return msg;
    const role = (msg as { role: string }).role;
    if (role !== 'toolResult' && role !== 'assistant') return msg;

    const m = msg as { content?: unknown };
    const bytes = approxContentBytes(m.content);

    if (role === 'toolResult') {
      elidedCount++;
      elidedBytes += bytes;
      return elideMessageContent(msg);
    }

    const content = Array.isArray(m.content) ? m.content : [];
    const toolCalls = content.filter((b) => (b as { type?: string }).type === 'toolCall');
    if (toolCalls.length === 0) return msg;

    elidedCount++;
    elidedBytes += bytes;
    return elideMessageContent(msg);
  });

  return { messages: out, elidedCount, elidedBytes };
}

function elideHopelessMessages(
  messages: AgentMessage[],
  contextWindow: number,
  reserveTokens: number
): { messages: AgentMessage[]; elidedCount: number; elidedBytes: number } {
  let elidedCount = 0;
  let elidedBytes = 0;

  const imageStripped = messages.map((rawMsg) => {
    const msg = elideImagesInMessage(rawMsg);
    if (msg !== rawMsg) {
      elidedCount++;
      elidedBytes +=
        approxContentBytes((rawMsg as { content?: unknown }).content) -
        approxContentBytes((msg as { content?: unknown }).content);
    }
    return msg;
  });

  const sized = elideOversizedMessages(imageStripped, contextWindow, reserveTokens);
  return {
    messages: sized.messages,
    elidedCount: elidedCount + sized.elidedCount,
    elidedBytes: elidedBytes + sized.elidedBytes,
  };
}

function thinkingSignatureChars(message: AgentMessage): number {
  if (!hasRole(message, 'assistant')) return 0;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    const b = block as { type?: string; thinkingSignature?: string };
    if (b.type === 'thinking' && typeof b.thinkingSignature === 'string') {
      chars += b.thinkingSignature.length;
    }
  }
  return chars;
}

function estimateMessageTokens(message: AgentMessage): number {
  return estimateTokens(message) + Math.ceil(thinkingSignatureChars(message) / 4);
}

function estimateTotalTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

function lastReportedUsageIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!hasRole(messages[i], 'assistant')) continue;
    const m = messages[i] as { stopReason?: string; usage?: Usage };
    if (m.stopReason === 'aborted' || m.stopReason === 'error') continue;
    const u = m.usage;
    if (!u) continue;
    if (contextTokensFromUsage(u) > 0) return i;
  }
  return -1;
}

function contextTokensFromUsage(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function estimateContextTokens(messages: AgentMessage[]): number {
  const heuristic = estimateTotalTokens(messages);
  const index = lastReportedUsageIndex(messages);
  if (index === -1) return heuristic;
  let reported = contextTokensFromUsage((messages[index] as { usage: Usage }).usage);
  for (let i = index + 1; i < messages.length; i++) {
    reported += estimateMessageTokens(messages[i]);
  }
  return Math.max(heuristic, reported);
}

export function estimateConversationTokens(messages: AgentMessage[]): number {
  return estimateContextTokens(messages);
}

export function hasCompactionProgress(
  messages: AgentMessage[],
  compacted: AgentMessage[]
): boolean {
  if (messages.length !== compacted.length) return true;
  return messages.some((message, index) => message !== compacted[index]);
}

function stateDetailFor(
  trigger: CompactionTrigger,
  options: CompactionOptions | undefined
): CompactionStateDetail {
  return options?.roundId ? { trigger, roundId: options.roundId } : { trigger };
}

function emitCompactionState(
  config: CompactionConfig,
  state: CompactionState,
  detail: CompactionStateDetail
): void {
  try {
    config.onCompactionStateChange?.(state, detail);
  } catch (e) {
    log.warn('onCompactionStateChange listener threw', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function applyHopelessElision(
  messages: AgentMessage[],
  totalTokens: number,
  contextWindow: number,
  reserveTokens: number,
  hopelessMultiplier: number,
  settings: Parameters<typeof shouldCompact>[2]
): { messages: AgentMessage[]; isHopeless: boolean; earlyReturn: AgentMessage[] | null } {
  const sizeElision = elideOversizedMessages(messages, contextWindow, reserveTokens);
  let workingMessages = sizeElision.messages;
  let elidedCount = sizeElision.elidedCount;
  let elidedBytes = sizeElision.elidedBytes;

  const postSizeTokens = elidedCount > 0 ? estimateTotalTokens(workingMessages) : totalTokens;

  const isHopeless = postSizeTokens > contextWindow * hopelessMultiplier;
  if (isHopeless) {
    const hopeless = elideHopelessMessages(workingMessages, contextWindow, reserveTokens);
    workingMessages = hopeless.messages;
    elidedCount += hopeless.elidedCount;
    elidedBytes += hopeless.elidedBytes;
  }

  if (!isHopeless && elidedCount === 0) {
    return { messages, isHopeless: false, earlyReturn: null };
  }

  log.warn('Compaction oversized-message elision', {
    totalTokens,
    postSizeTokens,
    contextWindow,
    isHopeless,
    elidedCount,
    elidedBytes,
  });
  const postTokens = estimateTotalTokens(workingMessages);

  const earlyReturn = shouldCompact(postTokens, contextWindow, settings)
    ? null
    : elideTailImages([], workingMessages, contextWindow, settings);
  return { messages: workingMessages, isHopeless, earlyReturn };
}

function elideImagesInMessage(message: AgentMessage): AgentMessage {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return message;
  let elided = false;
  const next = content.map((block) => {
    const b = block as { type?: string; data?: string; source?: { data?: string } };
    if (b.type !== 'image') return block;
    elided = true;
    const kb = Math.max(1, Math.round((b.source?.data ?? b.data ?? '').length / 1024));
    return {
      type: 'text',
      text: `[image elided during compaction: ~${kb} KB. Re-attach or re-read the image if it is still needed.]`,
    };
  });
  if (!elided) return message;
  return { ...(message as object), content: next } as AgentMessage;
}

function lastUserIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasRole(messages[i], 'user')) return i;
  }
  return -1;
}

function elideTailImages(
  head: AgentMessage[],
  tail: AgentMessage[],
  contextWindow: number,
  settings: Parameters<typeof shouldCompact>[2]
): AgentMessage[] {
  const keepFrom = lastUserIndex(tail);
  let result = tail.map((m, i) => (keepFrom !== -1 && i >= keepFrom ? m : elideImagesInMessage(m)));

  if (shouldCompact(estimateTotalTokens([...head, ...result]), contextWindow, settings)) {
    for (let i = 0; i < result.length; i++) {
      const next = elideImagesInMessage(result[i]);
      if (next === result[i]) continue;
      result = [...result.slice(0, i), next, ...result.slice(i + 1)];
      if (!shouldCompact(estimateTotalTokens([...head, ...result]), contextWindow, settings)) {
        break;
      }
    }
  }
  return result;
}

function selectCompactionSlices(
  workingMessages: AgentMessage[],
  keepRecentTokens: number
): { messagesToSummarize: AgentMessage[]; messagesToKeep: AgentMessage[] } | null {
  let keptTokens = 0;
  let cutIndex = workingMessages.length;
  for (let i = workingMessages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(workingMessages[i]);
    if (keptTokens + msgTokens > keepRecentTokens && cutIndex < workingMessages.length) {
      break;
    }
    keptTokens += msgTokens;
    cutIndex = i;
  }

  while (cutIndex > 0 && hasRole(workingMessages[cutIndex], 'toolResult')) {
    cutIndex--;
  }

  if (cutIndex <= 0 || cutIndex >= workingMessages.length) {
    log.warn('Cannot find valid cut point for compaction');
    return null;
  }

  return {
    messagesToSummarize: workingMessages.slice(0, cutIndex),
    messagesToKeep: stripOrphanedToolResults(workingMessages.slice(cutIndex)),
  };
}

async function extractMemoriesIfConfigured(
  config: CompactionConfig,
  apiKey: string,
  systemPrompt: string,
  signal: AbortSignal | undefined,
  detail: CompactionStateDetail
): Promise<void> {
  if (!config.onMemoryUpdates) return;

  if (config.shouldExtractMemories?.() === false) return;

  const memoryMaxTokens = 2048;
  try {
    emitCompactionState(config, 'extracting-memory', detail);
    const bullets = await runCompactionCall(
      config.model,
      apiKey,
      systemPrompt,
      MEMORY_INSTRUCTION,
      memoryMaxTokens,
      config.headers,
      signal
    );
    if (bullets?.trim() && bullets.trim() !== 'NONE') {
      try {
        await config.onMemoryUpdates(bullets.trim());
        log.info('Memory extraction applied', { bulletsLength: bullets.length });
      } catch (cbErr) {
        log.warn('onMemoryUpdates callback threw', {
          error: cbErr instanceof Error ? cbErr.message : String(cbErr),
        });
      }
    } else {
      log.info('Memory extraction returned no durable memories');
    }
  } catch (memErr) {
    log.warn('Memory extraction call failed (compaction still applied)', {
      error: memErr instanceof Error ? memErr.message : String(memErr),
    });
  }
}

type SummaryAttempt =
  | { kind: 'summarized'; messages: AgentMessage[] }
  | { kind: 'failed'; failure: CompactionFailureClass };

async function summarizeWithLlm(
  config: CompactionConfig,
  apiKey: string,
  messagesToSummarize: AgentMessage[],
  messagesToKeep: AgentMessage[],
  reserveTokens: number,
  contextWindow: number,
  originalMessageCount: number,
  signal: AbortSignal | undefined,
  detail: CompactionStateDetail,
  deferMemoryExtraction: CompactionOptions['deferMemoryExtraction']
): Promise<SummaryAttempt> {
  try {
    const safeToSummarize = elideOversizedMessages(
      messagesToSummarize,
      contextWindow,
      reserveTokens
    ).messages;
    const conversationText = serializeMessages(safeToSummarize);
    const systemPrompt = buildSharedSystemPrompt(conversationText);

    const summaryMaxTokens = Math.floor(0.8 * reserveTokens);
    emitCompactionState(config, 'summarizing', detail);
    const summary = await runCompactionCall(
      config.model,
      apiKey,
      systemPrompt,
      SUMMARY_INSTRUCTION,
      summaryMaxTokens,
      config.headers,
      signal
    );

    const summaryMessage: UserMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: withTranscriptPointer(
            `<context-summary>\n${summary}\n</context-summary>`,
            detail.transcriptPath
          ),
        },
      ],
      timestamp: Date.now(),
    };

    log.info('LLM summarization successful', {
      originalMessages: originalMessageCount,
      compactedMessages: 1 + messagesToKeep.length,
      summaryLength: summary.length,
    });

    if (deferMemoryExtraction) {
      deferMemoryExtraction(() =>
        extractMemoriesIfConfigured(config, apiKey, systemPrompt, undefined, detail)
      );
    } else {
      await extractMemoriesIfConfigured(config, apiKey, systemPrompt, signal, detail);
    }

    emitCompactionState(config, 'idle', detail);
    return { kind: 'summarized', messages: [summaryMessage, ...messagesToKeep] };
  } catch (err) {
    const failure = classifyCompactionFailure(err);
    log.warn('LLM summarization failed', {
      failure,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'failed', failure };
  }
}

async function snapshotBeforeCompaction(
  config: CompactionConfig,
  messages: AgentMessage[],
  trigger: CompactionTrigger
): Promise<CompactionSnapshot | undefined> {
  if (!config.onBeforeCompaction) return undefined;
  try {
    const snapshot = await config.onBeforeCompaction(messages, trigger);
    if (snapshot?.transcriptPath) {
      log.info('Pre-compaction transcript snapshot written', {
        trigger,
        transcriptPath: snapshot.transcriptPath,
      });
      return snapshot;
    }
  } catch (err) {
    log.warn('Pre-compaction snapshot hook failed (compaction continues without a pointer)', {
      trigger,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return undefined;
}

function withTranscriptPointer(text: string, transcriptPath: string | undefined): string {
  if (!transcriptPath) return text;
  return `${text}\n\nThe full transcript of the conversation before this compaction is saved at ${transcriptPath} — read it when the summary is not enough.`;
}

function finishEarlyElision(
  config: CompactionConfig,
  messages: AgentMessage[],
  elided: AgentMessage[],
  trigger: CompactionTrigger,
  detail: CompactionStateDetail,
  allowNaiveDrop: boolean | undefined
): AgentMessage[] {
  if (allowNaiveDrop === false) {
    const preservedDetail = { ...detail, failure: 'context-too-large' as const };
    log.info('Idle compaction skipped destructive hopeless-context elision', {
      trigger,
      failure: preservedDetail.failure,
    });
    emitCompactionState(config, 'cancelled', preservedDetail);
    emitCompactionState(config, 'idle', preservedDetail);
    return messages;
  }
  emitCompactionState(config, 'summarizing', detail);
  emitCompactionState(config, 'idle', detail);
  return elided;
}

async function attemptSummary(
  config: CompactionConfig,
  messagesToSummarize: AgentMessage[],
  messagesToKeep: AgentMessage[],
  reserveTokens: number,
  contextWindow: number,
  originalMessageCount: number,
  signal: AbortSignal | undefined,
  detail: CompactionStateDetail,
  options: CompactionOptions | undefined,
  isHopeless: boolean
): Promise<SummaryAttempt> {
  if (isHopeless) return { kind: 'failed', failure: 'context-too-large' };
  const apiKey = config.getApiKey();
  if (!apiKey) {
    log.warn('No API key available for LLM summarization');
    return { kind: 'failed', failure: 'authentication' };
  }
  return summarizeWithLlm(
    config,
    apiKey,
    messagesToSummarize,
    messagesToKeep,
    reserveTokens,
    contextWindow,
    originalMessageCount,
    signal,
    detail,
    options?.deferMemoryExtraction
  );
}

function finishFailedSummary(
  config: CompactionConfig,
  messages: AgentMessage[],
  messagesToKeep: AgentMessage[],
  contextWindow: number,
  settings: Parameters<typeof shouldCompact>[2],
  signal: AbortSignal | undefined,
  options: CompactionOptions | undefined,
  trigger: CompactionTrigger,
  detail: CompactionStateDetail,
  failure: CompactionFailureClass
): AgentMessage[] {
  if (signal?.aborted) {
    log.info('Compaction aborted before the fallback drop (history untouched)', { trigger });
    emitCompactionState(config, 'cancelled', detail);
    emitCompactionState(config, 'idle', detail);
    return messages;
  }
  if (options?.allowNaiveDrop === false) {
    const preservedDetail = { ...detail, failure };
    log.warn('Compaction summary unavailable; preserving history for a later retry', {
      trigger,
      failure,
    });
    emitCompactionState(config, 'cancelled', preservedDetail);
    emitCompactionState(config, 'idle', preservedDetail);
    return messages;
  }
  emitCompactionState(config, 'fallback', detail);
  emitCompactionState(config, 'idle', detail);
  const compactedMsg: UserMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: withTranscriptPointer(
          '[Earlier conversation messages were compacted to save context space]',
          detail.transcriptPath
        ),
      },
    ],
    timestamp: Date.now(),
  };
  const keptTail = elideTailImages([compactedMsg], messagesToKeep, contextWindow, settings);
  log.info('Naive compaction applied', {
    originalMessages: messages.length,
    compactedMessages: 1 + keptTail.length,
  });
  return [compactedMsg, ...keptTail];
}

export function createCompactContext(
  config: CompactionConfig
): (
  messages: AgentMessage[],
  signal?: AbortSignal,
  options?: CompactionOptions
) => Promise<AgentMessage[]> {
  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const reserveTokens = config.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const keepRecentTokens = config.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
  const hopelessMultiplier = config.hopelessMultiplier ?? DEFAULT_HOPELESS_MULTIPLIER;

  const settings = { enabled: true, reserveTokens, keepRecentTokens };

  return async (
    messages: AgentMessage[],
    signal?: AbortSignal,
    options?: CompactionOptions
  ): Promise<AgentMessage[]> => {
    if (messages.length === 0) return messages;

    const totalTokens = estimateContextTokens(messages);
    if (!options?.force && !shouldCompact(totalTokens, contextWindow, settings)) {
      return messages;
    }

    const trigger = options?.trigger ?? (options?.force ? 'overflow' : 'threshold');
    const detail = stateDetailFor(trigger, options);
    const snapshot = await snapshotBeforeCompaction(config, messages, trigger);
    if (snapshot) detail.transcriptPath = snapshot.transcriptPath;

    const hopeless = applyHopelessElision(
      messages,
      totalTokens,
      contextWindow,
      reserveTokens,
      hopelessMultiplier,
      settings
    );
    if (hopeless.earlyReturn) {
      return finishEarlyElision(
        config,
        messages,
        hopeless.earlyReturn,
        trigger,
        detail,
        options?.allowNaiveDrop
      );
    }
    const workingMessages = hopeless.messages;
    const isHopeless = hopeless.isHopeless;

    log.info('Context compaction triggered', {
      totalTokens,
      contextWindow,
      threshold: contextWindow - reserveTokens,
      messageCount: workingMessages.length,
    });

    const slices = selectCompactionSlices(workingMessages, keepRecentTokens);
    if (!slices) return options?.allowNaiveDrop === false ? messages : workingMessages;
    const { messagesToSummarize, messagesToKeep } = slices;

    log.info('Compaction cut point', {
      summarizing: messagesToSummarize.length,
      keeping: messagesToKeep.length,
    });

    const attempt = await attemptSummary(
      config,
      messagesToSummarize,
      messagesToKeep,
      reserveTokens,
      contextWindow,
      messages.length,
      signal,
      detail,
      options,
      isHopeless
    );
    if (attempt.kind === 'summarized') {
      const [summaryHead, ...tail] = attempt.messages;
      return [summaryHead, ...elideTailImages([summaryHead], tail, contextWindow, settings)];
    }

    return finishFailedSummary(
      config,
      messages,
      messagesToKeep,
      contextWindow,
      settings,
      signal,
      options,
      trigger,
      detail,
      attempt.failure
    );
  };
}

export async function runOneOffCompactionCall(args: {
  messages: AgentMessage[];
  instruction: string;
  model: Model<Api>;
  apiKey: string;
  maxTokens: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<string> {
  const conversationText = serializeMessages(args.messages);
  const systemPrompt = buildSharedSystemPrompt(conversationText);
  return runCompactionCall(
    args.model,
    args.apiKey,
    systemPrompt,
    args.instruction,
    args.maxTokens,
    args.headers,
    args.signal
  );
}

export const COMPACTION_MEMORY_INSTRUCTION = MEMORY_INSTRUCTION;
export const COMPACTION_TITLE_INSTRUCTION = `Generate a short title (3 to 6 words) summarizing what this conversation was about. Output ONLY the title text — no quotes, no punctuation other than what belongs in the title, no preamble.`;

export async function compactContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
  if (messages.length === 0) return messages;

  let totalTokens = 0;
  for (const msg of messages) {
    totalTokens += estimateMessageTokens(msg);
  }

  if (!shouldCompact(totalTokens, DEFAULT_CONTEXT_WINDOW, DEFAULT_COMPACTION_SETTINGS)) {
    return messages;
  }

  const keepRecentTokens = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;

  let keptTokens = 0;
  let cutIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(messages[i]);
    if (keptTokens + msgTokens > keepRecentTokens && cutIndex < messages.length) {
      break;
    }
    keptTokens += msgTokens;
    cutIndex = i;
  }

  while (cutIndex > 0 && hasRole(messages[cutIndex], 'toolResult')) {
    cutIndex--;
  }

  if (cutIndex <= 0 || cutIndex >= messages.length) {
    return messages;
  }

  const compactedMsg: UserMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: '[Earlier conversation messages were compacted to save context space]',
      },
    ],
    timestamp: Date.now(),
  };

  const kept = stripOrphanedToolResults(messages.slice(cutIndex));
  const result = [compactedMsg, ...kept];

  log.info('Context compacted (legacy)', {
    originalMessages: messages.length,
    compactedMessages: result.length,
  });

  return result;
}
