/**
 * Tests for the Node-like event-loop drain before realm teardown.
 *
 * Real Node keeps the process alive while ref'd handles remain
 * (timers, I/O), not by awaiting the entry script's returned
 * promise. When user code fires RPC-backed I/O without awaiting it
 * (e.g. `fs.readFile('/x').then(v => console.log(v))`) or schedules
 * a timer, the realm must wait for that handle before `realm-done`.
 * `process.exit()` skips the drain. A Promise with no handle
 * (`new Promise(() => {})`) does not keep the realm alive.
 */

import { describe, expect, it } from 'vitest';
import { runJsRealm } from '../../../src/kernel/realm/js-realm-shared.js';
import type { RealmDoneMsg, RealmInitMsg } from '../../../src/kernel/realm/realm-types.js';

interface PortLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
}

function makePortPair(): { realm: PortLike; host: PortLike } {
  const realmListeners = new Set<(event: MessageEvent) => void>();
  const hostListeners = new Set<(event: MessageEvent) => void>();
  const realm: PortLike = {
    postMessage: (msg) => {
      for (const h of [...hostListeners]) h({ data: msg } as MessageEvent);
    },
    addEventListener: (_type, handler) => {
      realmListeners.add(handler);
    },
    removeEventListener: (_type, handler) => {
      realmListeners.delete(handler);
    },
  };
  const host: PortLike = {
    postMessage: (msg) => {
      for (const h of [...realmListeners]) h({ data: msg } as MessageEvent);
    },
    addEventListener: (_type, handler) => {
      hostListeners.add(handler);
    },
    removeEventListener: (_type, handler) => {
      hostListeners.delete(handler);
    },
  };
  return { realm, host };
}

async function handleFakeHostMessage(
  host: PortLike,
  event: MessageEvent,
  opts: { delayMs?: number; flushWrites?: unknown[] }
): Promise<void> {
  const data = event.data as { type?: string };
  if (data?.type !== 'realm-rpc-req') return;
  const req = data as {
    type: 'realm-rpc-req';
    id: number;
    channel: string;
    op: string;
    args: unknown[];
  };
  if (req.channel === 'vfs' && req.op === 'readFile') {
    const path = req.args[0] as string;
    if (opts.delayMs && opts.delayMs > 0) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    host.postMessage({
      type: 'realm-rpc-res',
      id: req.id,
      result: 'hello-' + path,
    });
    return;
  }
  if (req.channel === 'vfs' && req.op === 'snapshot') {
    host.postMessage({
      type: 'realm-rpc-res',
      id: req.id,
      result: { entries: [] },
    });
    return;
  }
  if (req.channel === 'vfs' && req.op === 'flushWrites') {
    opts.flushWrites?.push(req.args[0]);
    host.postMessage({ type: 'realm-rpc-res', id: req.id, result: undefined });
    return;
  }
  if (req.channel === 'module' && req.op === 'buildGraph') {
    // These scripts only `require('fs')` (a builtin the realm shim serves),
    // so the real host would return an empty graph; mirror that here.
    host.postMessage({
      type: 'realm-rpc-res',
      id: req.id,
      result: { files: [], entryMap: {}, edges: {}, errors: {} },
    });
    return;
  }
  // Unknown ops — just echo an error so the realm doesn't hang.
  host.postMessage({
    type: 'realm-rpc-res',
    id: req.id,
    error: `unknown op ${req.channel}.${req.op}`,
  });
}

function attachFakeHost(
  host: PortLike,
  opts: { delayMs?: number; flushWrites?: unknown[] } = {}
): void {
  host.addEventListener('message', (event: MessageEvent) => {
    void handleFakeHostMessage(host, event, opts);
  });
}

function makeInit(code: string): RealmInitMsg {
  return {
    type: 'realm-init',
    kind: 'js',
    code,
    argv: ['node', '-e', code],
    env: {},
    cwd: '/workspace',
    filename: '[eval]',
  };
}

function runRealm(
  code: string,
  opts: { delayMs?: number; flushWrites?: unknown[] } = {}
): Promise<RealmDoneMsg> {
  const { realm, host } = makePortPair();
  attachFakeHost(host, opts);
  const promise = new Promise<RealmDoneMsg>((resolve) => {
    host.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: string };
      if (data?.type === 'realm-done') {
        resolve(data as RealmDoneMsg);
      }
    });
  });
  void runJsRealm(makeInit(code), realm);
  return promise;
}

describe('realm event-loop drain before teardown', () => {
  it('lets a non-awaited .then on an RPC promise print before teardown', async () => {
    const code = `const fs = require('fs'); fs.readFile('/x').then(v => console.log('then:' + v));`;
    const done = await runRealm(code);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain('then:hello-/x');
  });

  it('waits for a delayed RPC .then the way Node waits for I/O handles', async () => {
    const code = `const fs = require('fs'); fs.readFile('/x').then(v => console.log('then:' + v));`;
    const done = await runRealm(code, { delayMs: 40 });
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain('then:hello-/x');
  });

  it('does not keep the realm alive for a Promise with no handle', async () => {
    // Node exits: a pending Promise is not a libuv handle.
    const code = `new Promise(() => {}); console.log('sync');`;
    const start = Date.now();
    const done = await runRealm(code);
    const elapsed = Date.now() - start;
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain('sync');
    expect(elapsed).toBeLessThan(200);
  });

  it('lets a nested setTimeout print before teardown', async () => {
    const code = [
      'setTimeout(() => {',
      '  process.stdout.write("hop1\\n");',
      '  setTimeout(() => process.stdout.write("hop2\\n"), 0);',
      '}, 0);',
    ].join('\n');
    const done = await runRealm(code);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toBe('hop1\nhop2\n');
  });

  it('lets setInterval run until it is cleared', async () => {
    const code = [
      'let n = 0;',
      'const id = setInterval(() => {',
      '  n += 1;',
      '  process.stdout.write("tick" + n + "\\n");',
      '  if (n >= 2) clearInterval(id);',
      '}, 10);',
    ].join('\n');
    const done = await runRealm(code);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toBe('tick1\ntick2\n');
  });

  it('lets an unawaited async main() with a timer print before teardown', async () => {
    const code = [
      'async function main() {',
      '  await new Promise((r) => setTimeout(r, 20));',
      '  console.log("from-main");',
      '}',
      'main();',
    ].join('\n');
    const done = await runRealm(code);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain('from-main');
  });

  it('bypasses the drain on explicit process.exit so teardown is immediate', async () => {
    // `.catch(()=>{})` silences the expected disposal rejection.
    // Use a SHORT delay (10 ms) so the pending RPC is still in-flight
    // when process.exit() is called, but it WOULD settle if the drain
    // incorrectly runs. This ensures the test FAILS when the stale
    // `didCallProcessExit` snapshot bug is present: the .then fires
    // because the response arrives during the drain, so `done.stdout`
    // contains 'then:'.
    const code = `const fs = require('fs'); fs.readFile('/x').then(v => console.log('then:' + v)).catch(()=>{}); process.exit(0);`;
    const start = Date.now();
    const done = await runRealm(code, { delayMs: 10 });
    const elapsed = Date.now() - start;
    expect(done.exitCode).toBe(0);
    // With the live-flag bypass, dispose() rejects the pending RPC
    // immediately and the .then never prints.
    expect(done.stdout).not.toContain('then:');
    expect(elapsed).toBeLessThan(50);
  });

  it('drops pending timers on process.exit the way Node does', async () => {
    const code = `setTimeout(() => console.log('late'), 20); process.exit(0);`;
    const done = await runRealm(code);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).not.toContain('late');
  });

  it('honors process.exit from a delayed timer during the drain', async () => {
    const code = [
      'setTimeout(() => process.exit(7), 15);',
      'setTimeout(() => console.log("late"), 40);',
    ].join('\n');
    const done = await runRealm(code);
    expect(done.exitCode).toBe(7);
    expect(done.stdout).not.toContain('late');
  });

  it('flushes sync-fs mutations made from a delayed callback', async () => {
    const flushWrites: unknown[] = [];
    const code = [
      'const fs = require("fs");',
      'setTimeout(() => fs.writeFileSync("/workspace/delayed.txt", "hi"), 10);',
    ].join('\n');
    const done = await runRealm(code, { flushWrites });
    expect(done.exitCode).toBe(0);
    const created = flushWrites.flatMap((batch) => {
      const b = batch as { created?: { path: string }[] };
      return b.created ?? [];
    });
    expect(created.some((e) => e.path === '/workspace/delayed.txt')).toBe(true);
  });
});
