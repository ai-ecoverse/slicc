/**
 * Delete one frozen session from the Freezer: every file it owns, then its
 * index row, as ONE `/sessions/index.json` transaction.
 *
 * Files go first and the row LAST. An interrupted or partly failed delete
 * leaves the card in the rail — delete again; every step treats "already
 * gone" as done — instead of orphan archives a later corrupt-index rebuild
 * would turn back into sessions. Live rows are refused: the open chat is
 * discarded through New chat → Discard, which the kernel orders with the
 * snapshot writer. Extracted memories are kept; they carry no per-session
 * provenance.
 */

import { createLogger } from '../base/logger.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';
import { curationDirPath, curatorReceiptPath } from '../scoops/agentic-memory.js';
import { LIVE_DELTA_DIR } from '../scoops/live-session-curation.js';
import { type FrozenSessionIndexEntry, SESSIONS_DIR } from '../transcript/frozen-archive-format.js';
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
import { loadFrozenArchive, sidecarPathForArchive } from '../transcript/session-jsonl.js';
import { invalidateSessionSearchIndex } from '../transcript/session-search-index.js';
import { removeSnapshot } from '../transcript/snapshot-store.js';

const log = createLogger('frozen-session-delete');

export type DeleteFrozenSessionResult =
  | { status: 'deleted' }
  | { status: 'not-found' | 'live' | 'unsafe' }
  | { status: 'failed'; errors: string[] };

/** What the index says about one frozen session. `unknown` never means gone. */
export type FrozenRowPresence =
  | { kind: 'present'; row: FrozenSessionIndexEntry }
  | { kind: 'absent'; entries: readonly FrozenSessionIndexEntry[] }
  | { kind: 'unknown' };

const ATTACHMENTS_DIR = `${SESSIONS_DIR}/attachments`;
const ATTACHMENT_PATH = /^\/sessions\/attachments\/([^/]+)\/[^/]+$/;
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

/** `rm` that counts "already gone" as done and records anything else. */
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

/** The key curation deltas were filed under: `sessionId || archive base`, if trusted. */
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

/**
 * The curator's per-session leftovers: delta archives with their receipts
 * and per-pass state, plus the archive's own receipt and state — never the
 * archive itself. Also run after a curator that outlived a delete of its
 * session. `others` is the rest of the index (for `sessionId` trust).
 */
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

/** `/sessions/attachments/<key>/` dirs the archive's messages point into, plus its own base. */
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
    const { messages } = await loadFrozenArchive(vfs, text, row.filename);
    for (const message of messages) {
      for (const attachment of message.attachments ?? []) {
        const key = ATTACHMENT_PATH.exec(attachment.path ?? '')?.[1];
        if (isSafeSessionKey(key)) dirs.add(`${ATTACHMENTS_DIR}/${key}`);
      }
    }
  } catch (err) {
    if (!isEnoent(err)) errors.push(failure(path, err));
  }
  return [...dirs];
}

/**
 * Remove every file one frozen session owns except its index row. `others`
 * is the rest of the index: a `sessionId` another row shares is never used
 * to derive a path (#3807). Returns the failures; "already gone" is not one.
 */
export async function removeFrozenSessionArtifacts(
  vfs: WritableVfsClient,
  row: FrozenSessionIndexEntry,
  others: readonly FrozenSessionIndexEntry[]
): Promise<string[]> {
  if (!isSafeArchiveFilename(row.filename)) return [`unsafe archive name: ${String(row.filename)}`];
  const errors: string[] = [];
  // Read the archive for its attachment dirs BEFORE anything is removed.
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
  // The archive (and its sidecar) is the only record of a pre-rename
  // attachment dir: keep both until everything else is gone, so a retry can
  // still rediscover what is left.
  if (errors.length > 0) return errors;
  await removeTolerant(vfs, sidecarPathForArchive(row.filename), errors);
  await removeTolerant(vfs, `${SESSIONS_DIR}/${row.filename}`, errors);
  return errors;
}

/** Ask the index, inside its lock, whether a frozen session still exists. */
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

/** Delete one frozen session (see the module doc for the ordering contract). */
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
    // Again, leniently: a search rebuild that read the bodies before this
    // delete may have passed its fingerprint check and written them back.
    await invalidateSessionSearchIndex(vfs);
    try {
      await vfs.flush();
    } catch {
      // Best-effort — the store persists on its own debounce.
    }
    log.info('Frozen session deleted', { filename: row.filename });
    return { status: 'deleted' };
  });
}
