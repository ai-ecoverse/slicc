/**
 * Memory surface for the WC workbench: the selected cone's `CLAUDE.md`
 * rendered as `<slicc-memrow>` cards. Markdown→row parsing lives in
 * `@slicc/webcomponents` (`memory/memory-rows.ts`); this module reads the
 * VFS and injects the webapp markdown renderer.
 */

import {
  createMemoryRows as createLibraryMemoryRows,
  MEMORY_TITLE_MAX,
  type MemoryRow,
  type MemoryTag,
  parseMemoryRows as parseLibraryMemoryRows,
} from '@slicc/webcomponents/memory/rows';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import { PRIMARY_WORKSPACE } from '../../work-unit/descriptor.js';
import { renderMessageContent } from '../message-renderer.js';

export { MEMORY_TITLE_MAX, type MemoryRow, type MemoryTag };

export function parseMemoryRows(markdown: string): MemoryRow[] {
  return parseLibraryMemoryRows(markdown, renderMessageContent);
}

export function createMemoryRows(markdown: string): HTMLElement[] {
  return createLibraryMemoryRows(markdown, renderMessageContent);
}

/**
 * Read a cone's memory file and render it as memrow cards. `memoryPath`
 * defaults to the primary cone's (#2271).
 */
export async function buildMemoryRows(
  fs: LocalVfsClient,
  memoryPath: string = PRIMARY_WORKSPACE.memoryPath
): Promise<HTMLElement[]> {
  let markdown = '';
  try {
    const raw = await fs.readFile(memoryPath, { encoding: 'utf-8' });
    markdown = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    markdown = '';
  }
  return createMemoryRows(markdown);
}
