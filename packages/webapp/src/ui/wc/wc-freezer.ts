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

export { FREEZER_TINT } from './wc-shell.js';

export function coneBadgeFor(entry: FrozenSessionIndexEntry): string | undefined {
  if (!entry.cone || entry.cone === PRIMARY_CONE_FOLDER) return undefined;
  return entry.coneLabel || entry.cone.replace(/^cone-/, '');
}

function metaLine(entry: FrozenSessionIndexEntry): string {
  const day = new Date(entry.frozenAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const turns = `${day} · ${entry.messageCount} turns`;

  return entry.live ? `${turns} · in progress` : turns;
}

export interface FrozenCardOptions {
  deletable?: boolean;
}

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

export async function readFreezerEntries(
  fs: LocalVfsClient
): Promise<FrozenSessionIndexEntry[] | null> {
  const state = await readFreezerIndexState(fs);
  if (state.kind === 'ok') return state.entries;
  if (state.kind === 'missing') return [];

  return null;
}

export type FreezerIndexState =
  | { kind: 'ok'; entries: FrozenSessionIndexEntry[] }
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'fault' };

export async function readFreezerIndexState(fs: LocalVfsClient): Promise<FreezerIndexState> {
  try {
    return await readSessionsIndexState(fs);
  } catch {
    return { kind: 'fault' };
  }
}

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
      return null;
    }
    if (entries.length === 0) return null;
    await writeSessionsIndexUnlocked(writer, entries);
    return entries;
  });
}

export function renderFreezerCards(
  freezer: HTMLElement,
  entries: readonly FrozenSessionIndexEntry[],
  opts: FrozenCardOptions = {}
): void {
  for (const card of Array.from(freezer.querySelectorAll('slicc-freezer-card'))) card.remove();
  freezer.append(...entries.map((entry) => frozenCard(entry, opts)));
}

export async function thawFrozenSession(
  fs: LocalVfsClient,
  entry: FrozenSessionIndexEntry
): Promise<{ title: string; messages: ChatMessage[] }> {
  const raw = await fs.readFile(frozenSessionPath(entry), { encoding: 'utf-8' });
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  const parsed = await loadFrozenArchive(fs, text, entry.filename);
  return { title: parsed.title || entry.title, messages: parsed.messages };
}
