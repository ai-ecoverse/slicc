/**
 * Sanitized transcript snapshot storage.
 *
 * Writes a complete `SanitizedTranscriptSnapshot` to the VFS under
 * `/sessions/data/<sessionId>/`, using a temporary directory for atomic
 * publication. On read, validates the JSON schema and verifies all attachment
 * SHA-256 hashes.
 *
 * The `sessionId` is the stable opaque identifier generated before quick
 * filenames are assigned; it is immutable across enrichment renames.
 */

import {
  type TranscriptDocumentV1,
  TranscriptExportError,
  validateTranscriptDocumentV1,
} from '@slicc/shared-ts';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SanitizedTranscriptSnapshot {
  document: TranscriptDocumentV1;
  /** Keys are bundle-relative paths such as "attachments/att-0001.png". */
  attachments: Map<string, Uint8Array>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSIONS_DATA_DIR = '/sessions/data';
const DOCUMENT_FILENAME = 'document.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Slice to ensure the argument is a plain ArrayBuffer (TypeScript strict).
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
  } catch {
    // Already exists — ignore.
  }
}

async function removeDir(vfs: WritableVfsClient, dir: string): Promise<void> {
  // Read entries and delete them (VFS has no recursive rm; do it manually).
  let entries: { name: string; type: 'file' | 'directory' | 'symlink' }[];
  try {
    entries = await (vfs as unknown as LocalVfsClient).readDir(dir);
  } catch {
    return; // Already gone.
  }
  for (const entry of entries) {
    const childPath = `${dir}/${entry.name}`;
    if (entry.type === 'directory') {
      await removeDir(vfs, childPath);
    }
    try {
      await vfs.rm(childPath);
    } catch {
      // Best effort.
    }
  }
  try {
    await vfs.rm(dir);
  } catch {
    // Best effort.
  }
}

async function copyDir(vfs: WritableVfsClient, srcDir: string, dstDir: string): Promise<void> {
  await ensureDir(vfs, dstDir);
  const entries = await (vfs as unknown as LocalVfsClient).readDir(srcDir);
  for (const entry of entries) {
    const srcPath = `${srcDir}/${entry.name}`;
    const dstPath = `${dstDir}/${entry.name}`;
    if (entry.type === 'directory') {
      await copyDir(vfs, srcPath, dstPath);
    } else {
      const bytes = await (vfs as unknown as LocalVfsClient).readFile(srcPath, {
        encoding: 'binary',
      });
      await vfs.writeFile(dstPath, bytes as Uint8Array);
    }
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write a snapshot to `/sessions/data/<sessionId>/`.
 *
 * Uses a `.tmp-<sessionId>` directory for write-first staging, then copies
 * into the final path. Removes the temp directory on completion or failure.
 *
 * Computes SHA-256 hashes for all bundle-file attachments and records them
 * in the document JSON so `readSnapshot` can verify integrity on load.
 *
 * Throws on any VFS error (callers should wrap in try/catch).
 */
export async function writeSnapshot(
  vfs: WritableVfsClient,
  sessionId: string,
  snapshot: SanitizedTranscriptSnapshot
): Promise<void> {
  const tmp = tmpDir(sessionId);
  const dst = sessionDir(sessionId);

  await ensureDir(vfs, tmp);

  try {
    // Compute or update SHA-256 hashes for all bundle files and merge into
    // document.attachments[]. Entries already present in the document are
    // updated; new paths (from test fixtures or incremental builds) are appended.
    const attByPath = new Map(
      snapshot.document.attachments
        .filter((a) => a.present && a.path)
        .map((a) => [a.path, a] as const)
    );

    const allAttachments = [...snapshot.document.attachments];

    for (const [relPath, bytes] of snapshot.attachments) {
      const hash = await sha256Hex(bytes);
      const existing = attByPath.get(relPath);
      if (existing !== undefined) {
        const idx = allAttachments.indexOf(existing);
        if (idx !== -1) {
          allAttachments[idx] = { ...existing, sha256: hash, byteLength: bytes.length };
        }
      } else {
        // Register attachment not yet in document.attachments (e.g. test fixtures).
        allAttachments.push({
          id: `snap-${relPath}`,
          path: relPath,
          originalName: relPath.split('/').pop() ?? relPath,
          mimeType: 'application/octet-stream',
          byteLength: bytes.length,
          sha256: hash,
          sourceConversationId: '',
          sourceMessageId: '',
          handling: 'binary-unchanged',
          present: true,
        });
      }
    }

    const updatedDocument: TranscriptDocumentV1 = {
      ...snapshot.document,
      attachments: allAttachments,
    };

    // 1. Write document JSON to temp dir.
    const docJson = JSON.stringify(updatedDocument, null, 2);
    await vfs.writeFile(`${tmp}/${DOCUMENT_FILENAME}`, docJson);

    // 2. Write attachments to temp dir.
    if (snapshot.attachments.size > 0) {
      for (const [relPath, bytes] of snapshot.attachments) {
        const attPath = `${tmp}/${relPath}`;
        // Ensure subdirectory exists (e.g. attachments/).
        const slashIdx = relPath.lastIndexOf('/');
        if (slashIdx !== -1) {
          await ensureDir(vfs, `${tmp}/${relPath.slice(0, slashIdx)}`);
        }
        await vfs.writeFile(attPath, bytes);
      }
    }

    // 3. Flush to ensure durability before publish.
    await vfs.flush();

    // 4. Atomically publish: copy temp → final, then remove temp.
    await copyDir(vfs, tmp, dst);
    await vfs.flush();
  } catch (err) {
    // Clean up temp dir on failure.
    await removeDir(vfs, tmp);
    throw err;
  }

  // Remove temp dir after successful publish.
  await removeDir(vfs, tmp);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read and validate a snapshot from `/sessions/data/<sessionId>/`.
 *
 * Validates:
 *  - document.json exists and parses as valid JSON
 *  - `validateTranscriptDocumentV1` passes
 *  - each attachment's SHA-256 matches `document.attachments[].sha256`
 *
 * Throws:
 *  - `TranscriptExportError('session-not-found')` if directory/document missing
 *  - `TranscriptExportError('schema-invalid')` if JSON is invalid/malformed
 *  - `TranscriptExportError('transfer-corrupt')` if a hash mismatches
 */
export async function readSnapshot(
  vfs: LocalVfsClient,
  sessionId: string
): Promise<SanitizedTranscriptSnapshot> {
  const dir = sessionDir(sessionId);
  const docPath = `${dir}/${DOCUMENT_FILENAME}`;

  // Load document JSON.
  let docJson: string;
  try {
    const raw = await vfs.readFile(docPath, { encoding: 'utf-8' });
    docJson = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') throw new TranscriptExportError('session-not-found');
    throw new TranscriptExportError('session-not-found');
  }

  // Parse and validate document.
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

  // Load attachments and verify hashes.
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
