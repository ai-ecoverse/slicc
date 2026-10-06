import { type FrozenSessionIndexEntry, SESSIONS_INDEX_PATH } from './frozen-archive-format.js';
import { isDraftArchiveFilename } from './frozen-archive-writer.js';

export interface FrozenSessionKey {
  filename: string;
  sessionId?: string;
}

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

export function isSafeArchiveFilename(name: unknown): name is string {
  return isSafeSegment(name) && name.endsWith('.md') && name.length > '.md'.length;
}

export function isSafeSessionKey(key: unknown): key is string {
  return isSafeSegment(key);
}

export function isChatKeyId(id: string): boolean {
  return id.startsWith('session-');
}

export function trustedSessionId(
  entries: readonly FrozenSessionIndexEntry[],
  row: FrozenSessionIndexEntry
): string | undefined {
  const id = row.sessionId;
  if (!isSafeSessionKey(id) || isChatKeyId(id)) return undefined;
  return entries.some((entry) => entry !== row && entry.sessionId === id) ? undefined : id;
}

export function findFrozenRow(
  entries: readonly FrozenSessionIndexEntry[],
  key: FrozenSessionKey
): FrozenSessionIndexEntry | undefined {
  const byName = entries.find((entry) => entry.filename === key.filename);
  if (byName || !key.sessionId || !isDraftArchiveFilename(key.filename)) return byName;
  const byId = entries.filter((entry) => entry.sessionId === key.sessionId);
  const only = byId.length === 1 ? byId[0] : undefined;
  return only && trustedSessionId(entries, only) === key.sessionId ? only : undefined;
}

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
