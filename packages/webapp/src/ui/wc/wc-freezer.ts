/**
 * Freezer rail wiring for the WC shell: frozen cone sessions from
 * `/sessions/index.json` render as `<slicc-freezer-card>` entries; selecting
 * one thaws the archive into a read-only thread view. Reuses the legacy
 * freezer's index reader and archive parser verbatim.
 */

import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import {
  type FrozenSessionIndexEntry,
  frozenSessionPath,
  parseFrozenArchive,
  readSessionsIndex,
} from '../session-freezer.js';
import type { ChatMessage } from '../types.js';

export type { FrozenSessionIndexEntry } from '../session-freezer.js';
// The ice-blue freezer accent lives with the shell's context switcher.
export { FREEZER_TINT } from './wc-shell.js';

/** Meta line for a card, e.g. `Jan 1 · 12 turns`. */
function metaLine(entry: FrozenSessionIndexEntry): string {
  const day = new Date(entry.frozenAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${day} · ${entry.messageCount} turns`;
}

/** Build one freezer card; `slug` carries the archive filename. */
export function frozenCard(entry: FrozenSessionIndexEntry): HTMLElement {
  const card = document.createElement('slicc-freezer-card');
  card.setAttribute('title', entry.title);
  card.setAttribute('meta', metaLine(entry));
  card.setAttribute('slug', entry.filename);
  return card;
}

/**
 * Repopulate the freezer rail from the sessions index. Existing cards are
 * replaced; the `<slicc-freezer-new>` launcher and other children stay.
 * Returns the entries so the caller can resolve `freezer-card-select` slugs.
 */
export async function refreshFreezerCards(
  freezer: HTMLElement,
  fs: LocalVfsClient
): Promise<FrozenSessionIndexEntry[]> {
  let entries: FrozenSessionIndexEntry[] = [];
  try {
    entries = await readSessionsIndex(fs);
  } catch {
    entries = [];
  }
  for (const card of Array.from(freezer.querySelectorAll('slicc-freezer-card'))) card.remove();
  freezer.append(...entries.map(frozenCard));
  return entries;
}

/** Read and parse a frozen archive into its title + messages. */
export async function thawFrozenSession(
  fs: LocalVfsClient,
  entry: FrozenSessionIndexEntry
): Promise<{ title: string; messages: ChatMessage[] }> {
  const raw = await fs.readFile(frozenSessionPath(entry), { encoding: 'utf-8' });
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  const parsed = parseFrozenArchive(text);
  return { title: parsed.title || entry.title, messages: parsed.messages };
}
