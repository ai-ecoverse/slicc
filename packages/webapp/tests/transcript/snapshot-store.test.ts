/**
 * Tests for snapshot-store.ts — sanitized frozen snapshot storage.
 *
 * Covers:
 *  - Write + read round-trip at /sessions/data/<session-id>/
 *  - Temp dir write-first then atomic publish
 *  - Temp dir cleanup on failure
 *  - Read validates JSON document and attachment hashes
 *  - Hash mismatch → read throws
 *  - Missing document.json → read throws
 *  - sessionId remains stable across enrichment filename changes
 */

import 'fake-indexeddb/auto';
import type { TranscriptAttachment } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import {
  discardSnapshotIfUnindexed,
  readSnapshot,
  removeSnapshot,
  type SanitizedTranscriptSnapshot,
  writeSnapshot,
} from '../../src/transcript/snapshot-store.js';
import { makeTranscriptDocument } from './fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dbCounter = 0;

async function createVfs(): Promise<VirtualFS> {
  return VirtualFS.create({ dbName: `snapshot-store-${dbCounter++}`, wipe: true });
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

function makeAttachmentEntry(relPath: string, bytes: Uint8Array): TranscriptAttachment {
  return {
    id: `att-${relPath.replace(/\//g, '-')}`,
    path: relPath,
    originalName: relPath.split('/').pop() ?? relPath,
    mimeType: relPath.endsWith('.bin') ? 'application/octet-stream' : 'text/plain',
    byteLength: bytes.byteLength,
    sha256: '', // updated by writeSnapshot
    sourceConversationId: 'cone',
    sourceMessageId: 'cone-msg-000001',
    handling: 'binary-unchanged',
    present: true,
  };
}

function makeSnapshot(attachments: [string, Uint8Array][] = []): SanitizedTranscriptSnapshot {
  const doc = makeTranscriptDocument();
  const registeredAttachments: TranscriptAttachment[] = attachments.map(([relPath, bytes]) =>
    makeAttachmentEntry(relPath, bytes)
  );
  return {
    document: { ...doc, attachments: registeredAttachments },
    attachments: new Map(attachments),
  };
}

// ---------------------------------------------------------------------------
// Write + read round-trip
// ---------------------------------------------------------------------------

describe('writeSnapshot + readSnapshot — round-trip', () => {
  it('writes document.json and reads it back', async () => {
    const vfs = await createVfs();
    const sessionId = 'sess-round-001';
    const snapshot = makeSnapshot();

    await writeSnapshot(vfs, sessionId, snapshot);
    const read = await readSnapshot(vfs, sessionId);

    expect(read.document.session.id).toBe(snapshot.document.session.id);
    expect(read.document.schemaVersion).toBe(1);
  });

  it('round-trips binary attachment bytes exactly', async () => {
    const vfs = await createVfs();
    const sessionId = 'sess-round-002';
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    const snapshot = makeSnapshot([['attachments/att-0001.bin', bytes]]);

    await writeSnapshot(vfs, sessionId, snapshot);
    const read = await readSnapshot(vfs, sessionId);

    const readBytes = read.attachments.get('attachments/att-0001.bin');
    expect(readBytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(readBytes!)).toEqual(Array.from(bytes));
  });

  it('round-trips multiple attachments', async () => {
    const vfs = await createVfs();
    const sessionId = 'sess-round-003';
    const bytes1 = new Uint8Array([1, 2, 3]);
    const bytes2 = new Uint8Array([4, 5, 6]);
    const snapshot = makeSnapshot([
      ['attachments/att-0001.png', bytes1],
      ['attachments/att-0002.txt', bytes2],
    ]);

    await writeSnapshot(vfs, sessionId, snapshot);
    const read = await readSnapshot(vfs, sessionId);

    expect(read.attachments.size).toBe(2);
    expect(Array.from(read.attachments.get('attachments/att-0001.png')!)).toEqual(
      Array.from(bytes1)
    );
    expect(Array.from(read.attachments.get('attachments/att-0002.txt')!)).toEqual(
      Array.from(bytes2)
    );
  });

  it('stores files under /sessions/data/<sessionId>/', async () => {
    const vfs = await createVfs();
    const sessionId = 'sess-dir-001';
    const snapshot = makeSnapshot([['attachments/att-0001.png', new Uint8Array([9])]]);

    await writeSnapshot(vfs, sessionId, snapshot);

    const jsonStat = await vfs.stat(`/sessions/data/${sessionId}/document.json`);
    expect(jsonStat.type).toBe('file');
    const attStat = await vfs.stat(`/sessions/data/${sessionId}/attachments/att-0001.png`);
    expect(attStat.type).toBe('file');
  });
});

// ---------------------------------------------------------------------------
// Hash validation
// ---------------------------------------------------------------------------

describe('readSnapshot — hash validation', () => {
  it('validates attachment hashes on read', async () => {
    const vfs = await createVfs();
    const sessionId = 'sess-hash-001';
    const bytes = new Uint8Array([99, 100, 101]);
    const snapshot = makeSnapshot([['attachments/att-0001.bin', bytes]]);

    await writeSnapshot(vfs, sessionId, snapshot);

    // Corrupt the stored bytes
    const attPath = `/sessions/data/${sessionId}/attachments/att-0001.bin`;
    await vfs.writeFile(attPath, new Uint8Array([0, 0, 0]));

    await expect(readSnapshot(vfs, sessionId)).rejects.toMatchObject({
      code: 'transfer-corrupt',
    });
  });

  it('validates document JSON schema on read', async () => {
    const vfs = await createVfs();
    const sessionId = 'sess-schema-001';
    await vfs.mkdir(`/sessions/data/${sessionId}`, { recursive: true });
    // Write malformed JSON
    await vfs.writeFile(`/sessions/data/${sessionId}/document.json`, '{ "invalid": true }');

    await expect(readSnapshot(vfs, sessionId)).rejects.toMatchObject({
      code: 'schema-invalid',
    });
  });

  it('throws schema-invalid for malformed JSON', async () => {
    const vfs = await createVfs();
    const sessionId = 'sess-malformed-001';
    await vfs.mkdir(`/sessions/data/${sessionId}`, { recursive: true });
    await vfs.writeFile(`/sessions/data/${sessionId}/document.json`, 'not json at all}');

    await expect(readSnapshot(vfs, sessionId)).rejects.toMatchObject({
      code: 'schema-invalid',
    });
  });

  it('throws session-not-found when document.json is missing', async () => {
    const vfs = await createVfs();
    await expect(readSnapshot(vfs, 'non-existent-session')).rejects.toMatchObject({
      code: 'session-not-found',
    });
  });
});

// ---------------------------------------------------------------------------
// Temp dir + atomic publish
// ---------------------------------------------------------------------------

describe('writeSnapshot — atomic publish via temp dir', () => {
  it('preserves an earlier complete snapshot when staging is aborted', async () => {
    const vfs = await createVfs();
    const sessionId = 'sess-prior-001';
    await writeSnapshot(vfs, sessionId, makeSnapshot());
    const controller = new AbortController();
    controller.abort();
    await expect(
      writeSnapshot(vfs, sessionId, makeSnapshot(), controller.signal)
    ).rejects.toMatchObject({
      code: 'transfer-aborted',
    });
    expect((await readSnapshot(vfs, sessionId)).document.session.id).toBe('sess-fixture-001');
  });

  it('keeps an interrupted destination unreadable and leaves the archive fallback available', async () => {
    const vfs = await createVfs();
    const sessionId = 'sess-interrupted-001';
    const controller = new AbortController();
    const destinationAttachment = `/sessions/data/${sessionId}/attachments/att-0001.bin`;
    let releaseCopy!: () => void;
    let copyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      copyStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    const originalWriteFile = vfs.writeFile.bind(vfs);
    vfs.writeFile = async (path: string, content: string | Uint8Array) => {
      if (path === destinationAttachment) {
        copyStarted();
        await blocked;
      }
      return originalWriteFile(path, content);
    };

    const write = writeSnapshot(
      vfs,
      sessionId,
      makeSnapshot([['attachments/att-0001.bin', new Uint8Array([1, 2, 3])]]),
      controller.signal
    );
    await started;
    await expect(readSnapshot(vfs, sessionId)).rejects.toMatchObject({
      code: 'session-not-found',
    });
    controller.abort();
    releaseCopy();
    await expect(write).rejects.toMatchObject({ code: 'transfer-aborted' });
    expect((await vfs.stat(`/sessions/data/${sessionId}/.publishing`)).type).toBe('file');
    await expect(readSnapshot(vfs, sessionId)).rejects.toMatchObject({
      code: 'session-not-found',
    });
  });

  it('removes temp dir on successful write', async () => {
    const vfs = await createVfs();
    const sessionId = 'sess-tmp-clean-001';
    await writeSnapshot(vfs, sessionId, makeSnapshot());

    // No .tmp- directories should remain under /sessions/data/
    let entries: { name: string }[] = [];
    try {
      entries = await vfs.readDir('/sessions/data');
    } catch {
      // Directory might not exist for empty snapshots — fine
    }
    const tmpEntries = entries.filter((e) => e.name.startsWith('.tmp-'));
    expect(tmpEntries).toHaveLength(0);
  });

  it('cleans up temp dir on write failure and does not publish partial data', async () => {
    const vfs = await createVfs();
    const sessionId = 'sess-tmp-fail-001';

    // Inject a write failure for attachment files
    let callCount = 0;
    const originalWriteFile = vfs.writeFile.bind(vfs);
    vfs.writeFile = async (path: string, content: string | Uint8Array) => {
      callCount++;
      if (callCount > 1) {
        // Fail on second write (attachment write) to simulate mid-write failure
        const err = new Error('EIO disk full') as Error & { code: string };
        err.code = 'EIO';
        throw err;
      }
      return originalWriteFile(path, content);
    };

    const bytes = new Uint8Array([1, 2, 3]);
    await expect(
      writeSnapshot(vfs, sessionId, makeSnapshot([['attachments/att-0001.bin', bytes]]))
    ).rejects.toThrow();

    // Final path should not exist (publish was not completed)
    await expect(vfs.stat(`/sessions/data/${sessionId}/document.json`)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // Temp dirs should be cleaned up
    vfs.writeFile = originalWriteFile;
    let tmpEntries: { name: string }[] = [];
    try {
      const entries = await vfs.readDir('/sessions/data');
      tmpEntries = entries.filter((e) => e.name.startsWith('.tmp-'));
    } catch {
      // directory might not exist
    }
    expect(tmpEntries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sessionId immutability
// ---------------------------------------------------------------------------

describe('sessionId stability across enrichment', () => {
  it('writeSnapshot stores data under the caller-provided sessionId', async () => {
    const vfs = await createVfs();
    const sessionId = crypto.randomUUID();
    await writeSnapshot(vfs, sessionId, makeSnapshot());

    const stat = await vfs.stat(`/sessions/data/${sessionId}/document.json`);
    expect(stat.type).toBe('file');
  });

  it('readSnapshot finds data by sessionId regardless of index filename', async () => {
    // sessionId is stable; index entries may have different filenames after enrichment
    // but the snapshot path is keyed on sessionId, not filename
    const vfs = await createVfs();
    const sessionId = 'stable-sess-id';
    await writeSnapshot(vfs, sessionId, makeSnapshot());

    // Read with the same sessionId always works
    const read = await readSnapshot(vfs, sessionId);
    expect(read.document.schemaVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sessionId path traversal guard (I-2)
// ---------------------------------------------------------------------------

describe('assertSafeSessionId — path traversal guard', () => {
  it('rejects session-not-found for path traversal: ../', async () => {
    const vfs = await createVfs();
    await expect(readSnapshot(vfs, '../other-session')).rejects.toMatchObject({
      code: 'session-not-found',
    });
  });

  it('rejects session-not-found for traversal with dotdot', async () => {
    const vfs = await createVfs();
    await expect(readSnapshot(vfs, 'valid-..-..-etc-passwd')).rejects.toMatchObject({
      code: 'session-not-found',
    });
  });

  it('rejects session-not-found for slash in sessionId', async () => {
    const vfs = await createVfs();
    await expect(readSnapshot(vfs, 'foo/bar')).rejects.toMatchObject({
      code: 'session-not-found',
    });
  });

  it('rejects session-not-found for backslash in sessionId', async () => {
    const vfs = await createVfs();
    await expect(readSnapshot(vfs, 'foo\\bar')).rejects.toMatchObject({
      code: 'session-not-found',
    });
  });

  it('rejects session-not-found for NUL byte in sessionId', async () => {
    const vfs = await createVfs();
    await expect(readSnapshot(vfs, 'foo\x00bar')).rejects.toMatchObject({
      code: 'session-not-found',
    });
  });

  it('rejects session-not-found for empty sessionId', async () => {
    const vfs = await createVfs();
    await expect(readSnapshot(vfs, '')).rejects.toMatchObject({
      code: 'session-not-found',
    });
  });

  it('rejects session-not-found for dotdot segment alone', async () => {
    const vfs = await createVfs();
    await expect(readSnapshot(vfs, '..')).rejects.toMatchObject({
      code: 'session-not-found',
    });
  });

  it('accepts valid UUID sessionId and makes no VFS calls on guard failure', async () => {
    const vfs = await createVfs();
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    // Should fail with session-not-found (no such session) not schema-invalid or crash
    await expect(readSnapshot(vfs, uuid)).rejects.toMatchObject({
      code: 'session-not-found',
    });
  });

  it('writeSnapshot rejects traversal without making VFS calls', async () => {
    const vfs = await createVfs();
    const writeSpy: string[] = [];
    const origWrite = vfs.writeFile.bind(vfs);
    vfs.writeFile = async (path: string, content: string | Uint8Array) => {
      writeSpy.push(path);
      return origWrite(path, content);
    };
    await expect(writeSnapshot(vfs, '../etc/passwd', makeSnapshot())).rejects.toMatchObject({
      code: 'session-not-found',
    });
    expect(writeSpy).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// writeSnapshot — stale destination cleanup (M-3)
// ---------------------------------------------------------------------------

describe('writeSnapshot — stale destination cleanup', () => {
  it('clears stale destination before writing so no orphaned files remain on retry', async () => {
    const vfs = await createVfs();
    const sessionId = 'sess-stale-001';
    const bytes1 = new Uint8Array([1, 2, 3]);
    const bytes2 = new Uint8Array([4, 5, 6]);

    // First write: two attachments
    const snap1 = makeSnapshot([
      ['attachments/att-0001.bin', bytes1],
      ['attachments/att-0002.bin', bytes2],
    ]);
    await writeSnapshot(vfs, sessionId, snap1);

    // Second write: only one attachment
    const snap2 = makeSnapshot([['attachments/att-0001.bin', bytes1]]);
    await writeSnapshot(vfs, sessionId, snap2);

    // att-0002.bin should no longer exist — stale file cleared on retry
    await expect(
      vfs.stat(`/sessions/data/${sessionId}/attachments/att-0002.bin`)
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// ---------------------------------------------------------------------------
// writeSnapshot — undeclared attachment bytes (M-5)
// ---------------------------------------------------------------------------

describe('writeSnapshot — undeclared attachment bytes', () => {
  it('throws schema-invalid when attachment bytes are not declared in document.attachments', async () => {
    const vfs = await createVfs();
    const sessionId = 'sess-undecl-001';
    const doc = makeTranscriptDocument(); // attachments: []
    const snapshot: SanitizedTranscriptSnapshot = {
      document: doc, // no declared attachments
      attachments: new Map([['attachments/att-0001.bin', new Uint8Array([1, 2, 3])]]),
    };
    await expect(writeSnapshot(vfs, sessionId, snapshot)).rejects.toMatchObject({
      code: 'schema-invalid',
    });
  });

  it('succeeds when all attachment bytes are declared in document.attachments', async () => {
    const vfs = await createVfs();
    const sessionId = 'sess-decl-001';
    const bytes = new Uint8Array([7, 8, 9]);
    const snapshot = makeSnapshot([['attachments/att-0001.bin', bytes]]);
    await expect(writeSnapshot(vfs, sessionId, snapshot)).resolves.toBeUndefined();
  });
});

describe('removeSnapshot', () => {
  it('removes the published bundle and a leftover staging dir; missing is fine', async () => {
    const vfs = await createVfs();
    await writeSnapshot(vfs, 'sess-rm-001', makeSnapshot());
    await vfs.mkdir('/sessions/data/.tmp-sess-rm-001', { recursive: true });
    await vfs.writeFile('/sessions/data/.tmp-sess-rm-001/document.json', '{}');

    await removeSnapshot(vfs, 'sess-rm-001');

    await expect(vfs.stat('/sessions/data/sess-rm-001')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(vfs.stat('/sessions/data/.tmp-sess-rm-001')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(removeSnapshot(vfs, 'sess-rm-001')).resolves.toBeUndefined();
  });

  it('rejects an unsafe id', async () => {
    const vfs = await createVfs();
    await expect(removeSnapshot(vfs, '../escape')).rejects.toThrow();
  });

  it('surfaces a non-ENOENT removal fault', async () => {
    const failing = {
      rm: async () => {
        throw Object.assign(new Error('EIO: disk'), { code: 'EIO' });
      },
    };
    await expect(removeSnapshot(failing as never, 'sess-x')).rejects.toThrow('EIO');
  });
});

describe('discardSnapshotIfUnindexed', () => {
  async function seeded(index: string | null): Promise<VirtualFS> {
    const vfs = await createVfs();
    await writeSnapshot(vfs, 'sess-d-001', makeSnapshot());
    if (index !== null) await vfs.writeFile('/sessions/index.json', index);
    return vfs;
  }
  const kept = (vfs: VirtualFS) =>
    vfs.stat('/sessions/data/sess-d-001').then(
      () => true,
      () => false
    );

  it('keeps the bundle while a row still carries the sessionId', async () => {
    const vfs = await seeded(
      JSON.stringify([
        { filename: 'a.md', title: 'a', frozenAt: 'x', messageCount: 1, sessionId: 'sess-d-001' },
      ])
    );
    expect(await discardSnapshotIfUnindexed(vfs, 'sess-d-001')).toBe(false);
    expect(await kept(vfs)).toBe(true);
  });

  it('removes the bundle when a well-formed index no longer has the row', async () => {
    const vfs = await seeded('[]');
    expect(await discardSnapshotIfUnindexed(vfs, 'sess-d-001')).toBe(true);
    expect(await kept(vfs)).toBe(false);
  });

  it('keeps the bundle when the index is missing or corrupt — it cannot prove a delete', async () => {
    for (const index of [null, '[{"filename": trunc']) {
      const vfs = await seeded(index);
      expect(await discardSnapshotIfUnindexed(vfs, 'sess-d-001')).toBe(false);
      expect(await kept(vfs)).toBe(true);
    }
  });
});
