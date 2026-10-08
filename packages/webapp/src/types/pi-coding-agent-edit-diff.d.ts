declare module '@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js' {
  export function detectLineEnding(content: string): '\r\n' | '\n';
  export function normalizeToLF(text: string): string;
  export function restoreLineEndings(text: string, ending: '\r\n' | '\n'): string;
  export function applyEditsToNormalizedContent(
    normalizedContent: string,
    edits: Array<{ oldText: string; newText: string }>,
    path: string
  ): { baseContent: string; newContent: string };
}

declare module '@earendil-works/pi-coding-agent/dist/utils/text.js' {
  export function splitBom(content: string): { bom: string; text: string };
}
