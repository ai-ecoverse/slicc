/**
 * Unit tests for export-spool.ts — injectable spool interface and MemorySpool.
 *
 * TDD RED phase: all tests written before production code exists.
 * These tests prove the bounded-memory contract: chunk data passes through
 * the spool interface and does not accumulate in caller state.
 */

import { sha256 } from 'js-sha256';
import { describe, expect, it, vi } from 'vitest';
import { MemorySpool, OpfsSpool } from '../../src/transcript/export-spool.js';

const bytes = (values: number[]): Uint8Array => Uint8Array.from(values);

// ---------------------------------------------------------------------------
// MemorySpool: basic contract
// ---------------------------------------------------------------------------

describe('MemorySpool', () => {
  it('appends chunks and finalizes to a Blob', async () => {
    const spool = new MemorySpool();
    const chunk0 = bytes([1, 2, 3]);
    const chunk1 = bytes([4, 5, 6]);

    await spool.append(chunk0, 0);
    await spool.append(chunk1, 1);

    const hasher = sha256.create();
    hasher.update(chunk0);
    hasher.update(chunk1);
    const digest = hasher.hex();

    const blob = await spool.finalize(2, 6, digest);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/zip');
    expect(blob.size).toBe(6);

    const raw = new Uint8Array(await blob.arrayBuffer());
    expect(raw).toEqual(bytes([1, 2, 3, 4, 5, 6]));
  });

  it('cancel clears accumulated chunks', async () => {
    const spool = new MemorySpool();
    await spool.append(bytes([10, 20, 30]), 0);
    await spool.cancel();

    // After cancel, finalize should not work (spool is in cancelled state)
    await expect(spool.finalize(1, 3, 'any')).rejects.toThrow();
  });

  it('rejects on chunk count mismatch at finalize', async () => {
    const spool = new MemorySpool();
    await spool.append(bytes([1]), 0);

    // Only 1 chunk appended, finalize says 2 expected
    await expect(spool.finalize(2, 1, 'any')).rejects.toMatchObject({
      code: 'transfer-corrupt',
    });
  });

  it('rejects on byte length mismatch at finalize', async () => {
    const spool = new MemorySpool();
    const chunk = bytes([1, 2, 3]);
    await spool.append(chunk, 0);

    const hasher = sha256.create();
    hasher.update(chunk);
    const digest = hasher.hex();

    // Wrong byte length
    await expect(spool.finalize(1, 999, digest)).rejects.toMatchObject({
      code: 'transfer-corrupt',
    });
  });

  it('rejects on SHA-256 mismatch at finalize', async () => {
    const spool = new MemorySpool();
    const chunk = bytes([1, 2, 3]);
    await spool.append(chunk, 0);

    // Wrong digest
    await expect(spool.finalize(1, 3, 'bad-digest')).rejects.toMatchObject({
      code: 'transfer-corrupt',
    });
  });

  it('cancel is idempotent', async () => {
    const spool = new MemorySpool();
    await spool.append(bytes([1]), 0);
    await spool.cancel();
    await expect(spool.cancel()).resolves.toBeUndefined();
  });

  it('handles empty transfer (zero chunks)', async () => {
    const spool = new MemorySpool();
    const blob = await spool.finalize(0, 0, sha256(new Uint8Array(0)));
    expect(blob.size).toBe(0);
  });

  it('preserves exact bytes across a large multi-chunk transfer', async () => {
    const spool = new MemorySpool();
    const chunks: Uint8Array[] = [];
    const hasher = sha256.create();
    let totalBytes = 0;

    for (let i = 0; i < 10; i++) {
      const chunk = new Uint8Array(1024).fill(i);
      chunks.push(chunk);
      await spool.append(chunk, i);
      hasher.update(chunk);
      totalBytes += chunk.byteLength;
    }

    const blob = await spool.finalize(10, totalBytes, hasher.hex());
    expect(blob.size).toBe(totalBytes);

    const raw = new Uint8Array(await blob.arrayBuffer());
    let offset = 0;
    for (const chunk of chunks) {
      expect(raw.subarray(offset, offset + chunk.byteLength)).toEqual(chunk);
      offset += chunk.byteLength;
    }
  });

  it('implements ExportSpool interface (type check via duck typing)', async () => {
    const spool = new MemorySpool();
    expect(typeof spool.append).toBe('function');
    expect(typeof spool.finalize).toBe('function');
    expect(typeof spool.cancel).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// ExportSpool interface: exported type
// ---------------------------------------------------------------------------

describe('ExportSpool interface', () => {
  it('can be implemented by MemorySpool', () => {
    // Type-level check via runtime duck-typing
    const spool: import('../../src/transcript/export-spool.js').ExportSpool = new MemorySpool();
    expect(spool).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// OpfsSpool: injectable fake OPFS failure tests (CV-2)
// ---------------------------------------------------------------------------

/** Minimal fake File with a fixed byte payload (for getFile() mocks). */
function fakeFile(
  content: Uint8Array<ArrayBuffer> = new Uint8Array(0) as Uint8Array<ArrayBuffer>
): File {
  return new File([content], 'export.zip', { type: 'application/zip' });
}

/**
 * Build a fake OPFS root FileSystemDirectoryHandle with controllable ops.
 *
 * openWritable() in OpfsSpool walks two levels:
 *   root.getDirectoryHandle('.slicc-export-tmp') → subDir
 *   subDir.getFileHandle(tempName)               → fileHandle
 *   fileHandle.createWritable()                  → writable
 *
 * deleteTempFile calls subDir.removeEntry(tempName).
 * All fns default to no-ops so tests only override what they need to break.
 */
function makeFakeOpfsDir(opts: {
  writeFn?: () => Promise<void>;
  closeFn?: () => Promise<void>;
  getFileFn?: () => Promise<File>;
  removeEntryFn?: () => Promise<void>;
}): FileSystemDirectoryHandle {
  const writable = {
    write: opts.writeFn ?? (() => Promise.resolve()),
    close: opts.closeFn ?? (() => Promise.resolve()),
    abort: () => Promise.resolve(),
    locked: false,
  } as unknown as FileSystemWritableFileStream;

  const fileHandle = {
    kind: 'file',
    name: 'export.zip.tmp',
    getFile: opts.getFileFn ?? (() => Promise.resolve(fakeFile())),
    createWritable: () => Promise.resolve(writable),
    isSameEntry: () => Promise.resolve(false),
  } as unknown as FileSystemFileHandle;

  const subDir = {
    kind: 'directory',
    name: '.slicc-export-tmp',
    getFileHandle: (_name: string, _o?: { create?: boolean }) => Promise.resolve(fileHandle),
    getDirectoryHandle: () => Promise.reject(new Error('not a nested dir')),
    removeEntry: opts.removeEntryFn ?? (() => Promise.resolve()),
    isSameEntry: () => Promise.resolve(false),
    [Symbol.asyncIterator]: function* () {},
  } as unknown as FileSystemDirectoryHandle;

  // Root directory: getDirectoryHandle('.slicc-export-tmp') returns subDir.
  return {
    kind: 'directory',
    name: '',
    getDirectoryHandle: (_name: string, _o?: { create?: boolean }) => Promise.resolve(subDir),
    getFileHandle: () => Promise.reject(new Error('not a file at root')),
    removeEntry: () => Promise.resolve(),
    isSameEntry: () => Promise.resolve(false),
    [Symbol.asyncIterator]: function* () {},
  } as unknown as FileSystemDirectoryHandle;
}

/**
 * Run `fn` with `navigator.storage.getDirectory` faked to return `dirHandle`.
 * Uses vi.stubGlobal so the entire navigator replacement is rolled back via
 * vi.unstubAllGlobals() in the finally block, keeping tests isolated.
 */
function withFakeOpfs(
  dirHandle: FileSystemDirectoryHandle,
  fn: () => Promise<void>
): Promise<void> {
  const existingNav = typeof navigator !== 'undefined' ? navigator : {};
  // Preserve existing navigator properties; only inject storage.
  vi.stubGlobal('navigator', {
    ...existingNav,
    storage: { getDirectory: () => Promise.resolve(dirHandle) },
  });
  return fn().finally(() => vi.unstubAllGlobals());
}

describe('OpfsSpool — fake OPFS failure injection (CV-2)', () => {
  it('append rejects and temp file is deletable on writable.write failure', async () => {
    const removeEntry = vi.fn().mockResolvedValue(undefined);
    const dir = makeFakeOpfsDir({
      writeFn: () => Promise.reject(new Error('OPFS write quota exceeded')),
      removeEntryFn: removeEntry,
    });
    const spool = new OpfsSpool('test-write-fail');
    await withFakeOpfs(dir, async () => {
      await expect(spool.append(bytes([1, 2, 3]), 0)).rejects.toThrow('quota exceeded');
      // Cancel should run cleanup without throwing
      await expect(spool.cancel()).resolves.toBeUndefined();
    });
  });

  it('finalize rejects transfer-corrupt and cleans up when getFile throws', async () => {
    const removeEntry = vi.fn().mockResolvedValue(undefined);
    const chunk = bytes([0xde, 0xad]);
    const hasher = sha256.create();
    hasher.update(chunk);
    const digest = hasher.hex();

    const dir = makeFakeOpfsDir({
      writeFn: () => Promise.resolve(),
      closeFn: () => Promise.resolve(),
      getFileFn: () => Promise.reject(new Error('OPFS getFile: quota exceeded')),
      removeEntryFn: removeEntry,
    });
    const spool = new OpfsSpool('test-getfile-fail');
    await withFakeOpfs(dir, async () => {
      await spool.append(chunk, 0);
      await expect(spool.finalize(1, chunk.byteLength, digest)).rejects.toMatchObject({
        code: 'transfer-corrupt',
      });
      // Cleanup must have run (removeEntry called)
      expect(removeEntry).toHaveBeenCalled();
    });
  });

  it('cancel cleans up temp file when writable.close throws', async () => {
    const removeEntry = vi.fn().mockResolvedValue(undefined);
    const dir = makeFakeOpfsDir({
      writeFn: () => Promise.resolve(),
      closeFn: () => Promise.reject(new Error('OPFS close error')),
      removeEntryFn: removeEntry,
    });
    const spool = new OpfsSpool('test-close-fail');
    await withFakeOpfs(dir, async () => {
      await spool.append(bytes([1]), 0);
      // cancel should not throw even if close throws
      await expect(spool.cancel()).resolves.toBeUndefined();
      // temp file deletion must still run
      expect(removeEntry).toHaveBeenCalled();
    });
  });

  it('finalize rejects transfer-corrupt and cleans up when writable.close throws', async () => {
    const removeEntry = vi.fn().mockResolvedValue(undefined);
    const chunk = bytes([0xab, 0xcd]);
    const hasher = sha256.create();
    hasher.update(chunk);
    const digest = hasher.hex();

    const dir = makeFakeOpfsDir({
      writeFn: () => Promise.resolve(),
      closeFn: () => Promise.reject(new Error('OPFS writable close failed')),
      removeEntryFn: removeEntry,
    });
    const spool = new OpfsSpool('test-finalize-close-fail');
    await withFakeOpfs(dir, async () => {
      await spool.append(chunk, 0);
      await expect(spool.finalize(1, chunk.byteLength, digest)).rejects.toThrow();
      expect(removeEntry).toHaveBeenCalled();
    });
  });

  it('serializes concurrent appends (v2 no-ack) — finalize sees correct counters', async () => {
    // Simulate a slow OPFS write that would race with finalize if writes
    // were not serialized. Two appends are in-flight concurrently.
    let writeCount = 0;
    const writeOrder: number[] = [];
    const dir = makeFakeOpfsDir({
      writeFn: async () => {
        const me = writeCount++;
        // Odd writes are slightly slower so they could arrive out-of-order
        await new Promise<void>((r) => setTimeout(r, me % 2 === 1 ? 5 : 1));
        writeOrder.push(me);
      },
    });
    const spool = new OpfsSpool('test-serial');
    await withFakeOpfs(dir, async () => {
      const chunk0 = bytes([1, 2, 3]);
      const chunk1 = bytes([4, 5, 6]);
      const hasher = sha256.create();
      hasher.update(chunk0);
      hasher.update(chunk1);
      const digest = hasher.hex();

      // Fire both appends without awaiting the first (v2 concurrent path)
      const p0 = spool.append(chunk0, 0);
      const p1 = spool.append(chunk1, 1);
      await Promise.all([p0, p1]);

      // Finalize must see both chunks
      const blob = await spool.finalize(2, 6, digest);
      expect(blob).toBeInstanceOf(Blob);
      // Writes were serialized — write 0 always before write 1
      expect(writeOrder).toEqual([0, 1]);
    });
  });
});

// ---------------------------------------------------------------------------
// OpfsSpool — independent Blob: stream-before-delete (CV-3)
// ---------------------------------------------------------------------------

describe('OpfsSpool — independent Blob before temp-file deletion (CV-3)', () => {
  it('returned Blob is readable after the temp OPFS file is deleted', async () => {
    // Simulate a real zip-ish payload so content integrity is verifiable.
    const content = bytes([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03, 0x04, 0x05]);
    const hasher = sha256.create();
    hasher.update(content);
    const digest = hasher.hex();

    const removeEntry = vi.fn().mockResolvedValue(undefined);
    // getFileFn returns a real File carrying the expected bytes.
    const dir = makeFakeOpfsDir({
      writeFn: () => Promise.resolve(),
      closeFn: () => Promise.resolve(),
      getFileFn: () =>
        Promise.resolve(
          new File([content as Uint8Array<ArrayBuffer>], 'export.zip', {
            type: 'application/zip',
          })
        ),
      removeEntryFn: removeEntry,
    });

    const spool = new OpfsSpool('test-blob-independent');
    await withFakeOpfs(dir, async () => {
      await spool.append(content, 0);
      const blob = await spool.finalize(1, content.byteLength, digest);

      // Temp file was deleted by finalize.
      expect(removeEntry).toHaveBeenCalledOnce();

      // The Blob is fully readable — bytes intact even though the OPFS entry
      // has been removed. This would fail in real Chromium with the old
      // file.slice() + deleteTempFile() ordering.
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/zip');
      expect(blob.size).toBe(content.byteLength);

      const raw = new Uint8Array(await blob.arrayBuffer());
      expect(raw).toEqual(content);
    });
  });

  it('cleanup runs and throws transfer-corrupt when stream construction fails', async () => {
    const content = bytes([0xde, 0xad, 0xbe, 0xef]);
    const hasher = sha256.create();
    hasher.update(content);
    const digest = hasher.hex();

    const removeEntry = vi.fn().mockResolvedValue(undefined);

    // Build a fake File whose stream() throws synchronously, simulating an
    // invalidated OPFS file handle (e.g. underlying storage unavailable).
    // Use a plain object cast as File — File.prototype properties are
    // getter-only and cannot be set via Object.assign.
    const brokenFile = {
      name: 'export.zip',
      size: content.byteLength,
      type: 'application/zip',
      lastModified: Date.now(),
      stream: (): ReadableStream<Uint8Array> => {
        throw new Error('OPFS handle invalidated: storage unavailable');
      },
      arrayBuffer: (): Promise<ArrayBuffer> =>
        Promise.reject(new Error('OPFS arrayBuffer: storage unavailable')),
      slice: (start?: number, end?: number, contentType?: string): Blob =>
        new Blob([content.slice(start ?? 0, end)], { type: contentType }),
      text: (): Promise<string> => Promise.reject(new Error('OPFS text: storage unavailable')),
    } as unknown as File;

    const dir = makeFakeOpfsDir({
      writeFn: () => Promise.resolve(),
      closeFn: () => Promise.resolve(),
      getFileFn: () => Promise.resolve(brokenFile),
      removeEntryFn: removeEntry,
    });

    const spool = new OpfsSpool('test-stream-fail');
    await withFakeOpfs(dir, async () => {
      await spool.append(content, 0);
      await expect(spool.finalize(1, content.byteLength, digest)).rejects.toMatchObject({
        code: 'transfer-corrupt',
      });
      // Cleanup must still run even when stream/blob construction fails.
      expect(removeEntry).toHaveBeenCalled();
    });
  });

  it('fallback arrayBuffer path returns correct Blob when stream is absent', async () => {
    const content = bytes([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const hasher = sha256.create();
    hasher.update(content);
    const digest = hasher.hex();

    const removeEntry = vi.fn().mockResolvedValue(undefined);

    // Fake File WITHOUT a stream() method — exercises the arrayBuffer fallback.
    // Plain object cast: File.prototype properties are getter-only.
    const noStreamFile = {
      name: 'export.zip',
      size: content.byteLength,
      type: 'application/zip',
      lastModified: Date.now(),
      stream: undefined, // absent — triggers fallback
      arrayBuffer: (): Promise<ArrayBuffer> =>
        Promise.resolve((content as Uint8Array<ArrayBuffer>).buffer),
    } as unknown as File;

    const dir = makeFakeOpfsDir({
      writeFn: () => Promise.resolve(),
      closeFn: () => Promise.resolve(),
      getFileFn: () => Promise.resolve(noStreamFile),
      removeEntryFn: removeEntry,
    });

    const spool = new OpfsSpool('test-no-stream');
    await withFakeOpfs(dir, async () => {
      await spool.append(content, 0);
      const blob = await spool.finalize(1, content.byteLength, digest);

      expect(removeEntry).toHaveBeenCalledOnce();
      expect(blob.type).toBe('application/zip');
      expect(blob.size).toBe(content.byteLength);

      const raw = new Uint8Array(await blob.arrayBuffer());
      expect(raw).toEqual(content);
    });
  });
});
