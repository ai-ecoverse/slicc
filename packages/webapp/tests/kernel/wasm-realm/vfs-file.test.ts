import { describe, expect, it, vi } from 'vitest';
import { vfsFile } from '../../../src/kernel/wasm-realm/vfs-file.js';

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
  it('reads from the handed-over offset on, and the offset is shared by every reference', async () => {
    const { fs } = memFs({ '/s.sh': 'echo one\necho two\n' });
    const file = vfsFile(fs, { path: '/s.sh', flags: 0, position: 9 });
    const other = file.retain();
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
