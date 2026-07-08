/**
 * `child_process` realm shim (nodeChildProcess).
 *
 * Two layers of coverage:
 *   - Integration: drives the real `runJsRealm` engine (same as the worker /
 *     iframe floats) through `require('child_process')`, over the RPC-backed
 *     `exec.start` handle wired to a mock `ctx.exec`. Proves the require-system
 *     wiring, the Node exec/execFile callback + promisify conventions, buffered
 *     spawn stdin, and the sync-stub throws end to end.
 *   - Unit: exercises `createNodeChildProcess` directly over a hand-rolled fake
 *     `exec.start` bridge so `kill()`, the argv/shell command shapes, and the
 *     one-shot stream/event semantics are asserted deterministically.
 */

import type { CommandContext } from 'just-bash';
import { describe, expect, it } from 'vitest';
import {
  type CpExecResult,
  createNodeChildProcess,
} from '../../../src/kernel/realm/js-realm-helpers.js';
import { makeCtx, runCode } from './cjs-realm-harness.js';

/** Mock `ctx.exec` covering the handful of commands the realm code drives. */
function makeExecCtx(): CommandContext {
  return makeCtx({
    exec: (async (command: string, opts: { args?: string[]; stdin?: string } = {}) => {
      const args = opts.args ?? [];
      const stdin = opts.stdin ?? '';
      if (command === 'false') return { stdout: '', stderr: 'boom\n', exitCode: 3 };
      if (command === 'cat') return { stdout: stdin, stderr: '', exitCode: 0 };
      if (command === 'echo') return { stdout: `${args.join(' ')}\n`, stderr: '', exitCode: 0 };
      if (command.startsWith('echo '))
        return { stdout: `${command.slice(5)}\n`, stderr: '', exitCode: 0 };
      return { stdout: `ran:${command}`, stderr: '', exitCode: 0 };
    }) as CommandContext['exec'],
  });
}

describe('child_process: require wiring', () => {
  it('require("child_process") imports without throwing and node: alias is identical', async () => {
    const out = await runCode(
      `const a = require('child_process');
       const b = require('node:child_process');
       console.log(typeof a.exec, typeof a.spawn, typeof a.execFile, a === b);`,
      makeExecCtx()
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('not available in the browser');
    expect(out.stdout.trim()).toBe('function function function true');
  });
});

describe('child_process: exec / execFile callbacks', () => {
  it('exec buffers stdout and calls back Node-style on success', async () => {
    const out = await runCode(
      `const cp = require('child_process');
       await new Promise((resolve) => {
         cp.exec('echo hi', (err, stdout, stderr) => {
           console.log(err === null, stdout.trim(), JSON.stringify(stderr));
           resolve();
         });
       });`,
      makeExecCtx()
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('true hi ""');
  });

  it('exec surfaces a non-zero exit as an Error carrying .code (stdout/stderr still passed)', async () => {
    const out = await runCode(
      `const cp = require('child_process');
       await new Promise((resolve) => {
         cp.exec('false', (err, stdout, stderr) => {
           console.log(err ? 'ERR' : 'OK', err && err.code, JSON.stringify(stderr.trim()));
           resolve();
         });
       });`,
      makeExecCtx()
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('ERR 3 "boom"');
  });

  it('execFile runs shell-free (argv form) — args reach the executable verbatim', async () => {
    const out = await runCode(
      `const cp = require('child_process');
       await new Promise((resolve) => {
         cp.execFile('echo', ['a', 'b'], (err, stdout) => {
           console.log(stdout.trim());
           resolve();
         });
       });`,
      makeExecCtx()
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('a b');
  });
});

describe('child_process: promisify', () => {
  it('promisify(exec) resolves { stdout, stderr } and rejects (with stdout/stderr) on non-zero', async () => {
    const out = await runCode(
      `const cp = require('child_process');
       const { promisify } = require('util');
       const execP = promisify(cp.exec);
       const ok = await execP('echo hi');
       console.log('OK', ok.stdout.trim());
       try {
         await execP('false');
         console.log('NO-THROW');
       } catch (e) {
         console.log('REJ', e.code, e.stdout !== undefined, e.stderr.trim());
       }`,
      makeExecCtx()
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('OK hi');
    expect(lines[1]).toBe('REJ 3 true boom');
  });

  it('promisify(execFile) settles for bare-file, options-as-2nd-arg, and reject overloads', async () => {
    // Regression (PR #1402 finding 2): promisify(execFile)('tool') and the
    // options-as-2nd-arg form used to hang because the callback landed in a
    // slot execFileImpl never read.
    const out = await runCode(
      `const cp = require('child_process');
       const { promisify } = require('util');
       const execFileP = promisify(cp.execFile);
       const a = await execFileP('echo');
       const b = await execFileP('echo', { encoding: 'utf8' });
       console.log('OK', typeof a.stdout, typeof b.stdout);
       try { await execFileP('false'); console.log('NO-THROW'); }
       catch (e) { console.log('REJ', e.code); }`,
      makeExecCtx()
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('OK string string');
    expect(lines[1]).toBe('REJ 3');
  });
});

describe('child_process: spawn', () => {
  it('spawn streams a single stdout chunk then fires exit/close', async () => {
    const out = await runCode(
      `const cp = require('child_process');
       const child = cp.spawn('echo', ['hey']);
       let data = '';
       child.stdout.on('data', (d) => { data += d.toString(); });
       await new Promise((resolve) => {
         child.on('close', (code, signal) => {
           console.log(data.trim(), code, signal);
           resolve();
         });
       });`,
      makeExecCtx()
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('hey 0 null');
  });

  it('spawn buffers stdin.write/.end and forwards it to the command', async () => {
    const out = await runCode(
      `const cp = require('child_process');
       const child = cp.spawn('cat');
       child.stdin.write('hello ');
       child.stdin.write('world');
       child.stdin.end();
       let acc = '';
       child.stdout.on('data', (d) => { acc += d.toString(); });
       await new Promise((resolve) => { child.on('close', () => { console.log(acc); resolve(); }); });`,
      makeExecCtx()
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('hello world');
  });

  it('a synchronous kill() before stdin.end() never runs the command', async () => {
    // Regression (PR #1402 finding 1): a kill() fired synchronously after
    // spawn() lands before the deferred stdin.end() launch, so the command
    // must never run and close must report (null, signal).
    const out = await runCode(
      `const cp = require('child_process');
       const child = cp.spawn('echo', ['pwned']);
       const closeP = new Promise((resolve) => child.on('close', (code, signal) => resolve([code, signal])));
       child.kill('SIGKILL');
       let data = '';
       child.stdout.on('data', (d) => { data += d.toString(); });
       const [code, signal] = await closeP;
       console.log(JSON.stringify(data), code, signal, child.killed);`,
      makeExecCtx()
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('"" null SIGKILL true');
  });
});

describe('child_process: sync forms are unavailable', () => {
  it('execSync / spawnSync / execFileSync / fork throw a clear browser-realm error', async () => {
    const out = await runCode(
      `const cp = require('child_process');
       for (const name of ['execSync', 'spawnSync', 'execFileSync', 'fork']) {
         try { cp[name]('x'); console.log(name, 'NO-THROW'); }
         catch (e) { console.log(name, e.message.includes('not available in the browser realm')); }
       }`,
      makeExecCtx()
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('execSync true\nspawnSync true\nexecFileSync true\nfork true');
  });
});

// ---------------------------------------------------------------------------
// Unit layer: a hand-rolled fake `exec.start` bridge so `kill()`, the command
// shapes, and the stream/event semantics are asserted with no RPC timing.
// ---------------------------------------------------------------------------

interface FakeHandle {
  commandOrArgv: string | string[];
  writes: string[];
  killSigs: string[];
  ended: boolean;
  stdin: { write(chunk: string): void; end(): void };
  kill(sig?: string): Promise<boolean>;
  done: Promise<CpExecResult>;
  resolveDone(result: CpExecResult): void;
  rejectDone(error: unknown): void;
}

function makeFakeBridge() {
  let last: FakeHandle | undefined;
  const bridge = {
    start(commandOrArgv: string | string[]): FakeHandle {
      let resolveDone!: (result: CpExecResult) => void;
      let rejectDone!: (error: unknown) => void;
      const done = new Promise<CpExecResult>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      const handle: FakeHandle = {
        commandOrArgv,
        writes: [],
        killSigs: [],
        ended: false,
        stdin: {
          write: (chunk: string) => handle.writes.push(chunk),
          end: () => {
            handle.ended = true;
          },
        },
        kill: async (sig?: string) => {
          handle.killSigs.push(sig ?? 'SIGTERM');
          return true;
        },
        done,
        resolveDone,
        rejectDone,
      };
      last = handle;
      return handle;
    },
    get lastHandle(): FakeHandle {
      if (!last) throw new Error('no handle started yet');
      return last;
    },
  };
  return bridge;
}

describe('child_process unit: command shapes', () => {
  it('spawn uses shell-free argv by default and a joined string when shell:true', () => {
    const bridge = makeFakeBridge();
    const cp = createNodeChildProcess(bridge);
    cp.spawn('echo', ['a', 'b']);
    expect(bridge.lastHandle.commandOrArgv).toEqual(['echo', 'a', 'b']);
    cp.spawn('echo', ['a', 'b'], { shell: true });
    expect(bridge.lastHandle.commandOrArgv).toBe('echo a b');
  });

  it('exec/execFile expose util.promisify.custom', () => {
    const cp = createNodeChildProcess(makeFakeBridge());
    const sym = Symbol.for('nodejs.util.promisify.custom');
    expect(typeof (cp.exec as unknown as Record<symbol, unknown>)[sym]).toBe('function');
    expect(typeof (cp.execFile as unknown as Record<symbol, unknown>)[sym]).toBe('function');
  });

  it('execSync / spawnSync / execFileSync / fork throw', () => {
    const cp = createNodeChildProcess(makeFakeBridge());
    expect(() => cp.execSync('x')).toThrow('not available in the browser realm');
    expect(() => cp.spawnSync('x')).toThrow('not available in the browser realm');
    expect(() => cp.execFileSync('x')).toThrow('not available in the browser realm');
    expect(() => cp.fork('x')).toThrow('not available in the browser realm');
  });
});

describe('child_process unit: streams and events', () => {
  it('spawn emits one Buffer stdout chunk then end, and exit/close with the code', async () => {
    const bridge = makeFakeBridge();
    const cp = createNodeChildProcess(bridge);
    const child = cp.spawn('echo', ['hi']);
    const events: string[] = [];
    child.stdout.on('data', (d) =>
      events.push(`data:${Buffer.isBuffer(d)}:${(d as Buffer).toString()}`)
    );
    child.stdout.on('end', () => events.push('end'));
    const closeP = new Promise<[unknown, unknown]>((resolve) =>
      child.on('close', (code, signal) => resolve([code, signal]))
    );
    // Let the auto-launch microtask end stdin, then resolve the handle.
    await Promise.resolve();
    expect(bridge.lastHandle.ended).toBe(true);
    bridge.lastHandle.resolveDone({ stdout: 'hi\n', stderr: '', exitCode: 0 });
    const [code, signal] = await closeP;
    expect(events).toEqual(['data:true:hi\n', 'end']);
    expect(code).toBe(0);
    expect(signal).toBeNull();
  });

  it('kill() marks killed, forwards the signal, and reports (null, signal)', async () => {
    const bridge = makeFakeBridge();
    const cp = createNodeChildProcess(bridge);
    const child = cp.spawn('sleep', ['10']);
    const closeP = new Promise<[unknown, unknown]>((resolve) =>
      child.on('close', (code, signal) => resolve([code, signal]))
    );
    expect(child.kill('SIGKILL')).toBe(true);
    expect(child.killed).toBe(true);
    expect(bridge.lastHandle.killSigs).toEqual(['SIGKILL']);
    await Promise.resolve();
    bridge.lastHandle.resolveDone({ stdout: '', stderr: '', exitCode: 137 });
    const [code, signal] = await closeP;
    expect(code).toBeNull();
    expect(signal).toBe('SIGKILL');
  });

  it('a rejected handle surfaces an Error on the "error" event', async () => {
    const bridge = makeFakeBridge();
    const cp = createNodeChildProcess(bridge);
    const child = cp.spawn('boom');
    const errP = new Promise<Error>((resolve) => child.on('error', (e) => resolve(e as Error)));
    await Promise.resolve();
    bridge.lastHandle.rejectDone('kaput');
    expect((await errP).message).toBe('kaput');
  });
});

describe('child_process unit: options and overloads', () => {
  it('exec with an options object + encoding:"buffer" yields Buffer stdout', async () => {
    const bridge = makeFakeBridge();
    const cp = createNodeChildProcess(bridge);
    const cbP = new Promise<[Error | null, unknown]>((resolve) => {
      cp.exec('x', { encoding: 'buffer' }, (err, stdout) => resolve([err, stdout]));
    });
    await Promise.resolve();
    bridge.lastHandle.resolveDone({ stdout: 'hi', stderr: '', exitCode: 0 });
    const [err, stdout] = await cbP;
    expect(err).toBeNull();
    expect(Buffer.isBuffer(stdout)).toBe(true);
    expect((stdout as Buffer).toString()).toBe('hi');
  });

  it('execFile accepts (file, cb) and (file, options, cb) overloads', () => {
    const bridge = makeFakeBridge();
    const cp = createNodeChildProcess(bridge);
    cp.execFile('tool', () => {});
    expect(bridge.lastHandle.commandOrArgv).toEqual(['tool']);
    cp.execFile('tool', { encoding: 'utf8' }, () => {});
    expect(bridge.lastHandle.commandOrArgv).toEqual(['tool']);
  });

  it('spawn accepts an options-only second argument', () => {
    const bridge = makeFakeBridge();
    const cp = createNodeChildProcess(bridge);
    cp.spawn('ls', { encoding: 'utf8' });
    expect(bridge.lastHandle.commandOrArgv).toEqual(['ls']);
  });

  it('stdin.write forwards decoded byte chunks and runs the write callback', async () => {
    const bridge = makeFakeBridge();
    const cp = createNodeChildProcess(bridge);
    const child = cp.spawn('cat');
    const wroteP = new Promise<void>((resolve) => {
      child.stdin.write(new TextEncoder().encode('bytes'), resolve);
    });
    await wroteP;
    expect(bridge.lastHandle.writes).toContain('bytes');
  });
});
