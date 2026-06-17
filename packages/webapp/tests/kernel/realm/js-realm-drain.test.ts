/**
 * Tests for the bounded RPC drain before realm teardown.
 *
 * When user code fires an RPC-backed async operation without
 * awaiting it (e.g. `fs.readFile('/x').then(v => console.log(v))`),
 * the realm must yield enough ticks for the response to land and
 * the `.then` callback to run before `rpc.dispose()` rejects
 * in-flight promises. The drain is skipped on explicit
 * `process.exit()` and bounded so a never-settling promise does not
 * hang teardown.
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

function attachFakeHost(
  host: PortLike,
  opts: { delayMs?: number; hangPaths?: Set<string> } = {}
): void {
  host.addEventListener('message', async (event: MessageEvent) => {
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
      if (opts.hangPaths?.has(path)) {
        // Never respond — the drain ceiling must cut this off.
        return;
      }
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
    // Unknown ops — just echo an error so the realm doesn't hang.
    host.postMessage({
      type: 'realm-rpc-res',
      id: req.id,
      error: `unknown op ${req.channel}.${req.op}`,
    });
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
  opts: { delayMs?: number; hangPaths?: Set<string> } = {}
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

describe('realm RPC drain before teardown', () => {
  it('lets a non-awaited .then on an RPC promise print before teardown', async () => {
    const code = `const fs = require('fs'); fs.readFile('/x').then(v => console.log('then:' + v));`;
    const done = await runRealm(code);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain('then:hello-/x');
  });

  it('bounds the drain so a never-settling promise does not hang teardown', async () => {
    // `.catch(()=>{})` silences the expected disposal rejection so
    // vitest doesn't flag an unhandled rejection.
    const code = `const fs = require('fs'); fs.readFile('/never').then(v => console.log('then:' + v)).catch(()=>{});`;
    const start = Date.now();
    const done = await runRealm(code, { hangPaths: new Set(['/never']) });
    const elapsed = Date.now() - start;
    expect(done.exitCode).toBe(0);
    // The drain ceiling is 50 ticks / 1000 ms; allow generous headroom
    // for test-scheduler jitter.
    expect(elapsed).toBeLessThan(3000);
    expect(done.stdout).not.toContain('then:');
  });

  it('bypasses the drain on explicit process.exit so teardown is immediate', async () => {
    // `.catch(()=>{})` silences the expected disposal rejection.
    // Use a SHORT delay (10 ms) so the pending RPC is still in-flight
    // when process.exit() is called, but it WOULD settle INSIDE the
    // drain window if the drain incorrectly runs. This ensures the test
    // FAILS when the stale `didCallProcessExit` snapshot bug is present:
    // the .then fires because the response arrives during the drain,
    // so `done.stdout` contains 'then:'.
    const code = `const fs = require('fs'); fs.readFile('/x').then(v => console.log('then:' + v)).catch(()=>{}); process.exit(0);`;
    const start = Date.now();
    const done = await runRealm(code, { delayMs: 10 });
    const elapsed = Date.now() - start;
    expect(done.exitCode).toBe(0);
    // With the live-flag bypass, dispose() rejects the pending RPC
    // immediately and the .then never prints.
    expect(done.stdout).not.toContain('then:');
    // Should be well under the drain ceiling because we skipped it
    // entirely; a non-bypassed drain would take at least one tick.
    expect(elapsed).toBeLessThan(50);
  });
});
