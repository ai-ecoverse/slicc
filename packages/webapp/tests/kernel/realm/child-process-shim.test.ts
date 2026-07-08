/**
 * Integration tests for the `child_process` realm shim (Batch 4:
 * child_process compat). Exercises `execSync`/`spawnSync`/`exec` through the
 * real `runJsRealm` in-process pipeline, verifying:
 *   - the exec RPC bridge is wired to the realm's `ctx.exec`
 *   - `sync-call-rewrite.ts` makes `execSync`/`spawnSync` behave
 *     synchronously at the entry-code top level
 *   - both the destructured-require and `require('child_process').execSync`
 *     property-access call shapes work
 */

import type { CommandContext } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { makeCtx, runCode } from './cjs-realm-harness.js';

/** A recording `ctx.exec` that echoes back the command/args it received. */
function recordingExec(
  calls: Array<{ cmd: string; args?: string[] }>,
  opts: { failOn?: string } = {}
): CommandContext['exec'] {
  return (async (command: string, execOpts: { args?: string[] } = {}) => {
    calls.push({ cmd: command, args: execOpts.args });
    if (opts.failOn && command === opts.failOn) {
      return { stdout: '', stderr: 'boom', exitCode: 1 };
    }
    const full = execOpts.args ? `${command} ${execOpts.args.join(' ')}` : command;
    return { stdout: `ran:${full}\n`, stderr: '', exitCode: 0 };
  }) as CommandContext['exec'];
}

describe('child_process realm shim (integration)', () => {
  it('execSync returns stdout, awaited transparently via the source rewrite', async () => {
    const calls: Array<{ cmd: string; args?: string[] }> = [];
    const ctx = makeCtx({ exec: recordingExec(calls) });
    const out = await runCode(
      `const { execSync } = require('child_process');
       const result = execSync('echo hello');
       console.log(result.toString().trim());`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('ran:echo hello');
    expect(calls).toEqual([{ cmd: 'echo hello', args: undefined }]);
  });

  it('execSync with { encoding: "utf8" } returns a string, not a Buffer', async () => {
    const ctx = makeCtx({ exec: recordingExec([]) });
    const out = await runCode(
      `const { execSync } = require('child_process');
       const result = execSync('echo hello', { encoding: 'utf8' });
       console.log(typeof result, result.trim());`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('string ran:echo hello');
  });

  it('execSync without encoding returns a Buffer by default', async () => {
    const ctx = makeCtx({ exec: recordingExec([]) });
    const out = await runCode(
      `const { execSync } = require('child_process');
       const result = execSync('echo hello');
       console.log(Buffer.isBuffer(result));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('true');
  });

  it('execSync throws on non-zero exit code', async () => {
    const ctx = makeCtx({ exec: recordingExec([], { failOn: 'false' }) });
    const out = await runCode(
      `const { execSync } = require('child_process');
       try {
         execSync('false');
         console.log('UNEXPECTED');
       } catch (e) {
         console.log('caught', e.status, e.message.split('\\n')[0]);
       }`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('caught 1');
    expect(out.stdout).toContain('Command failed: false');
  });

  it('spawnSync returns { stdout, stderr, status }', async () => {
    const calls: Array<{ cmd: string; args?: string[] }> = [];
    const ctx = makeCtx({ exec: recordingExec(calls) });
    const out = await runCode(
      `const { spawnSync } = require('child_process');
       const result = spawnSync('echo', ['hello']);
       console.log(result.status, result.stdout.toString().trim());`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('0 ran:echo hello');
    expect(calls).toEqual([{ cmd: 'echo', args: ['hello'] }]);
  });

  it('spawnSync with { encoding: "utf8" } returns string output', async () => {
    const ctx = makeCtx({ exec: recordingExec([]) });
    const out = await runCode(
      `const { spawnSync } = require('child_process');
       const result = spawnSync('echo', ['hi'], { encoding: 'utf8' });
       console.log(typeof result.stdout);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('string');
  });

  it('require("child_process").execSync(...) property-access call works', async () => {
    const ctx = makeCtx({ exec: recordingExec([]) });
    const out = await runCode(
      `const result = require('child_process').execSync('echo hi');
       console.log(result.toString().trim());`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('ran:echo hi');
  });

  it('exec (callback-style) reports stdout via the callback', async () => {
    const ctx = makeCtx({ exec: recordingExec([]) });
    const out = await runCode(
      `const { exec } = require('child_process');
       await new Promise((resolve, reject) => {
         exec('echo hi', (err, stdout, stderr) => {
           if (err) return reject(err);
           console.log(stdout.trim());
           resolve();
         });
       });`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('ran:echo hi');
  });

  it('exec without a callback returns a Promise', async () => {
    const ctx = makeCtx({ exec: recordingExec([]) });
    const out = await runCode(
      `const { exec } = require('child_process');
       const result = await exec('echo hi');
       console.log(result.stdout.trim());`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('ran:echo hi');
  });

  it('spawn() with streaming throws a clear unsupported error', async () => {
    const ctx = makeCtx({ exec: recordingExec([]) });
    const out = await runCode(
      `const { spawn } = require('child_process');
       try { spawn('echo', ['hi']); console.log('UNEXPECTED'); }
       catch (e) { console.log(e.message); }`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('not supported');
  });

  it('multiple execSync calls in sequence all resolve correctly', async () => {
    const ctx = makeCtx({ exec: recordingExec([]) });
    const out = await runCode(
      `const { execSync } = require('child_process');
       const a = execSync('echo a', { encoding: 'utf8' });
       const b = execSync('echo b', { encoding: 'utf8' });
       console.log(a.trim(), '|', b.trim());`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('ran:echo a | ran:echo b');
  });
});
