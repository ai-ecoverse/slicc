/**
 * Realm-side Atomics/SAB transport (#2043).
 *
 * `Atomics.wait` cannot be serviced from the same thread that blocks on it, so
 * the "kernel" here is a fake port whose `postMessage` answers SYNCHRONOUSLY
 * into the shared window before the realm reaches `Atomics.wait` — which then
 * returns `not-equal` and the transport takes the exact post-wake path it would
 * after a genuine cross-thread notify. The cross-thread shape is covered by
 * `sync-sab-responder.test.ts` (the writer) + the Tier-1 browser harness.
 */
import { describe, expect, it } from 'vitest';
import { createSyncExecXhrBridge } from '../../../src/kernel/realm/sync-exec-xhr-bridge.js';
import type { SyncFsResult } from '../../../src/kernel/realm/sync-fs-dispatch.js';
import {
  createSyncExecSabTransport,
  createSyncFsSabBridge,
  createSyncSabTransport,
} from '../../../src/kernel/realm/sync-sab-bridge.js';
import {
  encodeSabResult,
  SAB_HEADER_BYTES,
  SAB_I_CHUNK,
  SAB_I_OFFSET,
  SAB_I_SEQ,
  SAB_I_STATE,
  SAB_I_STATUS,
  SAB_I_TOTAL,
  SAB_STATE_IDLE,
  SAB_STATE_READY,
  SYNC_SAB_NEXT_MSG,
  SYNC_SAB_REQ_MSG,
  type SyncSabNextMsg,
  type SyncSabReqMsg,
  sabViews,
} from '../../../src/kernel/realm/sync-sab-wire.js';

const WINDOW = 4096;

/** `op` of an fs request body (the exec body has none). */
function opOf(req: unknown): string | undefined {
  return (req as { op?: string }).op;
}

/** A fake kernel: answers each request from `answer`, chunked to the window. */
function fakeKernel(sab: SharedArrayBuffer, answer: (req: SyncSabReqMsg['req']) => SyncFsResult) {
  const { header, window } = sabViews(sab);
  const sent: Array<SyncSabReqMsg | SyncSabNextMsg> = [];
  const pending = new Map<number, { status: number; payload: Uint8Array }>();
  const publish = (id: number, offset: number) => {
    const entry = pending.get(id)!;
    const chunk = Math.min(window.byteLength, entry.payload.byteLength - offset);
    window.set(entry.payload.subarray(offset, offset + chunk));
    Atomics.store(header, SAB_I_STATUS, entry.status);
    Atomics.store(header, SAB_I_TOTAL, entry.payload.byteLength);
    Atomics.store(header, SAB_I_CHUNK, chunk);
    Atomics.store(header, SAB_I_OFFSET, offset);
    Atomics.store(header, SAB_I_SEQ, id);
    Atomics.store(header, SAB_I_STATE, SAB_STATE_READY);
  };
  const port = {
    postMessage(msg: unknown) {
      const m = msg as SyncSabReqMsg | SyncSabNextMsg;
      sent.push(m);
      if (m.type === SYNC_SAB_REQ_MSG) {
        pending.set(m.id, encodeSabResult(answer(m.req)));
        publish(m.id, 0);
      } else if (m.type === SYNC_SAB_NEXT_MSG) {
        publish(m.id, m.offset);
      }
    },
  };
  return { port, sent, header };
}

describe('createSyncSabTransport', () => {
  it('delivers a single-round result and resets STATE to idle', () => {
    const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + WINDOW);
    const k = fakeKernel(sab, () => ({ ok: true, kind: 'json', json: { hello: 'world' } }));
    const t = createSyncSabTransport(sab, k.port);
    expect(t.call({ op: 'stat', path: '/x' }, 1000, 'l')).toEqual({
      ok: true,
      kind: 'json',
      json: { hello: 'world' },
    });
    expect(Atomics.load(k.header, SAB_I_STATE)).toBe(SAB_STATE_IDLE);
    expect(k.sent).toEqual([{ type: SYNC_SAB_REQ_MSG, id: 1, req: { op: 'stat', path: '/x' } }]);
  });

  it('drains a payload larger than the window over multiple rounds, byte-exact', () => {
    const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + WINDOW);
    const big = new Uint8Array(WINDOW * 3 + 17);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
    const k = fakeKernel(sab, () => ({ ok: true, kind: 'bytes', bytes: big }));
    const t = createSyncSabTransport(sab, k.port);
    const res = t.call({ op: 'read', path: '/big' }, 1000, 'l');
    expect(res.ok && res.kind === 'bytes' && res.bytes).toBeTruthy();
    if (res.ok && res.kind === 'bytes') {
      expect(res.bytes.byteLength).toBe(big.byteLength);
      expect(Buffer.from(res.bytes).equals(Buffer.from(big))).toBe(true);
    }
    // 1 req + 3 continuations (4096·3 + 17 bytes → 4 rounds).
    expect(k.sent.map((m) => m.type)).toEqual([
      SYNC_SAB_REQ_MSG,
      SYNC_SAB_NEXT_MSG,
      SYNC_SAB_NEXT_MSG,
      SYNC_SAB_NEXT_MSG,
    ]);
    expect((k.sent[1] as SyncSabNextMsg).offset).toBe(WINDOW);
    expect((k.sent[3] as SyncSabNextMsg).offset).toBe(WINDOW * 3);
  });

  it('increments the serial per call and rejects a chunk for the wrong offset', () => {
    const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + WINDOW);
    const k = fakeKernel(sab, () => ({ ok: true, kind: 'void' }));
    const t = createSyncSabTransport(sab, k.port);
    t.call({ op: 'mkdir', path: '/a' }, 1000, 'l');
    t.call({ op: 'mkdir', path: '/b' }, 1000, 'l');
    expect(k.sent.map((m) => m.id)).toEqual([1, 2]);

    // Torn header: the kernel claims an offset the realm did not ask for.
    const torn = {
      ...k.port,
      postMessage: (m: unknown) => {
        k.port.postMessage(m);
        Atomics.store(k.header, SAB_I_OFFSET, 99);
      },
    };
    const t2 = createSyncSabTransport(sab, torn);
    expect(() => t2.call({ op: 'exists', path: '/x' }, 1000, 'l')).toThrow(
      expect.objectContaining({ code: 'EIO' })
    );
    expect(Atomics.load(k.header, SAB_I_STATE)).toBe(SAB_STATE_IDLE);
  });

  it('times out as ETIMEDOUT when nobody answers (no hang)', () => {
    const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + WINDOW);
    const silent = { postMessage: () => {} };
    let clock = 0;
    const t = createSyncSabTransport(sab, silent, {
      // Simulated clock + wait: each wait "sleeps" the full remaining budget.
      now: () => clock,
      wait: (_a, _i, _v, timeout) => {
        clock += timeout ?? 0;
        return 'timed-out';
      },
    });
    expect(() => t.call({ op: 'read', path: '/never' }, 50, 'sync-sab bridge')).toThrow(
      expect.objectContaining({ code: 'ETIMEDOUT' })
    );
  });

  it('ignores a stale wake-up carrying a previous serial and keeps waiting', () => {
    const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + WINDOW);
    const { header, window } = sabViews(sab);
    let calls = 0;
    const port = {
      postMessage(msg: unknown) {
        const m = msg as SyncSabReqMsg;
        // First: a late chunk for serial 0 (never ours). The transport must
        // re-arm; our fake `wait` then supplies the real answer for `m.id`.
        Atomics.store(header, SAB_I_SEQ, 0);
        Atomics.store(header, SAB_I_STATE, SAB_STATE_READY);
        pendingId = m.id;
      },
    };
    let pendingId = -1;
    const t = createSyncSabTransport(sab, port, {
      wait: () => {
        calls++;
        if (calls === 2) {
          const enc = encodeSabResult({ ok: true, kind: 'json', json: true });
          window.set(enc.payload);
          Atomics.store(header, SAB_I_STATUS, enc.status);
          Atomics.store(header, SAB_I_TOTAL, enc.payload.byteLength);
          Atomics.store(header, SAB_I_CHUNK, enc.payload.byteLength);
          Atomics.store(header, SAB_I_OFFSET, 0);
          Atomics.store(header, SAB_I_SEQ, pendingId);
          Atomics.store(header, SAB_I_STATE, SAB_STATE_READY);
        }
        return 'not-equal';
      },
    });
    expect(t.call({ op: 'exists', path: '/x' }, 1000, 'l')).toEqual({
      ok: true,
      kind: 'json',
      json: true,
    });
    expect(calls).toBe(2);
  });
});

describe('createSyncFsSabBridge — fs surface parity with the XHR bridge', () => {
  function bridgeWith(answer: (req: SyncSabReqMsg['req']) => SyncFsResult) {
    const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + WINDOW);
    const k = fakeKernel(sab, answer);
    return { bridge: createSyncFsSabBridge(createSyncSabTransport(sab, k.port)), k };
  }

  it('maps every op onto the dispatch request shape', () => {
    const { bridge, k } = bridgeWith((req) => {
      switch (opOf(req)) {
        case 'read':
          return { ok: true, kind: 'bytes', bytes: new TextEncoder().encode('hi') };
        case 'stat':
        case 'lstat':
          return { ok: true, kind: 'json', json: { isFile: true, isDirectory: false, size: 2 } };
        case 'readdir':
          return { ok: true, kind: 'json', json: ['a', 'b'] };
        case 'exists':
          return { ok: true, kind: 'json', json: false };
        default:
          return { ok: true, kind: 'void' };
      }
    });
    expect(new TextDecoder().decode(bridge.readFile('/f'))).toBe('hi');
    bridge.writeFile('/f', new Uint8Array([1]));
    expect(bridge.stat('/f')).toEqual({ isFile: true, isDirectory: false, size: 2 });
    expect(bridge.lstat('/f').size).toBe(2);
    expect(bridge.readdir('/d')).toEqual(['a', 'b']);
    expect(bridge.exists('/nope')).toBe(false);
    bridge.mkdir('/d');
    bridge.rm('/d');
    expect(k.sent.map((m) => opOf((m as SyncSabReqMsg).req))).toEqual([
      'read',
      'write',
      'stat',
      'lstat',
      'readdir',
      'exists',
      'mkdir',
      'rm',
    ]);
    expect((k.sent[1] as SyncSabReqMsg).req).toMatchObject({ body: new Uint8Array([1]) });
    // Never a token in the body — the responder binds the host's.
    for (const m of k.sent) expect('token' in (m as SyncSabReqMsg).req).toBe(false);
  });

  it('rethrows a dispatch errno with its code, and EIO on a malformed payload', () => {
    const { bridge } = bridgeWith((req) =>
      opOf(req) === 'read'
        ? { ok: false, errno: 'EACCES', message: 'nope' }
        : { ok: true, kind: 'json', json: { not: 'a stat' } }
    );
    expect(() => bridge.readFile('/secret')).toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect(() => bridge.stat('/x')).toThrow(expect.objectContaining({ code: 'EIO' }));
  });
});

describe('createSyncExecSabTransport — plugs into createSyncExecXhrBridge', () => {
  it('runs a command through the SAB channel with the exec envelope', () => {
    const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + WINDOW);
    const k = fakeKernel(sab, (req) => {
      expect(req).toMatchObject({ channel: 'exec', command: 'echo hi', timeoutMs: 5000 });
      return { ok: true, kind: 'json', json: { stdout: 'hi\n', stderr: '', exitCode: 0 } };
    });
    const transport = createSyncSabTransport(sab, k.port);
    const exec = createSyncExecXhrBridge('unused-token', {
      transport: createSyncExecSabTransport(transport),
    });
    expect(exec.run('echo hi', { timeout: 5000 })).toEqual({
      stdout: 'hi\n',
      stderr: '',
      exitCode: 0,
    });
  });

  it('surfaces ETIMEDOUT from the dispatcher as an errno error', () => {
    const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + WINDOW);
    const k = fakeKernel(sab, () => ({ ok: false, errno: 'ETIMEDOUT', message: 'slow' }));
    const exec = createSyncExecXhrBridge('t', {
      transport: createSyncExecSabTransport(createSyncSabTransport(sab, k.port)),
    });
    expect(() => exec.run('sleep 99')).toThrow(expect.objectContaining({ code: 'ETIMEDOUT' }));
  });
});
