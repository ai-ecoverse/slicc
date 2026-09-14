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
