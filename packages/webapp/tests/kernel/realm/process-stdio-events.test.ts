/**
 * `process.stdout` / `process.stderr` are event emitters, as in Node: tools
 * attach `once('drain')` / `on('error')` to them. Writes never back up in the
 * realm, so no `drain` fires and emscripten's compiler.mjs falls back to its
 * exit timer. The realm also publishes its `process` on `globalThis` (emscripten
 * detects Node through `globalThis.process`).
 */

import { describe, expect, it } from 'vitest';
import { installGlobalProcess } from '../../../src/kernel/realm/realm-node-shims.js';
import { makeCtx, runCode } from './cjs-realm-harness.js';

describe('process stdio streams', () => {
  it("accept listeners (emscripten's drain-then-exit pattern)", async () => {
    const r = await runCode(
      [
        "process.stderr.on('error', () => {});",
        "process.stdout.once('drain', () => process.exit(1));",
        "console.log('flushed');",
        'setTimeout(() => process.exit(3), 10);',
      ].join('\n'),
      makeCtx()
    );
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('flushed');
    expect(r.exitCode).toBe(3);
  });

  it('emit to their own listeners', async () => {
    const r = await runCode(
      "process.stdout.on('custom', (v) => process.stdout.write(`got ${v}\\n`)); process.stdout.emit('custom', 7);",
      makeCtx()
    );
    expect(r.stdout.trim()).toBe('got 7');
  });
});

describe('installGlobalProcess', () => {
  it('publishes the shim where the host has no process, and removes it again', () => {
    const g: { process?: unknown } = {};
    const shim = { versions: { node: '20.0.0' } };
    const restore = installGlobalProcess(g, shim);
    expect(g.process).toBe(shim);
    restore();
    expect('process' in g).toBe(false);
  });

  it('never shadows a real process (the in-process realm under vitest)', () => {
    const real = { versions: { node: '22.0.0' } };
    const g: { process?: unknown } = { process: real };
    installGlobalProcess(g, { versions: { node: '20.0.0' } })();
    expect(g.process).toBe(real);
  });
});
