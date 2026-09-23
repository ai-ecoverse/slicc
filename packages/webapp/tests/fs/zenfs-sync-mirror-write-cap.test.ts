import { WebAccess } from '@zenfs/dom';
import { describe, expect, it } from 'vitest';
import { createMutableDirectoryHandle } from './fsa-test-helpers.js';

const MIRROR_CAP = 1024 * 1024;

/** `touch` takes a full `InodeLike`; the backend only reads the fields it is given. */
type TouchMetadata = Parameters<Awaited<ReturnType<typeof WebAccess.create>>['touch']>[1];

interface MirrorView {
  _sync: { store: Map<unknown, unknown> };
}

/**
 * Bytes pinned by the sync mirror's store. Counts each backing buffer once,
 * so a zero-length view that still holds a large buffer is caught too.
 */
function mirrorBytes(backend: unknown): number {
  const buffers = new Set<ArrayBufferLike>();
  for (const value of (backend as MirrorView)._sync.store.values()) {
    if (value instanceof Uint8Array) buffers.add(value.buffer);
  }
  let total = 0;
  for (const buffer of buffers) total += buffer.byteLength;
  return total;
}

async function makeBackend() {
  const backend = await WebAccess.create({
    handle: createMutableDirectoryHandle({ small: 'data' }).handle,
  });
  await backend.ready();
  return backend;
}

function payload(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) bytes[i] = (seed + i) & 0xff;
  return bytes;
}

describe('ZenFS sync mirror keeps large async writes out of memory (#3441)', () => {
  it('records name and size only for files written above 1 MiB', async () => {
    const backend = await makeBackend();
    const baseline = mirrorBytes(backend);
    const size = 2 * MIRROR_CAP + 17;
    for (let i = 0; i < 3; i++) {
      await backend.createFile(`/shard_${i}`, { mode: 0o644, uid: 0, gid: 0 });
      await backend.write(`/shard_${i}`, payload(size, i), 0);
    }
    await backend.sync();

    // Before the fix the mirror held all three bodies (~6 MiB).
    expect(mirrorBytes(backend) - baseline).toBeLessThan(64 * 1024);
    expect(backend.statSync('/shard_1').size).toBe(size);
    expect(backend.readdirSync('/')).toEqual(expect.arrayContaining(['shard_0', 'shard_2']));
    expect(() => backend.readSync('/shard_1', new Uint8Array(4), 0, 4)).toThrow(/no payload/);

    // Async reads still come from the backend, byte for byte.
    const back = new Uint8Array(size);
    await backend.read('/shard_1', back, 0, size);
    // Buffer.equals, not toEqual: a per-element diff of 2 MiB is slow enough
    // under coverage instrumentation to hit the test timeout.
    expect(Buffer.from(back).equals(Buffer.from(payload(size, 1)))).toBe(true);
  });

  it('keeps a chunked write metadata-only and tracks its growing size', async () => {
    const backend = await makeBackend();
    const baseline = mirrorBytes(backend);
    const chunk = 768 * 1024;
    await backend.createFile('/stream', { mode: 0o644, uid: 0, gid: 0 });
    for (let i = 0; i < 4; i++) await backend.write('/stream', payload(chunk, i), i * chunk);
    // VNode.sync pins the final length with a touch; it must not zero-fill.
    await backend.touch('/stream', { size: 4 * chunk, mtimeMs: Date.now() } as TouchMetadata);
    await backend.sync();

    expect(backend.statSync('/stream').size).toBe(4 * chunk);
    // The first chunk fits under the cap; crossing it drops that body too.
    expect(mirrorBytes(backend) - baseline).toBeLessThan(64 * 1024);
    expect(() => backend.readSync('/stream', new Uint8Array(4), 0, 4)).toThrow(/no payload/);
  });

  it('still mirrors small files, and forgets the marker once a large file is gone', async () => {
    const backend = await makeBackend();
    await backend.createFile('/big', { mode: 0o644, uid: 0, gid: 0 });
    await backend.write('/big', payload(MIRROR_CAP + 1, 3), 0);
    expect(backend.statSync('/big').size).toBe(MIRROR_CAP + 1);
    expect(() => backend.readSync('/big', new Uint8Array(4), 0, 4)).toThrow(/no payload/);
    await backend.unlink('/big');

    const hello = new TextEncoder().encode('hello');
    await backend.createFile('/big', { mode: 0o644, uid: 0, gid: 0 });
    await backend.write('/big', hello, 0);
    const back = new Uint8Array(hello.length);
    backend.readSync('/big', back, 0, hello.length);
    expect(new TextDecoder().decode(back)).toBe('hello');

    // Rewriting a metadata-only file from offset 0 with a small body brings
    // the bytes back into the mirror (the preload's overwrite rule).
    await backend.write('/big', payload(MIRROR_CAP + 1, 4), 0);
    await backend.touch('/big', { size: 0 } as TouchMetadata);
    await backend.write('/big', hello, 0);
    const again = new Uint8Array(hello.length);
    backend.readSync('/big', again, 0, hello.length);
    expect(new TextDecoder().decode(again)).toBe('hello');
  });
});
