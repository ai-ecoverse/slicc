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
  SESSIONS_INDEX_PATH,
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
 * Read the frozen-session entries, distinguishing "no sessions yet" from a
 * TRANSPORT fault. Returns `null` on faults (e.g. a boot-time RPC that was
 * lost before the worker's VFS host attached, timing out 30s later) so the
 * caller preserves whatever the rail currently shows — a late-failing early
 * read used to wipe the cards a later successful refresh had painted.
 */
export async function readFreezerEntries(
  fs: LocalVfsClient
): Promise<FrozenSessionIndexEntry[] | null> {
  let text: string;
  try {
    const raw = await fs.readFile(SESSIONS_INDEX_PATH, { encoding: 'utf-8' });
    text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch (err) {
    // Missing index = genuinely no frozen sessions. Anything else is a fault.
    return (err as { code?: string } | null)?.code === 'ENOENT' ? [] : null;
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as FrozenSessionIndexEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Repopulate the freezer rail's cards. Existing cards are replaced; the
 * `<slicc-freezer-new>` launcher and other children stay.
 */
export function renderFreezerCards(
  freezer: HTMLElement,
  entries: readonly FrozenSessionIndexEntry[]
): void {
  for (const card of Array.from(freezer.querySelectorAll('slicc-freezer-card'))) card.remove();
  freezer.append(...entries.map(frozenCard));
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
