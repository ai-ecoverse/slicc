import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { executePiEdit } from '../../src/tools/pi-edit-execution.js';

let dbCounter = 0;

test('Pi 0.99 edit tool writes through the VFS context adapter', async () => {
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
