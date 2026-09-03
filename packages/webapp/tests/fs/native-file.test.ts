import { describe, expect, it } from 'vitest';
import { fileFromDirectoryHandle } from '../../src/fs/native-file.js';
import { createDirectoryHandle } from './fsa-test-helpers.js';

describe('fileFromDirectoryHandle', () => {
  const root = createDirectoryHandle({
    'top.txt': 'top',
    media: { clips: { 'a.mp4': 'AAAA' }, 'note.txt': 'n' },
  });

  it('walks nested directories to the File behind a path', async () => {
    const file = await fileFromDirectoryHandle(root, '/media/clips/a.mp4');
    expect(file).not.toBeNull();
    expect(await (file as File).text()).toBe('AAAA');
  });

  it('accepts a relative path and a root-level file', async () => {
    const file = await fileFromDirectoryHandle(root, 'top.txt');
    expect(await (file as File).text()).toBe('top');
  });

  it('answers null for a missing path instead of throwing', async () => {
    await expect(fileFromDirectoryHandle(root, '/media/clips/gone.mp4')).resolves.toBeNull();
    await expect(fileFromDirectoryHandle(root, '/nope/x.mp4')).resolves.toBeNull();
  });

  it('answers null for a directory and for the root itself', async () => {
    await expect(fileFromDirectoryHandle(root, '/media')).resolves.toBeNull();
    await expect(fileFromDirectoryHandle(root, '/')).resolves.toBeNull();
    await expect(fileFromDirectoryHandle(root, '')).resolves.toBeNull();
  });
});
