/**
 * Type declarations for the pi-coding-agent tool-output truncation submodule.
 *
 * We import directly from the truncate subpath rather than the main entry
 * because the main entry re-exports Node-only modules (the OS-shell bash tool,
 * pi-tui) that break Vite's browser bundle. truncate.js itself is pure
 * string/Buffer ops, so the bash tool re-uses it to stay converged with pi's
 * output-bounding contract (#2009) instead of reinventing truncation.
 *
 * These types mirror the exports from:
 *   @earendil-works/pi-coding-agent/dist/core/tools/truncate.d.ts
 */
declare module '@earendil-works/pi-coding-agent/dist/core/tools/truncate.js' {
  export const DEFAULT_MAX_LINES: number;
  export const DEFAULT_MAX_BYTES: number;
  export const GREP_MAX_LINE_LENGTH: number;

  export interface TruncationResult {
    content: string;
    truncated: boolean;
    truncatedBy: 'lines' | 'bytes' | null;
    totalLines: number;
    totalBytes: number;
    outputLines: number;
    outputBytes: number;
    lastLinePartial: boolean;
    firstLineExceedsLimit: boolean;
    maxLines: number;
    maxBytes: number;
  }

  export interface TruncationOptions {
    maxLines?: number;
    maxBytes?: number;
  }

  export function formatSize(bytes: number): string;
  export function truncateHead(content: string, options?: TruncationOptions): TruncationResult;
  export function truncateTail(content: string, options?: TruncationOptions): TruncationResult;
  export function truncateLine(
    line: string,
    maxChars?: number
  ): { text: string; wasTruncated: boolean };
}
