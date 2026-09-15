import { describe, expect, it } from 'vitest';
import { type RenameFs, renameViaFs } from '../../../src/kernel/realm/rename-via-fs.js';

function memoryFs(initial: Record<string, string>): RenameFs & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>(
    Object.entries(initial).map(([k, v]) => [k, new TextEncoder().encode(v)])
  );
  const inos = new Map<string, number>();
  let nextIno = 1;
  for (const k of store.keys()) inos.set(k, nextIno++);
  const fs: RenameFs & { store: Map<string, Uint8Array> } = {
    store,
    async stat(path) {
      if (!store.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { identity: `vfs-ino:${inos.get(path)}` };
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

  it('string-identical paths are a no-op', async () => {
    const fs = memoryFs({ '/a': 'x' });
    await renameViaFs(fs, '/a', '/a');
    expect([...fs.store.keys()]).toEqual(['/a']);
  });
});
