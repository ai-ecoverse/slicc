/**
 * Tests for the expanded fsBridge surface (Batch 2: async fs/promises operations).
 * Exercises appendFile, cp, rm recursive, mkdir recursive, mkdtemp, rename,
 * access, unlink, copyFile, readdir, and fs.promises self-reference.
 */

import { describe, expect, it } from 'vitest';
import { makeCtx, runCode } from './cjs-realm-harness.js';

describe('fsBridge extended operations', () => {
  it('appendFile creates a file if it does not exist', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const fs = require('fs');
       await fs.appendFile('/workspace/new.txt', 'hello');
       console.log(await fs.readFile('/workspace/new.txt'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('hello');
  });

  it('appendFile appends to existing content', async () => {
    const ctx = makeCtx({ files: { '/workspace/a.txt': 'foo' } });
    const out = await runCode(
      `const fs = require('fs');
       await fs.appendFile('/workspace/a.txt', 'bar');
       console.log(await fs.readFile('/workspace/a.txt'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('foobar');
  });

  it('concurrent fs.promises.appendFile keeps both payloads (issue #3174)', async () => {
    const ctx = makeCtx({ files: { '/workspace/log.txt': '' } });
    const out = await runCode(
      `const fs = require('fs').promises;
       await Promise.all([
         fs.appendFile('/workspace/log.txt', 'A'),
         fs.appendFile('/workspace/log.txt', 'B'),
       ]);
       console.log(await fs.readFile('/workspace/log.txt'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    const body = out.stdout.trim();
    expect(body).toHaveLength(2);
    expect(body).toContain('A');
    expect(body).toContain('B');
  });

  it('concurrent appendFile keeps every payload through the realm bridge', async () => {
    const ctx = makeCtx({ files: { '/workspace/log.txt': 'start\n' } });
    const out = await runCode(
      `const fs = require('fs').promises;
       await Promise.all(
         Array.from({ length: 40 }, (_, i) =>
           fs.appendFile('/workspace/log.txt', String(i) + '\\n')
         )
       );
       console.log(await fs.readFile('/workspace/log.txt'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.trim().split('\n');
    expect(lines[0]).toBe('start');
    expect(
      lines
        .slice(1)
        .map(Number)
        .sort((a, b) => a - b)
    ).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it('mkdir with recursive does not throw on existing dir', async () => {
    const ctx = makeCtx({ files: { '/workspace/dir/a.txt': 'x' } });
    const out = await runCode(
      `const fs = require('fs');
       await fs.mkdir('/workspace/dir', { recursive: true });
       console.log('ok');`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('ok');
  });

  it('rm with recursive removes a file', async () => {
    const ctx = makeCtx({
      files: { '/workspace/file.txt': 'data' },
    });
    const out = await runCode(
      `const fs = require('fs');
       await fs.rm('/workspace/file.txt', { recursive: true });
       console.log(await fs.exists('/workspace/file.txt'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('false');
  });

  it('rm with recursive removes the directory itself, not just its files', async () => {
    const ctx = makeCtx({
      files: { '/workspace/tree/sub/a.txt': 'a', '/workspace/keep.txt': 'k' },
    });
    const out = await runCode(
      `const fs = require('fs');
       await fs.rm('/workspace/tree', { recursive: true });
       console.log(await fs.exists('/workspace/tree'), await fs.exists('/workspace/tree/sub'));
       console.log(JSON.stringify(await fs.readdir('/workspace')));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim().split('\n')).toEqual(['false false', '["keep.txt"]']);
    expect(await ctx.fs.exists('/workspace/tree')).toBe(false);
  });

  it('mkdir creates an empty directory that exists and lists', async () => {
    const ctx = makeCtx({ files: { '/workspace/keep.txt': 'k' } });
    const out = await runCode(
      `const fs = require('fs');
       await fs.mkdir('/workspace/empty');
       console.log(await fs.exists('/workspace/empty'), (await fs.stat('/workspace/empty')).isDirectory);
       console.log(JSON.stringify((await fs.readdir('/workspace')).sort()));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim().split('\n')).toEqual(['true true', '["empty","keep.txt"]']);
  });

  it('rm with force does not throw on missing path', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const fs = require('fs');
       await fs.rm('/workspace/nonexistent', { force: true });
       console.log('ok');`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('ok');
  });

  it('cp copies a single file', async () => {
    const ctx = makeCtx({ files: { '/workspace/src.txt': 'content' } });
    const out = await runCode(
      `const fs = require('fs');
       await fs.cp('/workspace/src.txt', '/workspace/dest.txt');
       console.log(await fs.readFile('/workspace/dest.txt'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('content');
  });

  it('mkdtemp returns a path with the given prefix and a random suffix', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const fs = require('fs');
       const dir = await fs.mkdtemp('/workspace/test-');
       console.log(dir.startsWith('/workspace/test-'));
       console.log(dir.length > '/workspace/test-'.length);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('true');
    expect(lines[1]).toBe('true');
  });

  it('rename moves a file', async () => {
    const ctx = makeCtx({ files: { '/workspace/old.txt': 'data' } });
    const out = await runCode(
      `const fs = require('fs');
       await fs.rename('/workspace/old.txt', '/workspace/new.txt');
       console.log(await fs.exists('/workspace/old.txt'));
       console.log(await fs.readFile('/workspace/new.txt'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('false');
    expect(lines[1]).toBe('data');
  });

  it('access resolves for existing files', async () => {
    const ctx = makeCtx({ files: { '/workspace/a.txt': 'x' } });
    const out = await runCode(
      `const fs = require('fs');
       await fs.access('/workspace/a.txt');
       console.log('ok');`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('ok');
  });

  it('access throws ENOENT for missing files', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const fs = require('fs');
       try { await fs.access('/workspace/missing'); } catch (e) { console.log(e.code); }`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('ENOENT');
  });

  it('unlink removes a file', async () => {
    const ctx = makeCtx({ files: { '/workspace/f.txt': 'bye' } });
    const out = await runCode(
      `const fs = require('fs');
       await fs.unlink('/workspace/f.txt');
       console.log(await fs.exists('/workspace/f.txt'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('false');
  });

  it('copyFile copies file content', async () => {
    const ctx = makeCtx({ files: { '/workspace/orig.txt': 'hello' } });
    const out = await runCode(
      `const fs = require('fs');
       await fs.copyFile('/workspace/orig.txt', '/workspace/copy.txt');
       console.log(await fs.readFile('/workspace/copy.txt'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('hello');
  });

  it('readdir is an alias for readDir', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/dir/a.txt': 'a',
        '/workspace/dir/b.txt': 'b',
      },
    });
    const out = await runCode(
      `const fs = require('fs');
       const entries = await fs.readdir('/workspace/dir');
       console.log(entries.sort().join(','));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('a.txt,b.txt');
  });

  it('fs.promises is a self-reference', async () => {
    const ctx = makeCtx({ files: { '/workspace/x.txt': 'y' } });
    const out = await runCode(
      `const fs = require('fs');
       console.log(fs.promises === fs);
       const content = await fs.promises.readFile('/workspace/x.txt');
       console.log(content);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('true');
    expect(lines[1]).toBe('y');
  });

  it('writeFile accepts Uint8Array data', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const fs = require('fs');
       await fs.writeFile('/workspace/bin.dat', new Uint8Array([72, 105]));
       const content = await fs.readFile('/workspace/bin.dat');
       console.log(content);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('Hi');
  });

  it('readFile with encoding utf8 returns a string', async () => {
    const ctx = makeCtx({ files: { '/workspace/b.txt': 'abc' } });
    const out = await runCode(
      `const fs = require('fs');
       const str = await fs.readFile('/workspace/b.txt', 'utf8');
       console.log(typeof str, str);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('string abc');
  });
});
