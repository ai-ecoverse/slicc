import {
  type TranscriptDocumentV1,
  TranscriptExportError,
  validateTranscriptDocumentV1,
} from '@slicc/shared-ts';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';

export interface SanitizedTranscriptSnapshot {
  document: TranscriptDocumentV1;

  attachments: Map<string, Uint8Array>;
}

const SESSIONS_DATA_DIR = '/sessions/data';
const DOCUMENT_FILENAME = 'document.json';
const PUBLISHING_FILENAME = '.publishing';

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function assertSafeSessionId(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    /[/\\\x00]/.test(sessionId) ||
    sessionId === '..' ||
    sessionId === '.' ||
    sessionId.includes('..') ||
    !/^[a-zA-Z0-9._-]+$/.test(sessionId)
  ) {
    throw new TranscriptExportError('session-not-found');
  }
}

function sessionDir(sessionId: string): string {
  return `${SESSIONS_DATA_DIR}/${sessionId}`;
}

function tmpDir(sessionId: string): string {
  return `${SESSIONS_DATA_DIR}/.tmp-${sessionId}`;
}

async function ensureDir(vfs: WritableVfsClient, path: string): Promise<void> {
  try {
    await vfs.mkdir(path, { recursive: true });
  } catch {}
}

async function removeDir(vfs: WritableVfsClient, dir: string): Promise<void> {
  let entries: { name: string; type: 'file' | 'directory' | 'symlink' }[];
  try {
    entries = await (vfs as unknown as LocalVfsClient).readDir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const childPath = `${dir}/${entry.name}`;
    if (entry.type === 'directory') {
      await removeDir(vfs, childPath);
    }
    try {
      await vfs.rm(childPath);
    } catch {}
  }
  try {
    await vfs.rm(dir);
  } catch {}
}

async function clearDestination(vfs: WritableVfsClient, dir: string): Promise<void> {
  const entries = await (vfs as unknown as LocalVfsClient).readDir(dir);
  for (const entry of entries) {
    if (entry.name === PUBLISHING_FILENAME) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.type === 'directory') await removeDir(vfs, path);
    else await vfs.rm(path);
  }
}

async function copyDir(
  vfs: WritableVfsClient,
  srcDir: string,
  dstDir: string,
  signal?: AbortSignal
): Promise<void> {
  assertNotAborted(signal);
  await ensureDir(vfs, dstDir);
  const entries = await (vfs as unknown as LocalVfsClient).readDir(srcDir);
  for (const entry of entries) {
    assertNotAborted(signal);
    const srcPath = `${srcDir}/${entry.name}`;
    const dstPath = `${dstDir}/${entry.name}`;
    if (entry.type === 'directory') {
      await copyDir(vfs, srcPath, dstPath, signal);
    } else {
      const bytes = await (vfs as unknown as LocalVfsClient).readFile(srcPath, {
        encoding: 'binary',
      });
      await vfs.writeFile(dstPath, bytes as Uint8Array);
    }
  }
}

export async function writeSnapshot(
  vfs: WritableVfsClient,
  sessionId: string,
  snapshot: SanitizedTranscriptSnapshot,
  signal?: AbortSignal
): Promise<void> {
  assertSafeSessionId(sessionId);
  const tmp = tmpDir(sessionId);
  const dst = sessionDir(sessionId);

  const attByPath = new Map(
    snapshot.document.attachments
      .filter((a) => a.present && a.path)
      .map((a) => [a.path, a] as const)
  );
  for (const [relPath] of snapshot.attachments) {
    if (!attByPath.has(relPath)) {
      throw new TranscriptExportError('schema-invalid');
    }
  }

  assertNotAborted(signal);
  await ensureDir(vfs, tmp);
  let destinationPublishing = false;

  try {
    const allAttachments = [...snapshot.document.attachments];

    for (const [relPath, bytes] of snapshot.attachments) {
      assertNotAborted(signal);
      const hash = await sha256Hex(bytes);
      const existing = attByPath.get(relPath);
      if (existing !== undefined) {
        const idx = allAttachments.indexOf(existing);
        if (idx !== -1) {
          allAttachments[idx] = { ...existing, sha256: hash, byteLength: bytes.length };
        }
      }
    }

    const updatedDocument: TranscriptDocumentV1 = {
      ...snapshot.document,
      attachments: allAttachments,
    };

    const docJson = JSON.stringify(updatedDocument, null, 2);
    await vfs.writeFile(`${tmp}/${DOCUMENT_FILENAME}`, docJson);

    if (snapshot.attachments.size > 0) {
      for (const [relPath, bytes] of snapshot.attachments) {
        const attPath = `${tmp}/${relPath}`;

        const slashIdx = relPath.lastIndexOf('/');
        if (slashIdx !== -1) {
          await ensureDir(vfs, `${tmp}/${relPath.slice(0, slashIdx)}`);
        }
        await vfs.writeFile(attPath, bytes);
      }
    }

    await vfs.flush();

    assertNotAborted(signal);
    await ensureDir(vfs, dst);
    destinationPublishing = true;
    await vfs.writeFile(`${dst}/${PUBLISHING_FILENAME}`, 'in-progress');
    await clearDestination(vfs, dst);
    assertNotAborted(signal);
    await copyDir(vfs, tmp, dst, signal);
    await vfs.flush();
    assertNotAborted(signal);
    await vfs.rm(`${dst}/${PUBLISHING_FILENAME}`);
  } catch (err) {
    if (destinationPublishing) {
      try {
        await clearDestination(vfs, dst);
      } catch {}
    }
    await removeDir(vfs, tmp);
    throw err;
  }

  await removeDir(vfs, tmp);
}

export async function readSnapshot(
  vfs: LocalVfsClient,
  sessionId: string
): Promise<SanitizedTranscriptSnapshot> {
  assertSafeSessionId(sessionId);
  const dir = sessionDir(sessionId);
  const docPath = `${dir}/${DOCUMENT_FILENAME}`;

  try {
    await vfs.stat(`${dir}/${PUBLISHING_FILENAME}`);
    throw new TranscriptExportError('session-not-found');
  } catch (err) {
    if (err instanceof TranscriptExportError) throw err;
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
  }

  let docJson: string;
  try {
    const raw = await vfs.readFile(docPath, { encoding: 'utf-8' });
    docJson = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    throw new TranscriptExportError('session-not-found');
  }

  let document: TranscriptDocumentV1;
  try {
    document = JSON.parse(docJson) as TranscriptDocumentV1;
  } catch {
    throw new TranscriptExportError('schema-invalid');
  }

  const validation = validateTranscriptDocumentV1(document);
  if (!validation.ok) {
    throw new TranscriptExportError('schema-invalid');
  }

  const attachments = new Map<string, Uint8Array>();
  for (const att of document.attachments) {
    if (!att.present || !att.path) continue;
    const attPath = `${dir}/${att.path}`;
    let bytes: Uint8Array;
    try {
      const raw = await vfs.readFile(attPath, { encoding: 'binary' });
      bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw as string);
    } catch {
      throw new TranscriptExportError('transfer-corrupt');
    }
    const actualHash = await sha256Hex(bytes);
    if (actualHash !== att.sha256) {
      throw new TranscriptExportError('transfer-corrupt');
    }
    attachments.set(att.path, bytes);
  }

  return { document, attachments };
}
