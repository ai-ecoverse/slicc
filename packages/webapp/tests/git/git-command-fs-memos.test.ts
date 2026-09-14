import 'fake-indexeddb/auto';
import * as isoGit from 'isomorphic-git';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';
import { createIsomorphicGitFs } from '../../src/git/vfs-fs-adapter.js';

const CWD = '/project';
const PACK_DIR = `${CWD}/.git/objects/pack`;
const INDEX = `${CWD}/.git/index`;

let dbCounter = 0;

function countingVfs(vfs: VirtualFS): { fs: VirtualFS; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const counted = new Set(['stat', 'lstat', 'readFile', 'readDir']);
  const proxy = new Proxy(vfs, {
    get(target, prop, _receiver) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (!counted.has(String(prop))) return fn.bind(target);
      return (...args: unknown[]) => {
        const key = `${String(prop)} ${String(args[0])}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return fn.apply(target, args);
      };
    },
  });
  return { fs: proxy as VirtualFS, counts };
}

describe('per-invocation git fs memos (#2709 read cache over #2712 object memo)', () => {
  let vfs: VirtualFS;
  let counting: { fs: VirtualFS; counts: Map<string, number> };
  let commands: GitCommands;

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-fs-memos-${testId}`, wipe: true });
    const setup = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-fs-memos-global-${testId}`,
    });
    await setup.execute(['init'], CWD);
    for (let i = 0; i < 6; i++) {
      await vfs.writeFile(`${CWD}/tracked-${i}.txt`, `file ${i}\n`);
    }
    await setup.execute(['add', '.'], CWD);
    await setup.execute(['commit', '-m', 'first'], CWD);
    await packEverything();

    for (let i = 0; i < 4; i++) await vfs.writeFile(`${CWD}/untracked-${i}.txt`, 'nope\n');

    counting = countingVfs(vfs);
    commands = new GitCommands({
      fs: counting.fs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-fs-memos-global-${testId}`,
    });
    counting.counts.clear();
  });

  async function packEverything(): Promise<void> {
    const lfs = createIsomorphicGitFs(vfs);
    const oids: string[] = [];
    for (const dir of await vfs.readDir(`${CWD}/.git/objects`)) {
      if (!/^[0-9a-f]{2}$/.test(dir.name)) continue;
      for (const file of await vfs.readDir(`${CWD}/.git/objects/${dir.name}`)) {
        oids.push(dir.name + file.name);
      }
    }
    const { filename } = await isoGit.packObjects({ fs: lfs, dir: CWD, oids, write: true });
    await isoGit.indexPack({ fs: lfs, dir: CWD, filepath: `.git/objects/pack/${filename}` });
    for (const dir of await vfs.readDir(`${CWD}/.git/objects`)) {
      if (!/^[0-9a-f]{2}$/.test(dir.name)) continue;
      await vfs.rm(`${CWD}/.git/objects/${dir.name}`, { recursive: true });
    }
  }

  const countOf = (key: string): number => counting.counts.get(key) ?? 0;

  it('pays both costs without either memo (control)', async () => {
    await isoGit.statusMatrix({
      fs: createIsomorphicGitFs(counting.fs, { statCacheMax: 0 }),
      dir: CWD,
      refresh: false,
    });

    expect(countOf(`lstat ${INDEX}`)).toBeGreaterThan(5);

    expect(countOf(`readDir ${PACK_DIR}`)).toBeGreaterThan(1);
  });

  it('gives one command the read cache, the object memo AND the stat cache', async () => {
    const result = await commands.execute(['status', '--short'], CWD);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('?? untracked-0.txt');

    for (let i = 0; i < 6; i++) {
      expect(countOf(`lstat ${CWD}/tracked-${i}.txt`)).toBe(0);
      expect(countOf(`stat ${CWD}/tracked-${i}.txt`)).toBe(0);
    }
    for (let i = 0; i < 4; i++) {
      expect(countOf(`lstat ${CWD}/untracked-${i}.txt`)).toBe(0);
    }

    expect(countOf(`readDir ${CWD}`)).toBeGreaterThan(0);

    expect(countOf(`lstat ${INDEX}`)).toBe(1);

    expect(countOf(`readDir ${PACK_DIR}`)).toBe(2);

    expect(
      [...counting.counts.keys()].filter((key) => /^readFile .*\/objects\/[0-9a-f]{2}\//.test(key))
    ).toEqual([]);
  });

  it('carries none of the per-invocation memos across two sequential commands', async () => {
    await commands.execute(['status', '--short'], CWD);
    await commands.execute(['status', '--short'], CWD);

    expect(countOf(`lstat ${INDEX}`)).toBe(2);
    expect(countOf(`readDir ${PACK_DIR}`)).toBe(4);

    expect(countOf(`readDir ${CWD}`)).toBe(2);
  });

  it('shares neither memo between two commands running at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let announce!: () => void;
    const parked = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const realReadDir = vfs.readDir.bind(vfs);
    let gated = false;

    const gatedVfs = new Proxy(counting.fs, {
      get(target, prop, receiver) {
        if (prop !== 'readDir') return Reflect.get(target, prop, receiver);
        return async (path: string) => {
          const counted = Reflect.get(target, prop, receiver) as typeof realReadDir;
          if (path === PACK_DIR && !gated) {
            gated = true;
            announce();
            await gate;
          }
          return await counted(path);
        };
      },
    }) as VirtualFS;
    const overlapping = new GitCommands({
      fs: gatedVfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: 'git-fs-memos-overlap',
    });

    const first = overlapping.execute(['status', '--short'], CWD);
    await parked;
    const second = overlapping.execute(['status', '--short'], CWD);
    for (let i = 0; i < 50 && countOf(`readDir ${PACK_DIR}`) < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    release();

    expect((await second).exitCode).toBe(0);
    expect((await first).exitCode).toBe(0);

    expect(countOf(`lstat ${INDEX}`)).toBe(2);

    expect(countOf(`readDir ${PACK_DIR}`)).toBe(3);
  });
});

describe('git log --all across commands (#2710 pack cache under #2712 traversal)', () => {
  let vfs: VirtualFS;
  let counting: { fs: VirtualFS; counts: Map<string, number> };
  let commands: GitCommands;
  let packName = '';

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-log-all-cache-${testId}`, wipe: true });
    const setup = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-log-all-cache-global-${testId}`,
    });
    await setup.execute(['init'], CWD);
    const commit = async (name: string, timestamp: number): Promise<void> => {
      await vfs.writeFile(`${CWD}/${name}.txt`, `${name}\n`);
      await setup.execute(['add', `${name}.txt`], CWD);
      await isoGit.commit({
        fs: createIsomorphicGitFs(vfs),
        dir: CWD,
        message: name,
        author: { name: 'Test User', email: 'test@example.com', timestamp },
      });
    };
    await commit('base', 1_700_000_000);
    for (let i = 0; i < 3; i++) {
      await setup.execute(['checkout', '-b', `topic-${i}`], CWD);
      await commit(`topic-${i}`, 1_700_001_000 + i);
      await setup.execute(['checkout', 'main'], CWD);
    }
    packName = await packAll(vfs);

    counting = countingVfs(vfs);
    commands = new GitCommands({
      fs: counting.fs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-log-all-cache-global-${testId}`,
    });
    counting.counts.clear();
  });

  it('re-reads no pack on the second run, but rebuilds both per-invocation memos', async () => {
    const countOf = (key: string): number => counting.counts.get(key) ?? 0;
    const first = await commands.execute(['log', '--all', '-n', '20', '--oneline'], CWD);
    const idxAfterFirst = countOf(`readFile ${PACK_DIR}/${packName}.idx`);
    const packAfterFirst = countOf(`readFile ${PACK_DIR}/${packName}.pack`);

    const second = await commands.execute(['log', '--all', '-n', '20', '--oneline'], CWD);

    expect(first.exitCode).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout.split('\n').filter(Boolean)).toHaveLength(4);

    expect(idxAfterFirst).toBe(1);
    expect(countOf(`readFile ${PACK_DIR}/${packName}.idx`)).toBe(1);
    expect(countOf(`readFile ${PACK_DIR}/${packName}.pack`)).toBe(packAfterFirst);

    expect(countOf(`readDir ${PACK_DIR}`)).toBe(4);
    expect(countOf(`readDir ${CWD}/.git/refs/heads`)).toBe(2);
    expect(countOf(`readFile ${CWD}/.git/refs/heads/main`)).toBe(2);
  });
});

async function packAll(vfs: VirtualFS): Promise<string> {
  const lfs = createIsomorphicGitFs(vfs);
  const oids: string[] = [];
  for (const dir of await vfs.readDir(`${CWD}/.git/objects`)) {
    if (!/^[0-9a-f]{2}$/.test(dir.name)) continue;
    for (const file of await vfs.readDir(`${CWD}/.git/objects/${dir.name}`)) {
      oids.push(dir.name + file.name);
    }
  }
  const { filename } = await isoGit.packObjects({ fs: lfs, dir: CWD, oids, write: true });
  await isoGit.indexPack({ fs: lfs, dir: CWD, filepath: `.git/objects/pack/${filename}` });
  for (const dir of await vfs.readDir(`${CWD}/.git/objects`)) {
    if (!/^[0-9a-f]{2}$/.test(dir.name)) continue;
    await vfs.rm(`${CWD}/.git/objects/${dir.name}`, { recursive: true });
  }
  return filename.replace(/\.pack$/, '');
}
