import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveMountEntry,
  removeMountEntry,
  getAllMountEntries,
  clearMountEntries,
  type MountTableEntry,
} from '../../src/fs/mount-table-store.js';
import { newMountId } from '../../src/fs/mount/mount-id.js';

/** Minimal mock of FileSystemDirectoryHandle for IDB storage tests. */
function mockHandle(name: string): FileSystemDirectoryHandle {
  return { kind: 'directory', name } as unknown as FileSystemDirectoryHandle;
}

function localEntry(targetPath: string): MountTableEntry {
  return {
    targetPath,
    descriptor: {
      kind: 'local',
      mountId: newMountId(),
      idbHandleKey: targetPath,
    },
    createdAt: Date.now(),
  };
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
    await saveMountEntry(localEntry('/workspace/my-project'), handle);
    const entries = await getAllMountEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].targetPath).toBe('/workspace/my-project');
    expect(entries[0].descriptor.kind).toBe('local');
  });

  it('saves multiple entries', async () => {
    await saveMountEntry(localEntry('/workspace/a'), mockHandle('a'));
    await saveMountEntry(localEntry('/workspace/b'), mockHandle('b'));
    const entries = await getAllMountEntries();
    expect(entries).toHaveLength(2);
    const paths = entries.map((e) => e.targetPath).sort();
    expect(paths).toEqual(['/workspace/a', '/workspace/b']);
  });

  it('overwrites entry with same path', async () => {
    const first = localEntry('/workspace/x');
    await saveMountEntry(first, mockHandle('old'));
    const second: MountTableEntry = {
      ...first,
      descriptor: { ...first.descriptor, mountId: newMountId() },
    };
    await saveMountEntry(second, mockHandle('new'));
    const entries = await getAllMountEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].descriptor.mountId).toBe(second.descriptor.mountId);
  });

  it('removes a mount entry', async () => {
    await saveMountEntry(localEntry('/workspace/a'), mockHandle('a'));
    await saveMountEntry(localEntry('/workspace/b'), mockHandle('b'));
    await removeMountEntry('/workspace/a');
    const entries = await getAllMountEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].targetPath).toBe('/workspace/b');
  });

  it('remove is a no-op for non-existent path', async () => {
    await removeMountEntry('/does/not/exist');
    const entries = await getAllMountEntries();
    expect(entries).toEqual([]);
  });

  it('clears all entries', async () => {
    await saveMountEntry(localEntry('/workspace/a'), mockHandle('a'));
    await saveMountEntry(localEntry('/workspace/b'), mockHandle('b'));
    await clearMountEntries();
    const entries = await getAllMountEntries();
    expect(entries).toEqual([]);
  });

  it('persists s3 descriptor without a handle', async () => {
    const entry: MountTableEntry = {
      targetPath: '/mnt/s3',
      descriptor: {
        kind: 's3',
        mountId: newMountId(),
        source: 's3://my-bucket/prefix',
        profile: 'r2',
      },
      createdAt: Date.now(),
    };
    await saveMountEntry(entry);
    const entries = await getAllMountEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].descriptor.kind).toBe('s3');
    if (entries[0].descriptor.kind === 's3') {
      expect(entries[0].descriptor.source).toBe('s3://my-bucket/prefix');
      expect(entries[0].descriptor.profile).toBe('r2');
    }
  });
});
