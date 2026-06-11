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
export { SESSIONS_INDEX_PATH } from '../session-freezer.js';
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
  if (entry.icon) card.setAttribute('icon', entry.icon);
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
  writer: { writeFile(path: string, content: string): Promise<unknown> };
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

  // Re-read right before the write; refuse to write over a fault, a corrupt
  // index, OR an empty one (we were called with entries — an empty re-read
  // means something is wrong, and writing would persist a wipe).
  const current = await readFreezerEntries(deps.reader);
  if (current === null || current.length === 0) return;
  const updated = current.map((e) => {
    const icon = !e.icon && picked.has(e.filename) ? picked.get(e.filename) : undefined;
    return icon ? { ...e, icon } : e;
  });
  await deps.writer.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));

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
  let text: string;
  try {
    const raw = await fs.readFile(SESSIONS_INDEX_PATH, { encoding: 'utf-8' });
    text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch (err) {
    // Missing index = genuinely no frozen sessions. Anything else is a fault.
    return (err as { code?: string } | null)?.code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'fault' };
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return { kind: 'corrupt' };
    return { kind: 'ok', entries: parsed as FrozenSessionIndexEntry[] };
  } catch {
    // E.g. a write cut off mid-file by a reload killing the worker. The
    // archives are the ground truth — callers rebuild from them.
    return { kind: 'corrupt' };
  }
}

/**
 * Rebuild the frozen-session index from the `/sessions/*.md` archives — the
 * ground truth when `index.json` is corrupt (e.g. truncated by a reload that
 * killed the worker mid-write). Titles / timestamps / counts come from each
 * archive's YAML-style header; `pending-*` filenames keep their enrichment
 * marker. Entries sort newest-first like the live index.
 */
export async function rebuildFreezerIndexFromArchives(
  fs: LocalVfsClient
): Promise<FrozenSessionIndexEntry[]> {
  let names: string[];
  try {
    const dir = await fs.readDir('/sessions');
    names = dir.filter((d) => d.type === 'file' && d.name.endsWith('.md')).map((d) => d.name);
  } catch {
    return [];
  }
  const entries: FrozenSessionIndexEntry[] = [];
  for (const filename of names) {
    try {
      const raw = await fs.readFile(`/sessions/${filename}`, { encoding: 'utf-8' });
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      const header = text.slice(0, 2000);
      const title = /^title:\s*"?(.*?)"?\s*$/m.exec(header)?.[1] ?? filename;
      const frozenAt = /^frozenAt:\s*"?(.*?)"?\s*$/m.exec(header)?.[1] ?? new Date(0).toISOString();
      const messageCount = Number(/^messageCount:\s*(\d+)\s*$/m.exec(header)?.[1] ?? 0);
      entries.push({
        filename,
        title,
        frozenAt,
        messageCount,
        ...(filename.startsWith('pending-') ? { pendingEnrichment: true } : {}),
      });
    } catch {
      // Unreadable archive — skip it rather than failing the whole rebuild.
    }
  }
  entries.sort((a, b) => b.frozenAt.localeCompare(a.frozenAt));
  return entries;
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
