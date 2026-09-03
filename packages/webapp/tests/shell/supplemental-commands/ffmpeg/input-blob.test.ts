import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import {
  bytesToBlob,
  cloneableBlob,
  readInputBlob,
} from '../../../../src/shell/supplemental-commands/ffmpeg/input-blob.js';

function fsWith(overrides: Record<string, unknown>): IFileSystem {
  return {
    readFileBuffer: vi.fn(async () => new Uint8Array([1, 2, 3])),
    ...overrides,
  } as unknown as IFileSystem;
}

describe('readInputBlob', () => {
  it('hands back the native File when the VFS has one, without reading bytes', async () => {
    const file = new File(['media'], 'clip.mp4');
    const getNativeFile = vi.fn(async () => file);
    const fs = fsWith({ getNativeFile });
    const blob = await readInputBlob(fs, '/clip.mp4');
    expect(blob).toBe(file);
    expect(fs.readFileBuffer).not.toHaveBeenCalled();
    expect(getNativeFile).toHaveBeenCalledWith('/clip.mp4');
  });

  it('falls back to a whole-file read when there is no native handle', async () => {
    const fs = fsWith({ getNativeFile: vi.fn(async () => null) });
    const blob = await readInputBlob(fs, '/clip.mp4');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(fs.readFileBuffer).toHaveBeenCalledWith('/clip.mp4');
  });

  it('falls back when the native lookup throws', async () => {
    const fs = fsWith({
      getNativeFile: vi.fn(async () => {
        throw new Error('handle revoked');
      }),
    });
    const blob = await readInputBlob(fs, '/clip.mp4');
    expect(blob.size).toBe(3);
  });

  it('works against a plain just-bash IFileSystem with no getNativeFile at all', async () => {
    const fs = fsWith({});
    const blob = await readInputBlob(fs, '/clip.mp4');
    expect(blob.size).toBe(3);
  });

  it('surfaces the read error when the fallback read fails', async () => {
    const fs = fsWith({
      readFileBuffer: vi.fn(async () => {
        throw new Error('ENOENT: /clip.mp4');
      }),
    });
    await expect(readInputBlob(fs, '/clip.mp4')).rejects.toThrow('ENOENT');
  });
});

describe('bytesToBlob', () => {
  it('wraps the bytes verbatim', async () => {
    const blob = bytesToBlob(new Uint8Array([9, 8, 7]));
    expect(blob.size).toBe(3);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
  });
});

describe('cloneableBlob', () => {
  it('hands back the File itself when it structured-clones', async () => {
    const file = new File(['abc'], 'a.bin', { type: 'video/mp4' });
    const notes: string[] = [];
    expect(await cloneableBlob(file, '/a.bin', (l) => notes.push(l))).toBe(file);
    expect(notes).toEqual([]);
  });

  it('wraps a non-cloneable File in a Blob over it (still lazy) and says so', async () => {
    const file = new File(['abcd'], 'a.bin', { type: 'video/mp4' });
    const notes: string[] = [];
    const probe = (v: unknown) => {
      if (v instanceof File) throw new Error('DataCloneError');
    };
    const out = await cloneableBlob(file, '/a.bin', (l) => notes.push(l), probe);
    expect(out).not.toBe(file);
    expect(out.size).toBe(4);
    expect(out.type).toBe('video/mp4');
    expect(notes).toEqual([
      'ffmpeg: /a.bin: native File is not transferable to the worker; wrapped it in a Blob',
    ]);
  });

  it('falls back to a whole-file read when nothing lazy clones', async () => {
    const file = new File(['abcde'], 'a.bin');
    const notes: string[] = [];
    let calls = 0;
    const probe = () => {
      calls += 1;
      throw new Error('DataCloneError');
    };
    const out = await cloneableBlob(file, '/a.bin', (l) => notes.push(l), probe);
    expect(calls).toBe(2);
    expect(await out.text()).toBe('abcde');
    expect(notes[0]).toMatch(/read 5 bytes into memory/);
  });
});
