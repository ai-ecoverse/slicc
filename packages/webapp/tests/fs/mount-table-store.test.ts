import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveMountEntry,
  removeMountEntry,
  getAllMountEntries,
  clearMountEntries,
} from '../../src/fs/mount-table-store.js';

/** Minimal mock of FileSystemDirectoryHandle for IDB storage tests. */
function mockHandle(name: string): FileSystemDirectoryHandle {
  return { kind: 'directory', name } as unknown as FileSystemDirectoryHandle;
}

describe('mount-table-store', () => {
  beforeEach(async () => {
    await clearMountEntries();
  });

  it('starts with no entries', async () => {
    const entries = await getAllMountEntries();
    expect(entries).toEqual([]);
  });

  it('saves and retrieves a mount entry', async () => {
    const handle = mockHandle('my-project');
    await saveMountEntry('/workspace/my-project', handle);
    const entries = await getAllMountEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('/workspace/my-project');
    expect(entries[0].handle.name).toBe('my-project');
  });

  it('saves multiple entries', async () => {
    await saveMountEntry('/workspace/a', mockHandle('a'));
    await saveMountEntry('/workspace/b', mockHandle('b'));
    const entries = await getAllMountEntries();
    expect(entries).toHaveLength(2);
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(['/workspace/a', '/workspace/b']);
  });

  it('overwrites entry with same path', async () => {
    await saveMountEntry('/workspace/x', mockHandle('old'));
    await saveMountEntry('/workspace/x', mockHandle('new'));
    const entries = await getAllMountEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].handle.name).toBe('new');
  });

  it('removes a mount entry', async () => {
    await saveMountEntry('/workspace/a', mockHandle('a'));
    await saveMountEntry('/workspace/b', mockHandle('b'));
    await removeMountEntry('/workspace/a');
    const entries = await getAllMountEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('/workspace/b');
  });

  it('remove is a no-op for non-existent path', async () => {
    await removeMountEntry('/does/not/exist');
    const entries = await getAllMountEntries();
    expect(entries).toEqual([]);
  });

  it('clears all entries', async () => {
    await saveMountEntry('/workspace/a', mockHandle('a'));
    await saveMountEntry('/workspace/b', mockHandle('b'));
    await clearMountEntries();
    const entries = await getAllMountEntries();
    expect(entries).toEqual([]);
  });
});
