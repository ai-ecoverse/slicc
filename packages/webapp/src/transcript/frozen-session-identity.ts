/**
 * Identity and path-safety rules for one `/sessions/index.json` row.
 *
 * Rows are unvalidated casts — any writer with VFS access, the agent
 * included, can put anything in the index — and the VFS resolves `..`, so
 * every caller that derives a path from a row validates here first. A
 * `sessionId` is only trusted when no other row shares it: indexes rebuilt
 * before #3807 gave every chat of a cone the same per-cone chat key.
 */

import { type FrozenSessionIndexEntry, SESSIONS_INDEX_PATH } from './frozen-archive-format.js';

/** What a caller holds for one frozen session: the rail card's slug and id. */
export interface FrozenSessionKey {
  filename: string;
  sessionId?: string;
}

/** The read the presence oracle needs. */
export interface IndexReader {
  readFile(path: string, options: { encoding: 'utf-8' }): Promise<string | Uint8Array>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isSafeSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SAFE_SEGMENT.test(value) &&
    !value.startsWith('.') &&
    !value.includes('..')
  );
}

/** A direct `/sessions/` child archive: `<safe segment>.md`. */
export function isSafeArchiveFilename(name: unknown): name is string {
  return isSafeSegment(name) && name.endsWith('.md') && name.length > '.md'.length;
}

/** A `sessionId` or archive base usable as one path segment. */
export function isSafeSessionKey(key: unknown): key is string {
  return isSafeSegment(key);
}

/** A per-cone chat key (`session-<folder>`) — never a per-freeze identity (#3807). */
export function isChatKeyId(id: string): boolean {
  return id.startsWith('session-');
}

/** Provisional archive names an enrichment may still rename (`pending-` / `live-`). */
export function isDraftArchiveName(filename: string): boolean {
  return filename.startsWith('pending-') || filename.startsWith('live-');
}

/**
 * `row.sessionId` when it is a path-safe per-freeze id (not a chat key) and
 * no OTHER row in `entries` shares it.
 */
export function trustedSessionId(
  entries: readonly FrozenSessionIndexEntry[],
  row: FrozenSessionIndexEntry
): string | undefined {
  const id = row.sessionId;
  if (!isSafeSessionKey(id) || isChatKeyId(id)) return undefined;
  return entries.some((entry) => entry !== row && entry.sessionId === id) ? undefined : id;
}

/**
 * The row a key names: by filename first. Only a DRAFT name (which an
 * enrichment may have renamed between render and use) falls back to the
 * one row carrying the key's trusted `sessionId`; anything else matches
 * nothing, so a stale card can never resolve to a different chat.
 */
export function findFrozenRow(
  entries: readonly FrozenSessionIndexEntry[],
  key: FrozenSessionKey
): FrozenSessionIndexEntry | undefined {
  const byName = entries.find((entry) => entry.filename === key.filename);
  if (byName || !key.sessionId || !isDraftArchiveName(key.filename)) return byName;
  const byId = entries.filter((entry) => entry.sessionId === key.sessionId);
  const only = byId.length === 1 ? byId[0] : undefined;
  return only && trustedSessionId(entries, only) === key.sessionId ? only : undefined;
}

/**
 * The index as a presence oracle: its rows, or `null` when it cannot say
 * (missing, unreadable, malformed). Never read `null` as "absent" — a
 * corrupt index is not a deleted session.
 */
export async function readIndexForPresence(
  vfs: IndexReader
): Promise<FrozenSessionIndexEntry[] | null> {
  try {
    const raw = await vfs.readFile(SESSIONS_INDEX_PATH, { encoding: 'utf-8' });
    const parsed: unknown = JSON.parse(
      typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    );
    return Array.isArray(parsed) ? (parsed as FrozenSessionIndexEntry[]) : null;
  } catch {
    return null;
  }
}
