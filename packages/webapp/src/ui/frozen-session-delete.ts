import { createLogger } from '../base/logger.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';
import { curationDirPath, curatorReceiptPath } from '../scoops/agentic-memory.js';
import { LIVE_DELTA_DIR } from '../scoops/live-session-curation.js';
import {
  type FrozenSessionIndexEntry,
  parseFrozenArchive,
  SESSIONS_DIR,
} from '../transcript/frozen-archive-format.js';
import {
  readSessionsIndexForWrite,
  serializeIndexWrite,
  writeSessionsIndexUnlocked,
} from '../transcript/frozen-archive-writer.js';
import {
  type FrozenSessionKey,
  findFrozenRow,
  isSafeArchiveFilename,
  isSafeSessionKey,
  readIndexForPresence,
  trustedSessionId,
} from '../transcript/frozen-session-identity.js';
import { sidecarPathForArchive } from '../transcript/session-jsonl.js';
import { invalidateSessionSearchIndex } from '../transcript/session-search-index.js';
import { removeSnapshot } from '../transcript/snapshot-store.js';

const log = createLogger('frozen-session-delete');

export type DeleteFrozenSessionResult =
  | { status: 'deleted' }
  | { status: 'not-found' | 'live' | 'unsafe' }
  | { status: 'failed'; errors: string[] };

export type FrozenRowPresence =
  | { kind: 'present'; row: FrozenSessionIndexEntry }
  | { kind: 'absent'; entries: readonly FrozenSessionIndexEntry[] }
  | { kind: 'unknown' };

const ATTACHMENTS_DIR = `${SESSIONS_DIR}/attachments`;
const DELTA_RANGE = /^\d+-\d+\.md$/;

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}

function failure(path: string, err: unknown): string {
  return `${path}: ${err instanceof Error ? err.message : String(err)}`;
}

function archiveBase(filename: string): string {
  return filename.slice(0, -'.md'.length);
}

async function removeTolerant(
  vfs: WritableVfsClient,
  path: string,
  errors: string[],
  recursive = false
): Promise<void> {
  try {
    await vfs.rm(path, recursive ? { recursive: true } : undefined);
  } catch (err) {
    if (!isEnoent(err)) errors.push(failure(path, err));
  }
}

function deltaKeyOf(
  row: FrozenSessionIndexEntry,
  entries: readonly FrozenSessionIndexEntry[]
): string | undefined {
  if (!row.sessionId) return archiveBase(row.filename);
  return trustedSessionId(entries, row);
}

async function deltaArchivesOf(
  vfs: WritableVfsClient,
  key: string,
  errors: string[]
): Promise<string[]> {
  let names: string[];
  try {
    names = (await vfs.readDir(LIVE_DELTA_DIR)).map((entry) => entry.name);
  } catch (err) {
    if (!isEnoent(err)) errors.push(failure(LIVE_DELTA_DIR, err));
    return [];
  }
  const prefix = `${key}-`;
  return names
    .filter((name) => name.startsWith(prefix) && DELTA_RANGE.test(name.slice(prefix.length)))
    .map((name) => `${LIVE_DELTA_DIR}/${name}`);
}

export async function removeCuratorByproducts(
  vfs: WritableVfsClient,
  row: FrozenSessionIndexEntry,
  others: readonly FrozenSessionIndexEntry[]
): Promise<string[]> {
  if (!isSafeArchiveFilename(row.filename)) return [`unsafe archive name: ${String(row.filename)}`];
  const errors: string[] = [];
  const key = deltaKeyOf(row, [...others, row]);
  const deltas = key ? await deltaArchivesOf(vfs, key, errors) : [];
  for (const delta of deltas) await removeTolerant(vfs, delta, errors);
  for (const mined of [...deltas, `${SESSIONS_DIR}/${row.filename}`]) {
    await removeTolerant(vfs, curatorReceiptPath(mined), errors);
    await removeTolerant(vfs, curationDirPath(mined), errors, true);
  }
  return errors;
}

async function attachmentDirsOf(
  vfs: WritableVfsClient,
  row: FrozenSessionIndexEntry,
  errors: string[]
): Promise<string[]> {
  const dirs = new Set([`${ATTACHMENTS_DIR}/${archiveBase(row.filename)}`]);
  const path = `${SESSIONS_DIR}/${row.filename}`;
  try {
    const raw = await vfs.readFile(path, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const { attachmentsKey } = parseFrozenArchive(text);
    if (isSafeSessionKey(attachmentsKey)) dirs.add(`${ATTACHMENTS_DIR}/${attachmentsKey}`);
  } catch (err) {
    if (!isEnoent(err)) errors.push(failure(path, err));
  }
  return [...dirs];
}

export async function removeFrozenSessionArtifacts(
  vfs: WritableVfsClient,
  row: FrozenSessionIndexEntry,
  others: readonly FrozenSessionIndexEntry[]
): Promise<string[]> {
  if (!isSafeArchiveFilename(row.filename)) return [`unsafe archive name: ${String(row.filename)}`];
  const errors: string[] = [];

  const attachmentDirs = await attachmentDirsOf(vfs, row, errors);
  const sessionId = trustedSessionId([...others, row], row);
  if (sessionId) {
    try {
      await removeSnapshot(vfs, sessionId);
    } catch (err) {
      errors.push(failure(`${SESSIONS_DIR}/data/${sessionId}`, err));
    }
  }
  errors.push(...(await removeCuratorByproducts(vfs, row, others)));
  for (const dir of attachmentDirs) await removeTolerant(vfs, dir, errors, true);

  if (errors.length > 0) return errors;
  await removeTolerant(vfs, sidecarPathForArchive(row.filename), errors);
  await removeTolerant(vfs, `${SESSIONS_DIR}/${row.filename}`, errors);
  return errors;
}

export function findIndexedFrozenRow(
  vfs: WritableVfsClient,
  key: FrozenSessionKey
): Promise<FrozenRowPresence> {
  return serializeIndexWrite(async (): Promise<FrozenRowPresence> => {
    const entries = await readIndexForPresence(vfs);
    if (entries === null) return { kind: 'unknown' };
    const row = findFrozenRow(entries, key);
    return row ? { kind: 'present', row } : { kind: 'absent', entries };
  });
}

export function deleteFrozenSession(
  vfs: WritableVfsClient,
  key: FrozenSessionKey
): Promise<DeleteFrozenSessionResult> {
  return serializeIndexWrite(async (): Promise<DeleteFrozenSessionResult> => {
    const entries = await readSessionsIndexForWrite(vfs);
    const row = findFrozenRow(entries, key);
    if (!row) return { status: 'not-found' };
    if (row.live) return { status: 'live' };
    if (!isSafeArchiveFilename(row.filename)) return { status: 'unsafe' };
    const others = entries.filter((entry) => entry !== row);
    const errors = await removeFrozenSessionArtifacts(vfs, row, others);
    try {
      await invalidateSessionSearchIndex(vfs, { strict: true });
    } catch (err) {
      errors.push(failure('/sessions/.search-index.json', err));
    }
    if (errors.length > 0) {
      log.warn('Frozen session delete incomplete — row kept for a retry', {
        filename: row.filename,
        errors,
      });
      return { status: 'failed', errors };
    }
    await writeSessionsIndexUnlocked(vfs, others);

    await invalidateSessionSearchIndex(vfs);
    try {
      await vfs.flush();
    } catch {}
    log.info('Frozen session deleted', { filename: row.filename });
    return { status: 'deleted' };
  });
}
