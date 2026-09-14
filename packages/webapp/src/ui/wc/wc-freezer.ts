import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import { loadFrozenArchive } from '../../transcript/session-jsonl.js';
import { PRIMARY_CONE_FOLDER } from '../../work-unit/record.js';
import {
  type FrozenSessionIndexEntry,
  frozenSessionPath,
  parseFrozenArchive,
  SESSIONS_INDEX_PATH,
} from '../session-freezer.js';
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

export function frozenCard(entry: FrozenSessionIndexEntry): HTMLElement {
  const card = document.createElement('slicc-freezer-card');
  card.setAttribute('title', entry.title);
  card.setAttribute('meta', metaLine(entry));
  card.setAttribute('slug', entry.filename);
  if (entry.icon) card.setAttribute('icon', entry.icon);
  return card;
}

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
  let text: string;
  try {
    const raw = await fs.readFile(SESSIONS_INDEX_PATH, { encoding: 'utf-8' });
    text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch (err) {
    return (err as { code?: string } | null)?.code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'fault' };
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return { kind: 'corrupt' };
    return { kind: 'ok', entries: parsed as FrozenSessionIndexEntry[] };
  } catch {
    return { kind: 'corrupt' };
  }
}

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
      entries.push(entryFromArchive(filename, text));
    } catch {}
  }
  entries.sort((a, b) => b.frozenAt.localeCompare(a.frozenAt));
  return entries;
}

function entryFromArchive(filename: string, text: string): FrozenSessionIndexEntry {
  const header = text.slice(0, 2000);
  const title = /^title:\s*"?(.*?)"?\s*$/m.exec(header)?.[1] ?? filename;
  const frozenAt = /^frozenAt:\s*"?(.*?)"?\s*$/m.exec(header)?.[1] ?? new Date(0).toISOString();
  const messageCount = Number(/^messageCount:\s*(\d+)\s*$/m.exec(header)?.[1] ?? 0);
  const parsed = parseFrozenArchive(text);

  const pending = filename.startsWith('pending-') || (filename.startsWith('live-') && !parsed.live);
  return {
    filename,
    title,
    frozenAt,
    messageCount,
    ...(parsed.cost ? { cost: parsed.cost } : {}),
    ...(parsed.models ? { models: parsed.models } : {}),
    ...(parsed.cone ? { cone: parsed.cone } : {}),
    ...(parsed.coneLabel ? { coneLabel: parsed.coneLabel } : {}),
    ...(parsed.memorySkipped ? { memorySkipped: true as const } : {}),
    ...(parsed.live ? { live: true as const } : {}),
    ...(parsed.live && parsed.liveThrough ? { liveThrough: parsed.liveThrough } : {}),
    ...(parsed.live && parsed.compactions ? { compactions: parsed.compactions } : {}),
    ...(parsed.id ? { sessionId: parsed.id } : {}),
    ...(pending ? { pendingEnrichment: true } : {}),
  };
}

export function renderFreezerCards(
  freezer: HTMLElement,
  entries: readonly FrozenSessionIndexEntry[]
): void {
  for (const card of Array.from(freezer.querySelectorAll('slicc-freezer-card'))) card.remove();
  freezer.append(...entries.map(frozenCard));
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
