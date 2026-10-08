/**
 * Type declarations for the pi-coding-agent edit submodules SLICC's VFS edit
 * tool uses (`tools/pi-edit-execution.ts`). Like the truncate subpath, these
 * are imported directly instead of the main entry, which re-exports Node-only
 * modules that break Vite's browser bundle. They are pure string functions;
 * `edit-diff.js`'s own `fs` imports are stubbed in the browser build
 * (`vite.config.ts` `stubPiNodeInternalsPlugin`).
 *
 * These types mirror the exports from:
 *   @earendil-works/pi-coding-agent/dist/core/tools/edit-diff.d.ts
 *   @earendil-works/pi-coding-agent/dist/utils/text.d.ts
 */
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
