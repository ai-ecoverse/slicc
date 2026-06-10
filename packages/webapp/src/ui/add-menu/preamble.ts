import type { AddItem } from './add-item.js';

/** Replace embedded newlines with spaces so a single reference never
 *  spans multiple lines and corrupts the `[context]` block structure. */
function collapseNewlines(s: string): string {
  return s.replace(/[\n\r]/g, ' ');
}

/**
 * Compile reference chips into a `[context]` preamble prepended to the
 * user's prompt. The agent resolves each locator with its own tools
 * (cat the file/folder, use the skill, read the session, address the
 * scoop). Returns '' when there are no references.
 */
export function compileContextPreamble(references: AddItem[]): string {
  if (references.length === 0) return '';
  const lines = references.map((r) => {
    const locator = collapseNewlines(r.locator);
    const label = collapseNewlines(r.label);
    const tail = label && label !== locator ? ` (${label})` : '';
    return `- ${r.kind}: ${locator}${tail}`;
  });
  return ['[context]', ...lines].join('\n');
}

/**
 * Inverse of compileContextPreamble, for DISPLAY ONLY: strip a leading
 * `[context]` block (header + `- ` lines, up to the blank-line separator)
 * from text reconstructed out of the agent's stored history, so the hidden
 * preamble never leaks into a rebuilt transcript. No-op when there's no
 * leading block.
 *
 * Display edge case: a user message that literally starts with `[context]\n`
 * (without having gone through compileContextPreamble) will also have that
 * prefix stripped from the displayed transcript. The full text is still
 * forwarded to the agent correctly via `agentText` in chat-panel.ts.
 */
export function stripContextPreamble(text: string): string {
  if (!text.startsWith('[context]\n')) return text;
  const sep = text.indexOf('\n\n');
  return sep === -1 ? '' : text.slice(sep + 2);
}
