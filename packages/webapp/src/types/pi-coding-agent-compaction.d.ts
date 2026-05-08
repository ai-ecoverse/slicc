/**
 * Type declarations for the pi-coding-agent compaction submodule.
 *
 * We import directly from the compaction subpath rather than the main entry
 * because the main entry re-exports 113 Node-only modules that break Vite's
 * browser bundle. The compaction submodule only depends on @mariozechner/pi-ai.
 *
 * These types mirror the exports from:
 *   @mariozechner/pi-coding-agent/dist/core/compaction/compaction.d.ts
 */
declare module '@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js' {
  import type { AgentMessage } from '@mariozechner/pi-agent-core';
  import type { Api, Model } from '@mariozechner/pi-ai';

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
