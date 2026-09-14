import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';

let dbCounter = 0;

async function makeFs(): Promise<VirtualFS> {
  const fs = await VirtualFS.create({ dbName: `root-lstat-${dbCounter++}`, wipe: true });
  await fs.mkdir('/workspace', { recursive: true });
  await fs.writeFile('/workspace/a.txt', 'hi');
  return fs;
}

describe('VirtualFS — the root is reachable through lstat', () => {
  it('lstat("/") reports a directory instead of throwing ENOENT', async () => {
    const fs = await makeFs();
    const st = await fs.lstat('/');
    expect(st.type).toBe('directory');
    expect(st.isSymlink).toBeFalsy();
  });

  it('lstat("/") agrees with stat("/")', async () => {
    const fs = await makeFs();
    const [st, lst] = [await fs.stat('/'), await fs.lstat('/')];
    expect(lst.type).toBe(st.type);
  });

  it.each(['/', '/.', '/workspace/..'])(
    'lstat(%s) resolves — every spelling of the root',
    async (path) => {
      const fs = await makeFs();
      expect((await fs.lstat(path)).type).toBe('directory');
    }
  );

  it('lstat still reports a real symlink as a symlink', async () => {
    const fs = await makeFs();
    await fs.symlink('/workspace/a.txt', '/link');
    const st = await fs.lstat('/link');
    expect(st.type).toBe('symlink');
    expect(st.symlinkTarget).toBe('/workspace/a.txt');
  });

  it('a du-style walk of / can lstat every entry it lists', async () => {
    const fs = await makeFs();

    await expect(fs.lstat('/')).resolves.toBeDefined();
    for (const entry of await fs.readDir('/')) {
      await expect(fs.lstat(`/${entry.name}`)).resolves.toBeDefined();
    }
  });

  it('statSync("/") and lstatSync("/") return the root, not null', async () => {
    const fs = await makeFs();
    expect(fs.backend).toBe('memory');
    expect(fs.statSync('/')?.type).toBe('directory');
    expect(fs.lstatSync('/')?.type).toBe('directory');
  });
});
