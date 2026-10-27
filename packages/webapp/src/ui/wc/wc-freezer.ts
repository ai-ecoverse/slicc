/**
 * Freezer rail wiring for the WC shell: frozen cone sessions from
 * `/sessions/index.json` render as `<slicc-freezer-card>` entries; selecting
 * one thaws the archive into a read-only thread view. Reuses the legacy
 * freezer's index reader and archive parser verbatim.
 */

import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import {
  type ArchiveVfs,
  readSessionsIndexForWrite,
  readSessionsIndexState,
  serializeIndexWrite,
  writeSessionsIndexUnlocked,
} from '../../transcript/frozen-archive-writer.js';
import { loadFrozenArchive } from '../../transcript/session-jsonl.js';
import { PRIMARY_CONE_FOLDER } from '../../work-unit/record.js';
import { type FrozenSessionIndexEntry, frozenSessionPath } from '../session-freezer.js';
import type { ChatMessage } from '../types.js';

export type { FrozenSessionIndexEntry } from '../session-freezer.js';
export { SESSIONS_INDEX_PATH } from '../session-freezer.js';
// The ice-blue freezer accent lives with the shell's context switcher.
export { FREEZER_TINT } from './wc-shell.js';

/**
 * Which cone an archive belongs to, for the thawed chat log's header —
 * `undefined` for the primary cone and for legacy archives with no `cone`
 * field, both of which read as "the cone" and would only add noise. The
 * rail card itself never shows it: one Freezer for all cones, attribution
 * lives in the chat log (#2272).
 */
export function coneBadgeFor(entry: FrozenSessionIndexEntry): string | undefined {
  if (!entry.cone || entry.cone === PRIMARY_CONE_FOLDER) return undefined;
  return entry.coneLabel || entry.cone.replace(/^cone-/, '');
}

/** Meta line for a card, e.g. `Jan 1 · 12 turns`. */
function metaLine(entry: FrozenSessionIndexEntry): string {
  const day = new Date(entry.frozenAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const turns = `${day} · ${entry.messageCount} turns`;
  // A compaction snapshot of the chat that is still open in this cone.
  return entry.live ? `${turns} · in progress` : turns;
}

/** Per-host card options: only the leader rail can delete. */
export interface FrozenCardOptions {
  /** Offer the card's trash button (never on a live snapshot). */
  deletable?: boolean;
}

/** Build one freezer card; `slug` carries the archive filename. */
export function frozenCard(
  entry: FrozenSessionIndexEntry,
  opts: FrozenCardOptions = {}
): HTMLElement {
  const card = document.createElement('slicc-freezer-card');
  card.setAttribute('title', entry.title);
  card.setAttribute('meta', metaLine(entry));
  card.setAttribute('slug', entry.filename);
  if (entry.icon) card.setAttribute('icon', entry.icon);
  if (opts.deletable && !entry.live) card.setAttribute('deletable', '');
  return card;
}

/**
 * Backfill rail icons for frozen sessions that don't carry one (quick-frozen
 * and legacy entries): a one-shot LLM pick from the lucide registry per
 * entry, persisted into `/sessions/index.json` and stamped onto the live
 * card. Best-effort throughout — failures leave the snowflake default; the
 * index is re-read right before the write so a concurrent freeze's prepend
 * is not clobbered.
 */
export async function enrichFreezerIcons(deps: {
  reader: LocalVfsClient;
  writer: Pick<ArchiveVfs, 'writeFile'>;
  freezer: HTMLElement;
  entries: readonly FrozenSessionIndexEntry[];
  pickIcon: (subject: string) => Promise<string | null>;
}): Promise<void> {
  const picked = new Map<string, string>();
  for (const entry of deps.entries) {
    if (entry.icon || entry.pendingEnrichment) continue;
    const icon = await deps.pickIcon(`"${entry.title}" — an archived chat session`);
    if (icon) picked.set(entry.filename, icon);
  }
  if (picked.size === 0) return;

  // Re-read and write as ONE index transaction: an unlocked read-then-write
  // could put back a row deleted (or drop a row frozen) in between. The
  // writers' read throws on a fault and rebuilds a corrupt index from the
  // archives; an empty re-read is refused (we were called with entries).
  const written = await serializeIndexWrite(async () => {
    const current = await readSessionsIndexForWrite(deps.reader);
    if (current.length === 0) return false;
    const updated = current.map((e) => {
      const icon = !e.icon && picked.has(e.filename) ? picked.get(e.filename) : undefined;
      return icon ? { ...e, icon } : e;
    });
    await writeSessionsIndexUnlocked(deps.writer, updated);
    return true;
  });
  if (!written) return;

  for (const card of deps.freezer.querySelectorAll('slicc-freezer-card')) {
    const icon = picked.get(card.getAttribute('slug') ?? '');
    if (icon && !card.hasAttribute('icon')) card.setAttribute('icon', icon);
  }
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
  const state = await readFreezerIndexState(fs);
  if (state.kind === 'ok') return state.entries;
  if (state.kind === 'missing') return [];
  // Corrupt indexes are FAULTS too — "corrupt = empty" would wipe the rail
  // (and let downstream writers persist the wipe). The rail's refresh runs
  // the archive rebuild for the corrupt case instead.
  return null;
}

/** Discriminated read of the frozen-session index. */
export type FreezerIndexState =
  | { kind: 'ok'; entries: FrozenSessionIndexEntry[] }
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'fault' };

export async function readFreezerIndexState(fs: LocalVfsClient): Promise<FreezerIndexState> {
  try {
    // Missing = genuinely no frozen sessions. Corrupt (e.g. a write cut off
    // by a reload killing the worker) is rebuilt from the archives, the
    // ground truth, by the caller. Any other read failure is a fault.
    return await readSessionsIndexState(fs);
  } catch {
    return { kind: 'fault' };
  }
}

/**
 * Rebuild a corrupt index from the archives and publish it as ONE index
 * transaction, re-checking the corruption inside the lock: a scan taken
 * outside it could publish a row a concurrent delete just removed. The
 * rebuild is the writers' own ({@link readSessionsIndexForWrite}), so the
 * rail and every writer agree on what a corrupt index holds. Returns the
 * rows to render, or `null` when there is nothing to show.
 */
export function recoverCorruptFreezerIndex(
  reader: LocalVfsClient,
  writer: Pick<ArchiveVfs, 'writeFile'>
): Promise<FrozenSessionIndexEntry[] | null> {
  return serializeIndexWrite(async () => {
    const state = await readFreezerIndexState(reader);
    if (state.kind === 'ok') return state.entries;
    if (state.kind !== 'corrupt') return null;
    let entries: FrozenSessionIndexEntry[];
    try {
      entries = await readSessionsIndexForWrite(reader);
    } catch {
      // The archives cannot be listed right now; the next refresh retries.
      return null;
    }
    if (entries.length === 0) return null;
    await writeSessionsIndexUnlocked(writer, entries);
    return entries;
  });
}

/**
 * Repopulate the freezer rail's cards. Existing cards are replaced; the
 * `<slicc-freezer-new>` launcher and other children stay.
 */
export function renderFreezerCards(
  freezer: HTMLElement,
  entries: readonly FrozenSessionIndexEntry[],
  opts: FrozenCardOptions = {}
): void {
  for (const card of Array.from(freezer.querySelectorAll('slicc-freezer-card'))) card.remove();
  freezer.append(...entries.map((entry) => frozenCard(entry, opts)));
}

/** Read and parse a frozen archive into its title + messages. */
export async function thawFrozenSession(
  fs: LocalVfsClient,
  entry: FrozenSessionIndexEntry
): Promise<{ title: string; messages: ChatMessage[] }> {
  const raw = await fs.readFile(frozenSessionPath(entry), { encoding: 'utf-8' });
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  const parsed = await loadFrozenArchive(fs, text, entry.filename);
  return { title: parsed.title || entry.title, messages: parsed.messages };
}
