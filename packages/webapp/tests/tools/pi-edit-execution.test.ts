import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { executePiEdit } from '../../src/tools/pi-edit-execution.js';

let dbCounter = 0;

test('Pi edit rules write through the VFS', async () => {
  const fs = await VirtualFS.create({ dbName: `pi-edit-${dbCounter++}`, wipe: true });
  await fs.mkdir('/workspace', { recursive: true });
  await fs.writeFile('/workspace/note.txt', 'before\n');

  const result = await executePiEdit(fs, '/workspace', {
    path: 'note.txt',
    edits: [{ oldText: 'before', newText: 'after' }],
  });

  expect(result.isError).not.toBe(true);
  expect(await fs.readTextFile('/workspace/note.txt')).toBe('after\n');
});

test("normalizes model-supplied paths the way Pi's edit tool does", async () => {
  const fs = await VirtualFS.create({ dbName: `pi-edit-${dbCounter++}`, wipe: true });
  await fs.mkdir('/workspace', { recursive: true });
  await fs.writeFile('/workspace/note.md', 'one\n');
  await fs.writeFile('/workspace/my note.md', 'two\n');

  await executePiEdit(fs, '/workspace', {
    path: '@/workspace/note.md',
    edits: [{ oldText: 'one', newText: 'uno' }],
  });
  await executePiEdit(fs, '/workspace', {
    path: 'my note.md',
    edits: [{ oldText: 'two', newText: 'dos' }],
  });

  expect(await fs.readTextFile('/workspace/note.md')).toBe('uno\n');
  expect(await fs.readTextFile('/workspace/my note.md')).toBe('dos\n');
});

test('serializes concurrent edits to one file through a symlink and its real path', async () => {
  const fs = await VirtualFS.create({ dbName: `pi-edit-${dbCounter++}`, wipe: true });
  await fs.mkdir('/workspace', { recursive: true });
  await fs.writeFile('/workspace/real.txt', 'alpha\nbeta\n');
  await fs.symlink('/workspace/real.txt', '/workspace/link.txt');
  // Hold the first edit's read so both edits are in flight before either writes.
  const realRead = fs.readTextFile.bind(fs);
  let releaseFirstRead!: () => void;
  const firstRead = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  let reads = 0;
  fs.readTextFile = async (path: string) => {
    const content = await realRead(path);
    if (reads++ === 0) await firstRead;
    return content;
  };
  try {
    const viaReal = executePiEdit(fs, '/workspace', {
      path: 'real.txt',
      edits: [{ oldText: 'alpha', newText: 'ALPHA' }],
    });
    const viaLink = executePiEdit(fs, '/workspace', {
      path: 'link.txt',
      edits: [{ oldText: 'beta', newText: 'BETA' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirstRead();
    await Promise.all([viaReal, viaLink]);
  } finally {
    fs.readTextFile = realRead;
  }

  expect(await fs.readTextFile('/workspace/real.txt')).toBe('ALPHA\nBETA\n');
});

test('rejects a directory the way Pi does', async () => {
  const fs = await VirtualFS.create({ dbName: `pi-edit-${dbCounter++}`, wipe: true });
  await fs.mkdir('/workspace/dir', { recursive: true });

  await expect(
    executePiEdit(fs, '/workspace', { path: 'dir', edits: [{ oldText: 'a', newText: 'b' }] })
  ).rejects.toThrow('Could not edit file: dir. Path is not a file.');
});
