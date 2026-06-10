import type { AddItem } from './add-item.js';

/**
 * Compile reference chips into a `[context]` preamble prepended to the
 * user's prompt. The agent resolves each locator with its own tools
 * (cat the file/folder, use the skill, read the session, address the
 * scoop). Returns '' when there are no references.
 */
export function compileContextPreamble(references: AddItem[]): string {
  if (references.length === 0) return '';
  const lines = references.map((r) => {
    const tail = r.label && r.label !== r.locator ? ` (${r.label})` : '';
    return `- ${r.kind}: ${r.locator}${tail}`;
  });
  return ['[context]', ...lines].join('\n');
}
