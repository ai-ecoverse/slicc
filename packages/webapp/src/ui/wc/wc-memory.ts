/**
 * Memory surface for the WC workbench: the cone's `/workspace/CLAUDE.md`
 * rendered as `<slicc-memrow>` cards — one per memory bullet, with section
 * headings carried into the row title.
 */

import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';

const MEMORY_PATH = '/workspace/CLAUDE.md';
const TITLE_MAX = 64;

export interface MemoryRow {
  title: string;
  summary: string;
}

/** Split a memory bullet into a short title and the remaining summary. */
function splitBullet(text: string): MemoryRow {
  if (text.length <= TITLE_MAX) return { title: text, summary: '' };
  const cut = text.lastIndexOf(' ', TITLE_MAX);
  const at = cut > TITLE_MAX / 2 ? cut : TITLE_MAX;
  return { title: `${text.slice(0, at)}…`, summary: text.slice(at).trim() };
}

/**
 * Parse the memory markdown into rows: one per `- ` bullet (continuation
 * lines folded in). A document without bullets becomes a single row.
 */
export function parseMemoryRows(markdown: string): MemoryRow[] {
  const rows: MemoryRow[] = [];
  let current: string[] | null = null;
  const flush = (): void => {
    if (!current) return;
    const text = current.join(' ').trim();
    if (text) rows.push(splitBullet(text));
    current = null;
  };
  for (const line of markdown.split('\n')) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      current = [bullet[1]];
    } else if (current && line.trim() && !line.startsWith('#')) {
      current.push(line.trim());
    } else if (line.startsWith('#') || !line.trim()) {
      flush();
    }
  }
  flush();
  if (rows.length === 0 && markdown.trim()) rows.push(splitBullet(markdown.trim()));
  return rows;
}

/** Read the cone memory file and render it as memrow cards. */
export async function buildMemoryRows(fs: LocalVfsClient): Promise<HTMLElement[]> {
  let markdown = '';
  try {
    const raw = await fs.readFile(MEMORY_PATH, { encoding: 'utf-8' });
    markdown = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    markdown = '';
  }
  return parseMemoryRows(markdown).map((row) => {
    const el = document.createElement('slicc-memrow');
    el.setAttribute('title', row.title);
    if (row.summary) el.setAttribute('summary', row.summary);
    el.setAttribute('tag', 'project');
    return el;
  });
}
