/**
 * Kernel-side Atomics/SAB responder (#2043). Drives it through a fake realm
 * port and inspects the shared window after each round — no `Atomics.wait`
 * here (the writer never blocks), so everything is plain async.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncExecRequest } from '../../../src/kernel/realm/sync-exec-dispatch.js';
import type { SyncFsRequest, SyncFsResult } from '../../../src/kernel/realm/sync-fs-dispatch.js';
import {
  mintSyncFsToken,
  revokeSyncFsToken,
} from '../../../src/kernel/realm/sync-fs-token-registry.js';
import { attachSyncSabResponder } from '../../../src/kernel/realm/sync-sab-responder.js';
import {
  decodeSabResult,
  SAB_HEADER_BYTES,
  SAB_I_CHUNK,
  SAB_I_OFFSET,
  SAB_I_SEQ,
  SAB_I_STATE,
  SAB_I_STATUS,
  SAB_I_TOTAL,
  SAB_STATE_PENDING,
  SAB_STATE_READY,
  SYNC_SAB_NEXT_MSG,
  SYNC_SAB_REQ_MSG,
  sabViews,
} from '../../../src/kernel/realm/sync-sab-wire.js';

const WINDOW = 4096;

function fakePort() {
  const listeners = new Set<(ev: MessageEvent) => void>();
  return {
    addEventListener: (_t: 'message', h: (ev: MessageEvent) => void) => listeners.add(h),
    removeEventListener: (_t: 'message', h: (ev: MessageEvent) => void) => listeners.delete(h),
    /** Realm → host. */
    emit(data: unknown) {
      for (const h of [...listeners]) h({ data } as MessageEvent);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

/** Wait until the responder flips STATE to READY (it runs an async dispatch). */
async function untilReady(header: Int32Array): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (Atomics.load(header, SAB_I_STATE) === SAB_STATE_READY) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('responder never published');
}

function readWindow(sab: SharedArrayBuffer) {
  const { header, window } = sabViews(sab);
  const chunk = Atomics.load(header, SAB_I_CHUNK);
  return {
    seq: Atomics.load(header, SAB_I_SEQ),
    status: Atomics.load(header, SAB_I_STATUS),
    total: Atomics.load(header, SAB_I_TOTAL),
    chunk,
    offset: Atomics.load(header, SAB_I_OFFSET),
    bytes: window.slice(0, chunk),
  };
}

describe('attachSyncSabResponder', () => {
  afterEach(() => vi.useRealTimers());

  it('binds the HOST token, dispatches, and publishes the encoded result', async () => {
    const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + WINDOW);
    const { header } = sabViews(sab);
    const port = fakePort();
    const seen: Array<SyncFsRequest | SyncExecRequest> = [];
    const handle = attachSyncSabResponder(port, sab, 'host-token', {
      dispatch: async (req) => {
        seen.push(req);
        return { ok: true, kind: 'json', json: { isFile: true, isDirectory: false, size: 3 } };
      },
    });
    Atomics.store(header, SAB_I_STATE, SAB_STATE_PENDING);
    // The realm tries to smuggle a token: it must be overwritten by the host's.
    port.emit({ type: SYNC_SAB_REQ_MSG, id: 7, req: { op: 'stat', path: '/f', token: 'forged' } });
    await untilReady(header);
    expect(seen).toEqual([{ op: 'stat', path: '/f', token: 'host-token' }]);
    const w = readWindow(sab);
    expect(w.seq).toBe(7);
    expect(w.offset).toBe(0);
    expect(w.chunk).toBe(w.total);
    expect(decodeSabResult(w.status, w.bytes)).toEqual({
      ok: true,
      kind: 'json',
      json: { isFile: true, isDirectory: false, size: 3 },
    });
    handle.dispose();
    expect(port.listenerCount).toBe(0);
  });

  it('streams a payload larger than the window across sync-sab-next rounds', async () => {
    const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + WINDOW);
    const { header } = sabViews(sab);
    const port = fakePort();
    const big = new Uint8Array(WINDOW * 2 + 5).map((_, i) => i & 0xff);
    attachSyncSabResponder(port, sab, 't', {
      dispatch: async () => ({ ok: true, kind: 'bytes', bytes: big }),
    });
    Atomics.store(header, SAB_I_STATE, SAB_STATE_PENDING);
    port.emit({ type: SYNC_SAB_REQ_MSG, id: 1, req: { op: 'read', path: '/big' } });
    await untilReady(header);
    const out = new Uint8Array(big.byteLength);
    let w = readWindow(sab);
    expect(w.total).toBe(big.byteLength);
    expect(w.chunk).toBe(WINDOW);
    out.set(w.bytes, 0);
    for (const offset of [WINDOW, WINDOW * 2]) {
      Atomics.store(header, SAB_I_STATE, SAB_STATE_PENDING);
      port.emit({ type: SYNC_SAB_NEXT_MSG, id: 1, offset });
      // Continuations are synchronous (no dispatch) — READY immediately.
      w = readWindow(sab);
      expect(Atomics.load(header, SAB_I_STATE)).toBe(SAB_STATE_READY);
      expect(w.offset).toBe(offset);
      out.set(w.bytes, offset);
    }
    expect(w.chunk).toBe(5);
    expect(Buffer.from(out).equals(Buffer.from(big))).toBe(true);

    // Fully drained → a further continuation is unknown → EIO, not a hang.
    Atomics.store(header, SAB_I_STATE, SAB_STATE_PENDING);
    port.emit({ type: SYNC_SAB_NEXT_MSG, id: 1, offset: 0 });
    w = readWindow(sab);
    expect(decodeSabResult(w.status, w.bytes)).toMatchObject({ ok: false, errno: 'EIO' });
  });

  it('turns a throwing or rejecting dispatcher into an EIO result', async () => {
    const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + WINDOW);
    const { header } = sabViews(sab);
    const port = fakePort();
    let mode: 'throw' | 'reject' = 'throw';
    attachSyncSabResponder(port, sab, 't', {
      dispatch: (): Promise<SyncFsResult> => {
        if (mode === 'throw') throw new Error('sync boom');
        return Promise.reject(new Error('async boom'));
      },
    });
    Atomics.store(header, SAB_I_STATE, SAB_STATE_PENDING);
    port.emit({ type: SYNC_SAB_REQ_MSG, id: 1, req: { op: 'read', path: '/x' } });
    await untilReady(header);
    let w = readWindow(sab);
    expect(decodeSabResult(w.status, w.bytes)).toEqual({
      ok: false,
      errno: 'EIO',
      message: 'sync boom',
    });
    mode = 'reject';
    Atomics.store(header, SAB_I_STATE, SAB_STATE_PENDING);
    port.emit({ type: SYNC_SAB_REQ_MSG, id: 2, req: { op: 'read', path: '/x' } });
    await untilReady(header);
    w = readWindow(sab);
    expect(w.seq).toBe(2);
    expect(decodeSabResult(w.status, w.bytes)).toMatchObject({
      errno: 'EIO',
      message: 'async boom',
    });
  });

  it('ignores unrelated port traffic and malformed envelopes', async () => {
    const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + WINDOW);
    const { header } = sabViews(sab);
    const port = fakePort();
    const dispatch = vi.fn(async (): Promise<SyncFsResult> => ({ ok: true, kind: 'void' }));
    attachSyncSabResponder(port, sab, 't', { dispatch });
    port.emit({ type: 'realm-rpc-req', id: 1, channel: 'vfs', op: 'readFile', args: [] });
    port.emit({ type: SYNC_SAB_REQ_MSG, id: 'nope', req: { op: 'read', path: '/x' } });
    port.emit({ type: SYNC_SAB_REQ_MSG, id: 3 });
    await new Promise((r) => setTimeout(r, 5));
    expect(dispatch).not.toHaveBeenCalled();
    expect(Atomics.load(header, SAB_I_STATE)).not.toBe(SAB_STATE_READY);
  });

  it('end-to-end through the real token-scoped dispatcher (ACL via the realm fs)', async () => {
    const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + WINDOW);
    const { header } = sabViews(sab);
    const port = fakePort();
    const files = new Map<string, Uint8Array>([
      ['/workspace/a.txt', new TextEncoder().encode('alpha')],
    ]);
    const fs = {
      resolvePath: (cwd: string, p: string) => (p.startsWith('/') ? p : `${cwd}/${p}`),
      readFileBuffer: async (p: string) => {
        const v = files.get(p);
        if (!v) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        return v;
      },
      writeFile: async (p: string, b: Uint8Array) => {
        files.set(p, b);
      },
      exists: async (p: string) => files.has(p),
    };
    const token = mintSyncFsToken({ fs: fs as never, cwd: '/workspace' });
    const handle = attachSyncSabResponder(port, sab, token);

    Atomics.store(header, SAB_I_STATE, SAB_STATE_PENDING);
    port.emit({ type: SYNC_SAB_REQ_MSG, id: 1, req: { op: 'read', path: 'a.txt' } });
    await untilReady(header);
    let w = readWindow(sab);
    expect(decodeSabResult(w.status, w.bytes)).toEqual({
      ok: true,
      kind: 'bytes',
      bytes: new TextEncoder().encode('alpha'),
    });

    Atomics.store(header, SAB_I_STATE, SAB_STATE_PENDING);
    port.emit({ type: SYNC_SAB_REQ_MSG, id: 2, req: { op: 'read', path: '/workspace/missing' } });
    await untilReady(header);
    w = readWindow(sab);
    expect(decodeSabResult(w.status, w.bytes)).toMatchObject({ ok: false, errno: 'ENOENT' });

    // Revoked token → EACCES, never the ambient VFS.
    revokeSyncFsToken(token);
    Atomics.store(header, SAB_I_STATE, SAB_STATE_PENDING);
    port.emit({ type: SYNC_SAB_REQ_MSG, id: 3, req: { op: 'read', path: 'a.txt' } });
    await untilReady(header);
    w = readWindow(sab);
    expect(decodeSabResult(w.status, w.bytes)).toMatchObject({ ok: false, errno: 'EACCES' });
    handle.dispose();
  });
});
