import { describe, expect, it, vi } from 'vitest';
import { FsError } from '../../../src/fs/types.js';
import { VfsNode, vfsFile, WRITEBACK_MS } from '../../../src/kernel/wasm-realm/vfs-file.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_APPEND = 0o2000;

function memFs(files: Record<string, string>) {
  const writes: Array<[string, string]> = [];
  return {
    writes,
    fs: {
      readFileBuffer: vi.fn(async (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`);
        return bytes(files[p]!);
      }),
      writeFile: vi.fn(async (p: string, content: Uint8Array) => {
        files[p] = text(content);
        writes.push([p, text(content)]);
      }),
    },
  };
}

describe('vfsFile', () => {
  it('O_CREAT (create) makes a missing file at the open, and never clobbers one that exists', async () => {
    const files: Record<string, string> = { '/tmp/busy': 'another process wrote this' };
    const { fs, writes } = memFs(files);
    const made = vfsFile(fs, { path: '/tmp/err', flags: O_WRONLY, position: 0, create: true });
    const kept = vfsFile(fs, { path: '/tmp/busy', flags: O_WRONLY, position: 0, create: true });
    await made.file.seek!(0, 0); // let the open's own work settle (serialized on the node)
    await kept.file.seek!(0, 0);
    expect(writes).toEqual([['/tmp/err', '']]); // there before anything is written to it
    expect(files['/tmp/busy']).toBe('another process wrote this');
    await Promise.resolve(made.release());
    await Promise.resolve(kept.release());
    expect(writes).toEqual([['/tmp/err', '']]); // nothing dirty: no write-back clobbers either
  });

  it('reads from the handed-over offset on, and the offset is shared by every reference', async () => {
    const { fs } = memFs({ '/s.sh': 'echo one\necho two\n' });
    const file = vfsFile(fs, { path: '/s.sh', flags: 0, position: 9 });
    const other = file.retain(); // the forked child's copy
    expect(text(await file.file.read!(4))).toBe('echo');
    expect(text(await other.file.read!(100))).toBe(' two\n');
    expect(await file.file.read!(10)).toHaveLength(0);
    expect(fs.readFileBuffer).toHaveBeenCalledTimes(1);
  });

  it('writes at the shared offset and writes back on the last close', async () => {
    const { fs, writes } = memFs({ '/o': '' });
    const file = vfsFile(fs, { path: '/o', flags: O_WRONLY, position: 0 });
    const child = file.retain();
    await file.file.write!(bytes('a\n'));
    await child.file.write!(bytes('child\n'));
    await file.file.write!(bytes('b\n'));
    await Promise.resolve(child.release());
    expect(writes).toEqual([]);
    await Promise.resolve(file.release());
    expect(writes).toEqual([['/o', 'a\nchild\nb\n']]);
  });

  it('writes back shortly after writes while still open, so other processes see output as it comes', async () => {
    vi.useFakeTimers();
    try {
      const { fs, writes } = memFs({ '/log': '' });
      const file = vfsFile(fs, { path: '/log', flags: O_WRONLY, position: 0 });
      await file.file.write!(bytes('1\n'));
      await file.file.write!(bytes('2\n'));
      expect(writes).toEqual([]); // not per write
      await vi.advanceTimersByTimeAsync(WRITEBACK_MS);
      expect(writes).toEqual([['/log', '1\n2\n']]); // one write-back for both
      await file.file.write!(bytes('3\n'));
      await vi.advanceTimersByTimeAsync(WRITEBACK_MS);
      expect(writes.at(-1)).toEqual(['/log', '1\n2\n3\n']);
      // Nothing written since: no write-back, and none at close either.
      await vi.advanceTimersByTimeAsync(WRITEBACK_MS * 4);
      await Promise.resolve(file.release());
      expect(writes).toHaveLength(2);
      // An unlinked-while-open file never writes back, not even after a while.
      const orphan = new VfsNode(fs, '/gone', bytes(''), true);
      await orphan.pwrite(bytes('x'), 0);
      await vi.advanceTimersByTimeAsync(WRITEBACK_MS * 4);
      expect(writes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps handed-over orphan contents and never writes them back', async () => {
    const { fs, writes } = memFs({});
    const file = vfsFile(fs, {
      path: '/tmp/gone',
      flags: O_RDWR,
      position: 0,
      contents: bytes('secret'),
      orphan: true,
    });
    expect(text(await file.file.read!(6))).toBe('secret');
    expect(fs.readFileBuffer).not.toHaveBeenCalled();
    await file.file.write!(bytes('!'));
    await file.file.flush!();
    await Promise.resolve(file.release());
    expect(writes).toEqual([]);
  });

  it('appends with O_APPEND, seeks, and zero-fills a gap', async () => {
    const { fs, writes } = memFs({ '/f': 'head' });
    const file = vfsFile(fs, { path: '/f', flags: O_RDWR | O_APPEND, position: 0 });
    await file.file.write!(bytes('+tail'));
    expect(await file.file.seek!(0, 0)).toBe(0);
    expect(text(await file.file.read!(4))).toBe('head');
    expect(await file.file.seek!(-4, 2)).toBe(5);
    expect(await file.file.seek!(1, 1)).toBe(6);
    await expect(file.file.seek!(-100, 1)).rejects.toMatchObject({ code: 'EINVAL' });
    await file.file.flush!();
    expect(writes.at(-1)).toEqual(['/f', 'head+tail']);
    const gap = vfsFile(fs, { path: '/g', flags: O_WRONLY, position: 2 });
    await gap.file.write!(bytes('x'));
    await Promise.resolve(gap.release());
    expect(writes.at(-1)).toEqual(['/g', '\0\0x']);
  });

  it('is read-only or write-only as its flags say, and never writes back unchanged content', async () => {
    const { fs, writes } = memFs({ '/r': 'data' });
    expect(vfsFile(fs, { path: '/r', flags: 0, position: 0 }).file.write).toBeUndefined();
    expect(vfsFile(fs, { path: '/r', flags: O_WRONLY, position: 0 }).file.read).toBeUndefined();
    const reader = vfsFile(fs, { path: '/r', flags: 0, position: 0 });
    await reader.file.read!(2);
    await Promise.resolve(reader.release());
    expect(writes).toEqual([]);
  });
});

describe('a file past the whole-read cap (#3762)', () => {
  /** A hostfs-like mount: whole reads of `/m/big` are EFBIG, ranged reads work. */
  function cappedFs(content: string) {
    const writes: Array<[string, string]> = [];
    return {
      writes,
      fs: {
        readFileBuffer: vi.fn(async (p: string) => {
          throw new FsError('EFBIG', 'file exceeds the hostfs body cap', p);
        }),
        readFileRange: vi.fn(async (_p: string, start: number, end: number) =>
          bytes(content).slice(start, end)
        ),
        stat: vi.fn(async () => ({ size: bytes(content).byteLength })),
        writeFile: vi.fn(async (p: string, c: Uint8Array) => {
          writes.push([p, text(c)]);
        }),
      },
    };
  }

  it('reads it through ranged reads', async () => {
    const { fs } = cappedFs('a big file');
    const file = vfsFile(fs, { path: '/m/big', flags: 0, position: 2 });
    expect(text(await file.file.read!(100))).toBe('big file');
    expect(fs.readFileRange).toHaveBeenCalled();
  });

  it('appends to it without replacing what was there', async () => {
    const { fs, writes } = cappedFs('kept\n');
    const file = vfsFile(fs, {
      path: '/m/big',
      flags: O_WRONLY | O_APPEND,
      position: 0,
      create: true,
    });
    await file.file.write!(bytes('more\n'));
    await Promise.resolve(file.release());
    expect(writes).toEqual([['/m/big', 'kept\nmore\n']]);
  });

  it('never writes over a file it could not read', async () => {
    const { fs, writes } = cappedFs('precious');
    fs.readFileBuffer.mockRejectedValue(new FsError('EIO', 'bridge down', '/m/big'));
    const file = vfsFile(fs, {
      path: '/m/big',
      flags: O_WRONLY | O_APPEND,
      position: 0,
      create: true,
    });
    await expect(file.file.write!(bytes('x'))).rejects.toMatchObject({ code: 'EIO' });
    await Promise.resolve(file.release());
    expect(writes).toEqual([]);
  });

  it('keeps a failed delayed write-back dirty, so the close reports it', async () => {
    vi.useFakeTimers();
    try {
      const writeFile = vi.fn(async (p: string) => {
        throw new FsError('EFBIG', 'body exceeds the hostfs body cap', p);
      });
      const fs = { readFileBuffer: vi.fn(async () => bytes('old')), writeFile };
      const file = vfsFile(fs, { path: '/m/big', flags: O_WRONLY | O_APPEND, position: 0 });
      await file.file.write!(bytes('more'));
      await vi.advanceTimersByTimeAsync(WRITEBACK_MS); // the delayed write-back fails
      expect(writeFile).toHaveBeenCalledTimes(1);
      await expect(Promise.resolve(file.release())).rejects.toMatchObject({ code: 'EFBIG' });
      expect(writeFile).toHaveBeenCalledTimes(2); // retried at close, not forgotten
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the open's own failure (O_CREAT, O_TRUNC) at the close", async () => {
    const { fs, writes } = cappedFs('precious');
    fs.readFileBuffer.mockRejectedValue(new FsError('EIO', 'bridge down', '/m/big'));
    const created = vfsFile(fs, { path: '/m/big', flags: O_WRONLY, position: 0, create: true });
    await expect(Promise.resolve(created.release())).rejects.toMatchObject({ code: 'EIO' });
    const truncated = vfsFile(fs, { path: '/m/big', flags: O_WRONLY, position: 0, truncate: true });
    await expect(truncated.file.flush!()).rejects.toMatchObject({ code: 'EIO' });
    await Promise.resolve(truncated.release()); // reported once, by the op that took it
    expect(writes).toEqual([]);
  });
});
