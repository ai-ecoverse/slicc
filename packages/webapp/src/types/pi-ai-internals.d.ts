/**
 * Type declarations for internal pi-ai modules not in the exports map.
 *
 * These deep imports are used by provider implementations that need access
 * to shared helpers (message transformation, option building) without pulling
 * in the full provider entry points.
 *
 * Follow the same pattern as pi-coding-agent-compaction.d.ts.
 */
declare module '@earendil-works/pi-ai/dist/providers/transform-messages.js' {
  import type { Api, Model, Message, AssistantMessage } from '@earendil-works/pi-ai';
  export function transformMessages<TApi extends Api>(
    messages: Message[],
    model: Model<TApi>,
    normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string
  ): Message[];
}

declare module '@earendil-works/pi-ai/dist/providers/simple-options.js' {
  import type {
    Api,
    Model,
    StreamOptions,
    SimpleStreamOptions,
    ThinkingLevel,
    ThinkingBudgets,
  } from '@earendil-works/pi-ai';
  export function buildBaseOptions(
    model: Model<Api>,
    options?: SimpleStreamOptions,
    apiKey?: string
  ): StreamOptions;
  export function clampReasoning(
    effort: ThinkingLevel | undefined
  ): Exclude<ThinkingLevel, 'xhigh'> | undefined;
  export function adjustMaxTokensForThinking(
    baseMaxTokens: number,
    modelMaxTokens: number,
    reasoningLevel: ThinkingLevel,
    customBudgets?: ThinkingBudgets
  ): { maxTokens: number; budgetTokens: number | undefined };
}
