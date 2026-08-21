/**
 * Tests for mention → VFS path resolution.
 *
 * The resolver is what makes the permissive mention heuristic safe, so the cases
 * that matter are the ones where it must say NO (nonexistent files, near-miss
 * suffixes) and the ones where it must stay cheap (one index build, memoized
 * answers, bounded walks).
 */

import { describe, expect, it } from 'vitest';
import { FileMentionResolver } from '../../src/core/file-mention-resolver.js';
import type { DirEntry, Stats } from '../../src/fs/types.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';

/**
 * A VFS built from a flat list of file paths, counting the calls it serves so
 * tests can assert on walk cost as well as on answers.
 */
function fakeVfs(files: string[]): LocalVfsClient & { readDirCalls: number } {
  const dirs = new Map<string, Map<string, DirEntry>>();
  const fileSet = new Set(files);

  const ensureDir = (path: string): Map<string, DirEntry> => {
    let dir = dirs.get(path);
    if (!dir) {
      dir = new Map();
      dirs.set(path, dir);
    }
    return dir;
  };

  for (const file of files) {
    const segments = file.split('/').filter(Boolean);
    let parent = '';
    for (let i = 0; i < segments.length; i += 1) {
      const name = segments[i] as string;
      const isLeaf = i === segments.length - 1;
      ensureDir(parent === '' ? '/' : parent).set(name, {
        name,
        type: isLeaf ? 'file' : 'directory',
      });
      parent = `${parent}/${name}`;
    }
  }

  const client = {
    readDirCalls: 0,
    async readDir(path: string): Promise<DirEntry[]> {
      client.readDirCalls += 1;
      const dir = dirs.get(path === '/' ? '/' : path);
      if (!dir) throw new Error(`ENOENT: ${path}`);
      return [...dir.values()];
    },
    async readFile(): Promise<string> {
      return '';
    },
    async stat(path: string): Promise<Stats> {
      if (fileSet.has(path)) return { type: 'file', size: 1, mtime: 0, ctime: 0 };
      if (dirs.has(path)) return { type: 'directory', size: 0, mtime: 0, ctime: 0 };
      throw new Error(`ENOENT: ${path}`);
    },
  };
  return client;
}

const ROOTS = { roots: ['/workspace'] };

describe('FileMentionResolver', () => {
  it('resolves a bare filename to its real path', async () => {
    const fs = fakeVfs(['/workspace/bb.jsh']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    expect((await resolver.resolve('bb.jsh')).matches).toEqual(['/workspace/bb.jsh']);
  });

  it('returns no matches for a file that does not exist', async () => {
    const fs = fakeVfs(['/workspace/bb.jsh']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    expect((await resolver.resolve('nope.jsh')).matches).toEqual([]);
  });

  it('confirms an absolute path with a direct stat, without indexing', async () => {
    const fs = fakeVfs(['/workspace/a/b/deep.txt']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    expect((await resolver.resolve('/workspace/a/b/deep.txt')).matches).toEqual([
      '/workspace/a/b/deep.txt',
    ]);
    // A direct hit must not pay for a tree walk.
    expect(fs.readDirCalls).toBe(0);
  });

  it('rejects an absolute path that is a directory, not a file', async () => {
    const fs = fakeVfs(['/workspace/a/b.txt']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    expect((await resolver.resolve('/workspace/a')).matches).toEqual([]);
  });

  it('reports every match for an ambiguous basename, shallowest first', async () => {
    const fs = fakeVfs([
      '/workspace/deep/nested/again/main.ts',
      '/workspace/main.ts',
      '/workspace/pkg/main.ts',
    ]);
    const resolver = new FileMentionResolver(fs, ROOTS);
    expect((await resolver.resolve('main.ts')).matches).toEqual([
      '/workspace/main.ts',
      '/workspace/pkg/main.ts',
      '/workspace/deep/nested/again/main.ts',
    ]);
  });

  it('disambiguates using a partial path', async () => {
    const fs = fakeVfs(['/workspace/a/src/main.ts', '/workspace/b/src/main.ts']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    expect((await resolver.resolve('a/src/main.ts')).matches).toEqual(['/workspace/a/src/main.ts']);
  });

  it('only matches a partial path at a segment boundary', async () => {
    // `xwebapp/main.ts` ends with `webapp/main.ts` as a STRING but is a
    // different directory, so it must not match.
    const fs = fakeVfs(['/workspace/xwebapp/main.ts']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    expect((await resolver.resolve('webapp/main.ts')).matches).toEqual([]);
  });

  it('treats a ./-prefixed mention as repo-relative', async () => {
    const fs = fakeVfs(['/workspace/pkg/main.ts']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    expect((await resolver.resolve('./pkg/main.ts')).matches).toEqual(['/workspace/pkg/main.ts']);
  });

  it('resolves a ~/-prefixed mention', async () => {
    // No absolute VFS path ends with a literal `~/` segment, so the prefix has
    // to be stripped or these mentions could never match.
    const fs = fakeVfs(['/workspace/.config/app.toml']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    expect((await resolver.resolve('~/.config/app.toml')).matches).toEqual([
      '/workspace/.config/app.toml',
    ]);
  });

  it('resolves a ../-prefixed mention, however deeply relative', async () => {
    const fs = fakeVfs(['/workspace/pkg/src/main.ts']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    expect((await resolver.resolve('../src/main.ts')).matches).toEqual([
      '/workspace/pkg/src/main.ts',
    ]);
    expect((await resolver.resolve('../../src/main.ts')).matches).toEqual([
      '/workspace/pkg/src/main.ts',
    ]);
  });

  it('builds the index once no matter how many lookups follow', async () => {
    const fs = fakeVfs(['/workspace/a.ts', '/workspace/b.ts', '/workspace/c.ts']);
    const resolver = new FileMentionResolver(fs, { ...ROOTS, ttlMs: Number.POSITIVE_INFINITY });
    await Promise.all([resolver.resolve('a.ts'), resolver.resolve('b.ts')]);
    const afterFirst = fs.readDirCalls;
    await resolver.resolve('c.ts');
    expect(fs.readDirCalls).toBe(afterFirst);
  });

  it('memoizes repeated lookups of the same mention', async () => {
    const fs = fakeVfs(['/workspace/a.ts']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    const [first, second] = await Promise.all([resolver.resolve('a.ts'), resolver.resolve('a.ts')]);
    expect(first).toBe(second);
  });

  it('re-reads the VFS after invalidate', async () => {
    const fs = fakeVfs(['/workspace/a.ts']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    await resolver.resolve('a.ts');
    const before = fs.readDirCalls;
    resolver.invalidate();
    await resolver.resolve('a.ts');
    expect(fs.readDirCalls).toBeGreaterThan(before);
  });

  it('skips node_modules and other high-volume directories', async () => {
    const fs = fakeVfs(['/workspace/node_modules/pkg/index.js', '/workspace/index.js']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    expect((await resolver.resolve('index.js')).matches).toEqual(['/workspace/index.js']);
  });

  it('stops indexing at the entry ceiling instead of walking forever', async () => {
    const many = Array.from({ length: 200 }, (_, i) => `/workspace/f${i}.ts`);
    const fs = fakeVfs(many);
    const resolver = new FileMentionResolver(fs, { ...ROOTS, maxEntries: 10 });
    const found = await resolver.resolveAll(many.map((p) => p.slice('/workspace/'.length)));
    expect(found.filter((r) => r.matches.length > 0).length).toBe(10);
  });

  it('re-walks after the index TTL expires, so new files become linkable', async () => {
    // Agents create a file and then name it in the same turn; an index cached
    // for the life of the view would leave exactly that mention unlinkable.
    const fs = fakeVfs(['/workspace/a.ts']);
    const resolver = new FileMentionResolver(fs, { ...ROOTS, ttlMs: 0 });

    await resolver.resolve('a.ts');
    const afterFirst = fs.readDirCalls;
    await resolver.resolve('a.ts');

    expect(fs.readDirCalls).toBeGreaterThan(afterFirst);
  });

  it('does not re-walk while the index is still fresh', async () => {
    const fs = fakeVfs(['/workspace/a.ts', '/workspace/b.ts']);
    const resolver = new FileMentionResolver(fs, { ...ROOTS, ttlMs: 60_000 });

    await resolver.resolve('a.ts');
    const afterFirst = fs.readDirCalls;
    await resolver.resolve('b.ts');

    expect(fs.readDirCalls).toBe(afterFirst);
  });

  it('survives a root that does not exist', async () => {
    const fs = fakeVfs(['/workspace/a.ts']);
    const resolver = new FileMentionResolver(fs, { roots: ['/nope', '/workspace'] });
    expect((await resolver.resolve('a.ts')).matches).toEqual(['/workspace/a.ts']);
  });

  it('reports no matches rather than throwing when the VFS fails', async () => {
    const broken: LocalVfsClient = {
      readDir: () => Promise.reject(new Error('boom')),
      readFile: () => Promise.reject(new Error('boom')),
      stat: () => Promise.reject(new Error('boom')),
    };
    const resolver = new FileMentionResolver(broken, ROOTS);
    expect((await resolver.resolve('a.ts')).matches).toEqual([]);
  });
});

describe('FileMentionResolver with tool-call hints', () => {
  it('resolves a file outside the indexed roots when a tool call named it', async () => {
    // `echo test > /home/lars/foo.md` — the file is real but no walk will ever
    // reach it, so the hint is the only way this mention becomes a link.
    const fs = fakeVfs(['/home/lars/foo.md', '/workspace/other.ts']);
    const resolver = new FileMentionResolver(fs, ROOTS);

    expect((await resolver.resolve('foo.md')).matches).toEqual([]);
    expect((await resolver.resolve('foo.md', ['/home/lars/foo.md'])).matches).toEqual([
      '/home/lars/foo.md',
    ]);
  });

  it('ignores a hint that does not exist', async () => {
    const fs = fakeVfs(['/workspace/a.ts']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    expect((await resolver.resolve('gone.md', ['/home/lars/gone.md'])).matches).toEqual([]);
  });

  it('ignores a hint for a different file', async () => {
    const fs = fakeVfs(['/home/lars/foo.md', '/home/lars/bar.md']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    expect((await resolver.resolve('foo.md', ['/home/lars/bar.md'])).matches).toEqual([]);
  });

  it('promotes the hinted match of an ambiguous basename', async () => {
    const fs = fakeVfs([
      '/workspace/a/main.ts',
      '/workspace/b/main.ts',
      '/workspace/c/deep/main.ts',
    ]);
    const resolver = new FileMentionResolver(fs, ROOTS);

    const unhinted = (await resolver.resolve('main.ts')).matches;
    expect(unhinted[0]).toBe('/workspace/a/main.ts');

    const hinted = (await resolver.resolve('main.ts', ['/workspace/b/main.ts'])).matches;
    expect(hinted[0]).toBe('/workspace/b/main.ts');
    // Nothing is dropped — the mention is still ambiguous, and the caller shows
    // the alternatives.
    expect([...hinted].sort()).toEqual([...unhinted].sort());
  });

  it('lets the most recent hint win when a turn touched the name twice', async () => {
    const fs = fakeVfs(['/workspace/a/main.ts', '/workspace/b/main.ts']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    const hints = ['/workspace/a/main.ts', '/workspace/b/main.ts'];
    expect((await resolver.resolve('main.ts', hints)).matches[0]).toBe('/workspace/b/main.ts');
  });

  it('accepts a partial-path mention against a hint', async () => {
    const fs = fakeVfs(['/home/lars/docs/notes.md']);
    const resolver = new FileMentionResolver(fs, ROOTS);
    expect((await resolver.resolve('docs/notes.md', ['/home/lars/docs/notes.md'])).matches).toEqual(
      ['/home/lars/docs/notes.md']
    );
  });

  it('leaves the hint-free answer memoized and unpolluted', async () => {
    const fs = fakeVfs(['/home/lars/foo.md']);
    const resolver = new FileMentionResolver(fs, ROOTS);

    await resolver.resolve('foo.md', ['/home/lars/foo.md']);
    // A later mention with no hints must not inherit the hinted answer: the
    // file is still outside the roots and still unresolvable on its own.
    expect((await resolver.resolve('foo.md')).matches).toEqual([]);
  });

  it('bounds how many hints one mention can check', async () => {
    const files = Array.from({ length: 12 }, (_, i) => `/home/lars/d${i}/foo.md`);
    const fs = fakeVfs(files);
    const resolver = new FileMentionResolver(fs, ROOTS);
    const matches = (await resolver.resolve('foo.md', files)).matches;
    expect(matches.length).toBeLessThanOrEqual(4);
  });
});
