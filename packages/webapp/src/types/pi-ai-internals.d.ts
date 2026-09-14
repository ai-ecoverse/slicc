declare module '@earendil-works/pi-ai/dist/api/transform-messages.js' {
  import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
  export function transformMessages<TApi extends Api>(
    messages: Message[],
    model: Model<TApi>,
    normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string
  ): Message[];
}

declare module '@earendil-works/pi-ai/dist/api/simple-options.js' {
  import type {
    Api,
    Model,
    SimpleStreamOptions,
    StreamOptions,
    ThinkingBudgets,
    ThinkingLevel,
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
