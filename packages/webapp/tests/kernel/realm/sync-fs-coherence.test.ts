import type { CommandContext } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { makeCtx, runCode } from './cjs-realm-harness.js';

describe('sync-fs coherence (exec boundary, snapshot path)', () => {
  it('readFileSync after exec sees a file the subprocess wrote (re-snapshot-after)', async () => {
    const ctx = makeCtx({ files: { '/workspace/seed.txt': 'seed' } });
    ctx.exec = (async () => {
      await ctx.fs.writeFile('/workspace/from-exec.txt', 'wrote-in-exec');
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as CommandContext['exec'];

    const out = await runCode(
      `const fs = require('fs');
       const cp = require('child_process');
       // Touch sync-fs so the exec boundary flushes + re-snapshots.
       fs.existsSync('/workspace/seed.txt');
       await new Promise((res, rej) =>
         cp.exec('run-subprocess', (err) => (err ? rej(err) : res()))
       );
       console.log(fs.readFileSync('/workspace/from-exec.txt', 'utf8'));`,
      ctx
    );
    expect(out.stderr).toBe('');
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('wrote-in-exec');
  });

  it('a sync write before exec is visible to the subprocess (flush-before-exec)', async () => {
    const seen: string[] = [];
    const ctx = makeCtx();
    ctx.exec = (async () => {
      seen.push((await ctx.fs.readFile('/workspace/pre.txt')) as string);
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as CommandContext['exec'];

    const out = await runCode(
      `const fs = require('fs');
       const cp = require('child_process');
       fs.writeFileSync('/workspace/pre.txt', 'from-realm');
       await new Promise((res, rej) =>
         cp.exec('run-subprocess', (err) => (err ? rej(err) : res()))
       );`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(seen).toEqual(['from-realm']);
  });
});
