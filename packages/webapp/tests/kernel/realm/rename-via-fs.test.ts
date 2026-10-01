import { describe, expect, it } from 'vitest';
import { type RenameFs, renameViaFs } from '../../../src/kernel/realm/rename-via-fs.js';

function memoryFs(
  initial: Record<string, string>,
  directories: string[] = []
): RenameFs & { store: Map<string, Uint8Array>; dirs: Set<string> } {
  const store = new Map<string, Uint8Array>(
    Object.entries(initial).map(([k, v]) => [k, new TextEncoder().encode(v)])
  );
  const dirs = new Set(['/', ...directories]);
  const inos = new Map<string, number>();
  let nextIno = 1;
  for (const k of store.keys()) inos.set(k, nextIno++);
  const fs: RenameFs & { store: Map<string, Uint8Array>; dirs: Set<string> } = {
    store,
    dirs,
    async stat(path) {
      if (dirs.has(path)) return { identity: `vfs-dir:${path}`, isDirectory: true };
      if (!store.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { identity: `vfs-ino:${inos.get(path)}`, isDirectory: false };
    },
    async readFileBuffer(path) {
      const bytes = store.get(path);
      if (!bytes) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return bytes.slice();
    },
    async writeFile(path, content) {
      const bytes =
        typeof content === 'string' ? new TextEncoder().encode(content) : content.slice();
      store.set(path, bytes);
      if (!inos.has(path)) inos.set(path, nextIno++);
    },
    async rm(path) {
      store.delete(path);
      inos.delete(path);
    },
  };
  return fs;
}

describe('renameViaFs', () => {
  it('prefers rename when present', async () => {
    const fs = memoryFs({ '/a': 'x' });
    const calls: string[] = [];
    fs.rename = async (src, dest) => {
      calls.push(`${src}->${dest}`);
    };
    await renameViaFs(fs, '/a', '/b');
    expect(calls).toEqual(['/a->/b']);
    expect(fs.store.has('/a')).toBe(true);
  });

  it('falls through to mv when rename is absent (VfsAdapter)', async () => {
    const fs = memoryFs({ '/a': 'x' });
    const calls: string[] = [];
    fs.mv = async (src, dest) => {
      calls.push(`${src}->${dest}`);
    };
    await renameViaFs(fs, '/a', '/b');
    expect(calls).toEqual(['/a->/b']);
  });

  it('copy+rm fallback no-ops when dest is the same inode', async () => {
    const fs = memoryFs({ '/Slicc.md': 'keep' });
    // Two strings, one identity — the APFS case-fold collision.
    const origStat = fs.stat.bind(fs);
    fs.stat = async (path) => {
      if (path === '/SLICC.md') return origStat('/Slicc.md');
      return origStat(path);
    };
    await renameViaFs(fs, '/Slicc.md', '/SLICC.md');
    expect([...fs.store.keys()]).toEqual(['/Slicc.md']);
    expect(new TextDecoder().decode(fs.store.get('/Slicc.md'))).toBe('keep');
  });

  it('copy+rm fallback still moves distinct files, reading source first', async () => {
    const fs = memoryFs({ '/from': 'payload' });
    await renameViaFs(fs, '/from', '/to');
    expect(fs.store.has('/from')).toBe(false);
    expect(new TextDecoder().decode(fs.store.get('/to'))).toBe('payload');
  });

  it('falls back to copy+rm when native rename throws (non-hostfs mount)', async () => {
    const fs = memoryFs({ '/from': 'payload' });
    fs.rename = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    await renameViaFs(fs, '/from', '/to');
    expect(fs.store.has('/from')).toBe(false);
    expect(new TextDecoder().decode(fs.store.get('/to'))).toBe('payload');
  });

  it('string-identical paths are a no-op', async () => {
    const fs = memoryFs({ '/a': 'x' });
    await renameViaFs(fs, '/a', '/a');
    expect([...fs.store.keys()]).toEqual(['/a']);
  });

  it('copy+rm fallback does not treat colliding inodes on different devices as one file', async () => {
    const fs = memoryFs({ '/a': 'src', '/b': 'dest' });
    fs.stat = async (path) => {
      if (path === '/') return { isDirectory: true };
      if (path === '/a') return { identity: 'vfs:1:12' };
      if (path === '/b') return { identity: 'vfs:2:12' };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    fs.rename = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    await renameViaFs(fs, '/a', '/b');
    expect(fs.store.has('/a')).toBe(false);
    expect(new TextDecoder().decode(fs.store.get('/b'))).toBe('src');
  });

  describe("the copy fallback keeps rename(2)'s contract", () => {
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

    it('fails with the native error when the destination directory is missing', async () => {
      const fs = memoryFs({ '/t/x1/dep': 'dep' }, ['/t', '/t/x1']);
      fs.rename = async () => {
        throw enoent();
      };
      await expect(renameViaFs(fs, '/t/x1', '/o/h1')).rejects.toMatchObject({ code: 'ENOENT' });
      // Nothing created, nothing removed.
      expect([...fs.store.keys()]).toEqual(['/t/x1/dep']);
    });

    it('a file is not copied into a missing directory either', async () => {
      const fs = memoryFs({ '/f': 'F' });
      await expect(renameViaFs(fs, '/f', '/nope/f2')).rejects.toMatchObject({ code: 'ENOENT' });
      expect([...fs.store.keys()]).toEqual(['/f']);
    });

    it('ENOTDIR when the parent is a file, even after a native ENOENT', async () => {
      const fs = memoryFs({ '/f': 'F', '/file': 'x' });
      fs.rename = async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      };
      await expect(renameViaFs(fs, '/f', '/file/f2')).rejects.toMatchObject({ code: 'ENOTDIR' });
    });

    it('ENOTDIR when the destination parent is a file', async () => {
      const fs = memoryFs({ '/f': 'F', '/file': 'x' });
      await expect(renameViaFs(fs, '/f', '/file/f2')).rejects.toMatchObject({ code: 'ENOTDIR' });
      expect(new TextDecoder().decode(fs.store.get('/f'))).toBe('F');
    });

    it('never copies a directory as a file: EXDEV when no native rename moved it', async () => {
      const fs = memoryFs({ '/t/x1/dep': 'dep' }, ['/t', '/t/x1', '/o']);
      fs.rename = async () => {
        throw enoent(); // a mount the store cannot see into
      };
      await expect(renameViaFs(fs, '/t/x1', '/o/h1')).rejects.toMatchObject({ code: 'EXDEV' });
      expect([...fs.store.keys()]).toEqual(['/t/x1/dep']);
    });

    it("keeps a native rename's definitive error for a directory", async () => {
      const fs = memoryFs({}, ['/a', '/b']);
      fs.rename = async () => {
        throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' });
      };
      await expect(renameViaFs(fs, '/a', '/b')).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    });

    it('calls the native rename on its handle (a VirtualFS method needs its this)', async () => {
      const fs = memoryFs({ '/a': 'x' }) as ReturnType<typeof memoryFs> & { moved?: string };
      fs.rename = async function (this: { moved?: string }, src, dest) {
        this.moved = `${src}->${dest}`;
      };
      await renameViaFs(fs, '/a', '/b');
      expect(fs.moved).toBe('/a->/b');
    });

    it('calls the native rename once, never its mv alias after it threw', async () => {
      const fs = memoryFs({ '/a': 'x' });
      const calls: string[] = [];
      fs.rename = async () => {
        calls.push('rename');
        throw Object.assign(new Error('EIO: persist'), { code: 'EIO' });
      };
      fs.mv = async () => {
        calls.push('mv');
      };
      await renameViaFs(fs, '/a', '/b');
      expect(calls).toEqual(['rename']);
    });

    it("reports a failed parent lookup's own error, not a missing directory", async () => {
      const fs = memoryFs({ '/f': 'F' }, ['/d']);
      const stat = fs.stat.bind(fs);
      fs.stat = async (path) => {
        if (path === '/d') throw Object.assign(new Error('EIO: offline'), { code: 'EIO' });
        return stat(path);
      };
      fs.rename = async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      };
      await expect(renameViaFs(fs, '/f', '/d/f')).rejects.toMatchObject({ code: 'EIO' });
      expect([...fs.store.keys()]).toEqual(['/f']);
    });
  });
});
