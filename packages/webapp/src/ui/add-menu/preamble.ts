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
 * `[context]` block (header + `- ` lines + blank separator) from text
 * reconstructed out of the agent's stored history, so the hidden preamble
 * never leaks into a rebuilt transcript. No-op when there's no leading block.
 *
 * The regex anchors to the exact structure compileContextPreamble emits, so
 * user messages that happen to start with "[context]" are left untouched
 * unless they also have the `- kind: locator` + blank-line shape.
 */
export function stripContextPreamble(text: string): string {
  const match = /^\[context\]\n(?:- [^\n]*\n)*\n/.exec(text);
  return match ? text.slice(match[0].length) : text;
}
