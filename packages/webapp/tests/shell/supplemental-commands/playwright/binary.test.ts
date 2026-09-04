import { describe, expect, it, vi } from 'vitest';
import type { VirtualFS } from '../../../../src/fs/index.js';
import { readVfsFileBytes } from '../../../../src/shell/supplemental-commands/playwright/binary.js';
import {
  allBytesFixture,
  countReplacementSeqs,
  vfsLikeReadFile,
} from '../../helpers/playwright-harness.js';

describe('readVfsFileBytes', () => {
  it('returns the stored bytes for a 0x00..0xFF fixture, with no U+FFFD', async () => {
    const fixture = allBytesFixture();
    const files = new Map<string, string | Uint8Array>([['/allbytes.bin', fixture]]);
    const bytes = await readVfsFileBytes(
      { readFile: vfsLikeReadFile(files) } as VirtualFS,
      '/allbytes.bin'
    );
    expect(bytes.length).toBe(256);
    expect(Array.from(bytes)).toEqual(Array.from(fixture));
    expect(countReplacementSeqs(bytes)).toBe(0);
  });

  it('asks the VFS for binary encoding, never the UTF-8 default', async () => {
    const readFile = vi.fn(async () => new Uint8Array([0xff, 0xd8]));
    await readVfsFileBytes({ readFile } as unknown as VirtualFS, '/photo.jpg');
    expect(readFile).toHaveBeenCalledWith('/photo.jpg', { encoding: 'binary' });
  });

  it('fails loudly when a backend hands back a text decode that already lost bytes', async () => {
    const readFile = vi.fn(async () => 'ASCII\uFFFDMORE');
    await expect(
      readVfsFileBytes({ readFile } as unknown as VirtualFS, '/corrupt.bin')
    ).rejects.toThrow(/faithfully/);
  });

  it('rejects a content type that is neither bytes nor string', async () => {
    const readFile = vi.fn(async () => 42 as unknown as string);
    await expect(
      readVfsFileBytes({ readFile } as unknown as VirtualFS, '/weird.bin')
    ).rejects.toThrow(/unexpected file content type/);
  });

  it('encodes a valid UTF-8 string without substitution', async () => {
    const readFile = vi.fn(async () => 'café');
    const bytes = await readVfsFileBytes({ readFile } as unknown as VirtualFS, '/note.txt');
    expect(new TextDecoder().decode(bytes)).toBe('café');
    expect(countReplacementSeqs(bytes)).toBe(0);
  });
});
