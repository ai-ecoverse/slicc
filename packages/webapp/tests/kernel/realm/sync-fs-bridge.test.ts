/**
 * Integration tests for the synchronous `fs` API surface (Batch 3: Sync FS).
 * Exercises readFileSync/writeFileSync/existsSync/mkdirSync/statSync/
 * readdirSync/rmSync through the real `runJsRealm` in-process pipeline,
 * verifying the round-trip through `SyncFsCache` and the post-execution
 * flush back to the real VFS.
 */

import { describe, expect, it } from 'vitest';
import { makeCtx, runCode } from './cjs-realm-harness.js';

describe('sync FS bridge (integration)', () => {
  it('readFileSync reads pre-existing file', async () => {
    const ctx = makeCtx({ files: { '/workspace/hello.txt': 'world' } });
    const out = await runCode(
      `const fs = require('fs');
       console.log(fs.readFileSync('/workspace/hello.txt', 'utf8'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('world');
  });

  it('writeFileSync + readFileSync round-trip', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const fs = require('fs');
       fs.writeFileSync('/workspace/out.txt', 'hello sync');
       console.log(fs.readFileSync('/workspace/out.txt', 'utf8'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('hello sync');
  });

  it('writeFileSync flushes to real VFS after execution', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const fs = require('fs');
       fs.writeFileSync('/workspace/flushed.txt', 'persisted');`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    // After execution, the file should exist in the real VFS
    const content = await ctx.fs.readFile('/workspace/flushed.txt');
    expect(content).toBe('persisted');
  });

  it('existsSync returns true for existing file', async () => {
    const ctx = makeCtx({ files: { '/workspace/exists.txt': 'yes' } });
    const out = await runCode(
      `const fs = require('fs');
       console.log(fs.existsSync('/workspace/exists.txt'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('true');
  });

  it('existsSync returns false for missing file', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const fs = require('fs');
       console.log(fs.existsSync('/workspace/nope.txt'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('false');
  });

  it('mkdirSync + readdirSync', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const fs = require('fs');
       fs.mkdirSync('/workspace/newdir', { recursive: true });
       fs.writeFileSync('/workspace/newdir/a.txt', 'a');
       console.log(JSON.stringify(fs.readdirSync('/workspace/newdir')));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout.trim())).toContain('a.txt');
  });

  it('statSync returns methods isFile/isDirectory', async () => {
    const ctx = makeCtx({ files: { '/workspace/f.txt': 'data' } });
    const out = await runCode(
      `const fs = require('fs');
       const s = fs.statSync('/workspace/f.txt');
       console.log(s.isFile(), s.isDirectory(), s.size);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('true false 4');
  });

  it('rmSync removes a file', async () => {
    const ctx = makeCtx({ files: { '/workspace/del.txt': 'bye' } });
    const out = await runCode(
      `const fs = require('fs');
       fs.rmSync('/workspace/del.txt');
       console.log(fs.existsSync('/workspace/del.txt'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('false');
  });

  it('readFileSync without encoding returns Buffer', async () => {
    const ctx = makeCtx({ files: { '/workspace/bin.dat': 'ABC' } });
    const out = await runCode(
      `const fs = require('fs');
       const buf = fs.readFileSync('/workspace/bin.dat');
       console.log(Buffer.isBuffer(buf), buf.length);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('true 3');
  });

  it('sync and async coexist on same require("fs")', async () => {
    const ctx = makeCtx({ files: { '/workspace/both.txt': 'original' } });
    const out = await runCode(
      `const fs = require('fs');
       const sync = fs.readFileSync('/workspace/both.txt', 'utf8');
       const async_ = await fs.readFile('/workspace/both.txt');
       console.log(sync, async_);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('original original');
  });
});
