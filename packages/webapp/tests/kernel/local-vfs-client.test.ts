/**
 * Tests for `LocalVfsClient` — the page-side read-only VFS facade.
 *
 * The structural-type benefit (panels can't call write methods at
 * compile time) is asserted via `// @ts-expect-error` checks below.
 * Runtime tests pin pass-through behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import { createLocalVfsClient, type LocalVfsClient } from '../../src/kernel/local-vfs-client.js';
import type { DirEntry, ReadFileOptions, Stats } from '../../src/fs/types.js';

function makeStubVfs(): {
  vfs: LocalVfsClient;
  readDir: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
} {
  const readDir = vi.fn(
    async (_path: string): Promise<DirEntry[]> => [
      { name: 'a', type: 'file', size: 10 } as unknown as DirEntry,
    ]
  );
  const readFile = vi.fn(
    async (_path: string, _opts?: ReadFileOptions): Promise<string | Uint8Array> => 'file content'
  );
  const stat = vi.fn(
    async (_path: string): Promise<Stats> =>
      ({ size: 42, type: 'file', mtime: 0 }) as unknown as Stats
  );
  return { vfs: { readDir, readFile, stat }, readDir, readFile, stat };
}

describe('LocalVfsClient', () => {
  it('createLocalVfsClient passes readDir through', async () => {
    const stub = makeStubVfs();
    const client = createLocalVfsClient(stub.vfs);
    const entries = await client.readDir('/foo');
    expect(stub.readDir).toHaveBeenCalledWith('/foo');
    expect(entries).toHaveLength(1);
  });

  it('createLocalVfsClient passes readFile through with options', async () => {
    const stub = makeStubVfs();
    const client = createLocalVfsClient(stub.vfs);
    await client.readFile('/file.txt', { encoding: 'utf-8' });
    expect(stub.readFile).toHaveBeenCalledWith('/file.txt', { encoding: 'utf-8' });
  });

  it('createLocalVfsClient passes stat through', async () => {
    const stub = makeStubVfs();
    const client = createLocalVfsClient(stub.vfs);
    const s = await client.stat('/foo/bar');
    expect(stub.stat).toHaveBeenCalledWith('/foo/bar');
    expect(s.size).toBe(42);
  });

  it('the facade has no write methods (compile-time check)', () => {
    const stub = makeStubVfs();
    const client = createLocalVfsClient(stub.vfs);
    // The whole point: writes must fail at compile time.
    // @ts-expect-error LocalVfsClient has no writeFile method.
    void (client.writeFile as unknown);
    // @ts-expect-error LocalVfsClient has no mkdir method.
    void (client.mkdir as unknown);
    // @ts-expect-error LocalVfsClient has no remove method.
    void (client.remove as unknown);
    // @ts-expect-error LocalVfsClient has no rename method.
    void (client.rename as unknown);
    expect(true).toBe(true);
  });
});
