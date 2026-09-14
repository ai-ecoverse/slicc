declare module '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js' {
  import type { AgentMessage } from '@earendil-works/pi-agent-core';
  import type { Api, Model } from '@earendil-works/pi-ai';

  export interface CompactionSettings {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  }

  export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings;

  export function estimateTokens(message: AgentMessage): number;

  export function shouldCompact(
    contextTokens: number,
    contextWindow: number,
    settings: CompactionSettings
  ): boolean;

  export function generateSummary(
    currentMessages: AgentMessage[],
    model: Model<Api>,
    reserveTokens: number,
    apiKey: string,
    headers?: Record<string, string>,
    signal?: AbortSignal,
    customInstructions?: string,
    previousSummary?: string
  ): Promise<string>;
}
