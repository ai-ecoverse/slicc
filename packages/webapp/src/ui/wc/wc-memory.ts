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
