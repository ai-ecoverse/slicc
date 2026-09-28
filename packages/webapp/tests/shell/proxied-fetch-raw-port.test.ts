/**
 * The page side of raw mode on the extension float (#3571): the Port client
 * against a scripted service worker, the `raw-fetch-*` panel-RPC handlers
 * the kernel worker drives, and the worker's own client over them.
 */
import {
  base64ToUint8,
  type RawPortRequestMsg,
  type RawPortResponseMsg,
  uint8ToBase64,
} from '@slicc/shared-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setExtensionDelegateId } from '../../src/base/api-endpoint.js';
import {
  createProxiedStreamingFetch,
  getRawFetchCapabilities,
  RawFetchError,
  resetRawFetchCapabilities,
  setChromeExtensionRealm,
} from '../../src/shell/proxied-fetch.js';
import {
  probeRawPort,
  type RawFetchPort,
  rawFetchViaPort,
} from '../../src/shell/proxied-fetch-raw-port.js';
import { buildRawFetchHandlers } from '../../src/ui/panel-rpc/raw-fetch-handlers.js';

const url = 'https://github.com/o/r.git/git-receive-pack';
const settle = () => new Promise((r) => setTimeout(r, 5));

/** A scripted service-worker end of a `fetch-proxy.fetch` Port. */
function fakeSw(script: (sw: FakeSw) => void) {
  const sw = new FakeSw();
  script(sw);
  return sw;
}

class FakeSw {
  received: RawPortRequestMsg[] = [];
  onRequest: ((msg: RawPortRequestMsg) => void) | null = null;
  private listeners: ((m: unknown) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];
  disconnected = false;
  connects = 0;
  port: RawFetchPort = {
    onMessage: { addListener: (fn) => this.listeners.push(fn) },
    onDisconnect: { addListener: (fn) => this.disconnectListeners.push(fn) },
    postMessage: (m) => {
      this.received.push(m as RawPortRequestMsg);
      this.onRequest?.(m as RawPortRequestMsg);
    },
    disconnect: () => {
      this.disconnected = true;
    },
  };
  connect = () => {
    this.connects += 1;
    return this.port;
  };
  post(msg: RawPortResponseMsg): void {
    for (const l of this.listeners) l(msg);
  }
  drop(): void {
    for (const d of this.disconnectListeners) d();
  }
  sent(type: RawPortRequestMsg['type']) {
    return this.received.filter((m) => m.type === type);
  }
}

const head = { status: 200, statusText: 'OK', url, headers: [['x-a', '1']] as [string, string][] };

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<number[]> {
  if (!stream) return [];
  return [...new Uint8Array(await new Response(stream).arrayBuffer())];
}

describe('rawFetchViaPort', () => {
  it('sends the upload only against credits and ends it', async () => {
    const sw = fakeSw(() => {});
    const body = new Uint8Array(300 * 1024).fill(7);
    const pending = rawFetchViaPort(sw.connect, url, {
      method: 'POST',
      headers: [['Content-Type', 'application/octet-stream']],
      body,
    });
    await settle();
    expect(sw.received[0]).toMatchObject({
      type: 'raw-request',
      head: { url, method: 'POST', headers: [['Content-Type', 'application/octet-stream']] },
      hasBody: true,
      bodyLength: 300 * 1024,
      credits: 4,
    });
    expect(sw.sent('raw-body-chunk')).toHaveLength(0);
    sw.post({ type: 'raw-body-credit', chunks: 1 });
    await settle();
    expect(sw.sent('raw-body-chunk')).toHaveLength(1);
    expect(sw.sent('raw-body-end')).toHaveLength(0);
    sw.post({ type: 'raw-body-credit', chunks: 1 });
    await settle();
    const uploaded = sw
      .sent('raw-body-chunk')
      .reduce((n, m) => n + base64ToUint8((m as { dataBase64: string }).dataBase64).byteLength, 0);
    expect(uploaded).toBe(300 * 1024);
    expect(sw.sent('raw-body-end')).toHaveLength(1);
    sw.post({ type: 'raw-response-head', head, hasBody: false });
    const resp = await pending;
    expect(resp).toEqual({ ...head, body: null });
    expect(sw.disconnected).toBe(true);
  });

  it('grants one credit per chunk the caller takes', async () => {
    const sw = fakeSw(() => {});
    const pending = rawFetchViaPort(sw.connect, url);
    sw.post({ type: 'raw-response-head', head, hasBody: true });
    const resp = await pending;
    sw.post({ type: 'raw-response-chunk', dataBase64: uint8ToBase64(new Uint8Array([1, 2])) });
    sw.post({ type: 'raw-response-chunk', dataBase64: uint8ToBase64(new Uint8Array([3])) });
    await settle();
    expect(sw.sent('raw-credit')).toHaveLength(0);
    const reader = resp.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
    expect(sw.sent('raw-credit')).toHaveLength(1);
    expect((await reader.read()).value).toEqual(new Uint8Array([3]));
    sw.post({ type: 'raw-response-end' });
    expect((await reader.read()).done).toBe(true);
    expect(sw.sent('raw-credit')).toHaveLength(2);
    expect(sw.disconnected).toBe(true);
  });

  it('rejects with the service worker error before the head, errors the body after it', async () => {
    const early = fakeSw(() => {});
    const failing = rawFetchViaPort(early.connect, url);
    early.post({ type: 'raw-response-error', code: 'forbidden-secret', status: 403, error: 'no' });
    await expect(failing).rejects.toMatchObject({ code: 'forbidden-secret', status: 403 });
    await expect(failing).rejects.toBeInstanceOf(RawFetchError);

    const late = fakeSw(() => {});
    const pending = rawFetchViaPort(late.connect, url);
    late.post({ type: 'raw-response-head', head, hasBody: true });
    const resp = await pending;
    late.drop();
    await expect(drain(resp.body)).rejects.toMatchObject({ code: 'bridge' });
  });

  it('disconnects on cancel and on abort', async () => {
    const sw = fakeSw(() => {});
    const pending = rawFetchViaPort(sw.connect, url);
    sw.post({ type: 'raw-response-head', head, hasBody: true });
    await (await pending).body!.cancel();
    expect(sw.disconnected).toBe(true);

    const aborted = fakeSw(() => {});
    const controller = new AbortController();
    const waiting = rawFetchViaPort(aborted.connect, url, { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted.disconnected).toBe(true);
    await expect(
      rawFetchViaPort(aborted.connect, url, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted.connects).toBe(1);
  });

  it('cancels a stalled upload source when the session ends', async () => {
    const cancelled = vi.fn();
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel: cancelled,
    });
    const sw = fakeSw((s) => {
      s.onRequest = (m) => {
        if (m.type === 'raw-request') s.post({ type: 'raw-body-credit', chunks: 4 });
      };
    });
    const controller = new AbortController();
    const pending = rawFetchViaPort(sw.connect, url, {
      method: 'POST',
      body: stalled,
      signal: controller.signal,
    });
    await settle();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await settle();
    expect(cancelled).toHaveBeenCalled();
    expect(sw.sent('raw-body-end')).toHaveLength(0);
  });

  it('chunks a streamed upload and passes the caller-known length', async () => {
    const sw = fakeSw((s) => {
      s.onRequest = (m) => {
        if (m.type === 'raw-request') s.post({ type: 'raw-body-credit', chunks: 10 });
        if (m.type === 'raw-body-end') s.post({ type: 'raw-response-head', head, hasBody: false });
      };
    });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.enqueue(new Uint8Array([2, 3]));
        c.close();
      },
    });
    await rawFetchViaPort(sw.connect, url, { method: 'PUT', body: stream, bodyLength: 3 });
    expect(sw.received[0]).toMatchObject({ bodyLength: 3 });
    const bytes = sw
      .sent('raw-body-chunk')
      .flatMap((m) => [...base64ToUint8((m as { dataBase64: string }).dataBase64)]);
    expect(bytes).toEqual([1, 2, 3]);
  });
});

describe('raw-fetch panel-RPC handlers (page side of the kernel worker)', () => {
  afterEach(() => {
    setExtensionDelegateId(null);
    vi.unstubAllGlobals();
  });

  function withSw(script: (sw: FakeSw) => void): FakeSw {
    const sw = fakeSw(script);
    setExtensionDelegateId('ext-id');
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => sw.connect()) } });
    return sw;
  }

  it('opens, uploads with backpressure, reads the head and the body, then forgets the session', async () => {
    const sw = withSw((s) => {
      s.onRequest = (m) => {
        if (m.type === 'raw-request') s.post({ type: 'raw-body-credit', chunks: 1 });
        if (m.type === 'raw-body-chunk') s.post({ type: 'raw-body-credit', chunks: 1 });
        if (m.type === 'raw-body-end') {
          s.post({ type: 'raw-response-head', head, hasBody: true });
          s.post({ type: 'raw-response-chunk', dataBase64: uint8ToBase64(new Uint8Array([5])) });
          s.post({ type: 'raw-response-end' });
        }
      };
    });
    const h = buildRawFetchHandlers();
    const { id } = await h['raw-fetch-open']({
      url,
      method: 'POST',
      headers: [],
      hasBody: true,
    });
    expect(await h['raw-fetch-write']({ id, chunk: new Uint8Array([9, 9]) })).toEqual({ ok: true });
    expect(await h['raw-fetch-write']({ id, chunk: null })).toEqual({ ok: true });
    expect(await h['raw-fetch-head']({ id })).toEqual({ ok: true, head, hasBody: true });
    expect(await h['raw-fetch-read']({ id })).toEqual({ ok: true, chunk: new Uint8Array([5]) });
    expect(await h['raw-fetch-read']({ id })).toEqual({ ok: true, chunk: null });
    expect(await h['raw-fetch-read']({ id })).toMatchObject({ ok: false, code: 'bridge' });
    expect(sw.sent('raw-body-chunk')).toHaveLength(1);
  });

  it('reports a service-worker failure and cancels on request', async () => {
    withSw((s) => {
      s.onRequest = (m) => {
        if (m.type === 'raw-request') {
          s.post({ type: 'raw-response-error', code: 'forbidden-secret', status: 403, error: 'x' });
        }
      };
    });
    const h = buildRawFetchHandlers();
    const failed = await h['raw-fetch-open']({ url, method: 'GET', headers: [], hasBody: false });
    expect(await h['raw-fetch-head']({ id: failed.id })).toEqual({
      ok: false,
      code: 'forbidden-secret',
      status: 403,
      error: 'x',
    });

    const sw = withSw(() => {});
    const open = await h['raw-fetch-open']({ url, method: 'GET', headers: [], hasBody: false });
    expect(await h['raw-fetch-cancel']({ id: open.id })).toEqual({ ok: true });
    expect(sw.disconnected).toBe(true);
    expect(await h['raw-fetch-write']({ id: open.id, chunk: null })).toMatchObject({ ok: false });
  });

  it('probes the extension for the kernel worker', async () => {
    await resetRawFetchCapabilities();
    withSw((s) => {
      s.onRequest = (m) => {
        if (m.type === 'raw-probe') {
          s.post({
            type: 'raw-probe-reply',
            reply: { rawFetch: 1, requestBodyStreaming: false, maxRequestBodyBytes: 7 },
          });
        }
      };
    });
    expect(await buildRawFetchHandlers()['raw-fetch-probe']({})).toEqual({
      supported: true,
      requestBodyStreaming: false,
      maxRequestBodyBytes: 7,
    });
  });

  it('refuses to open without an extension Port', async () => {
    const h = buildRawFetchHandlers();
    await expect(
      h['raw-fetch-open']({ url, method: 'GET', headers: [], hasBody: false })
    ).rejects.toThrow(/no extension Port/);
  });
});

const probeReply = { rawFetch: 1, requestBodyStreaming: true, maxRequestBodyBytes: 256 };
const capabilities = { supported: true, requestBodyStreaming: true, maxRequestBodyBytes: 256 };

describe('probeRawPort', () => {
  it('returns the service worker reply', async () => {
    const sw = fakeSw((s) => {
      s.onRequest = (m) => {
        if (m.type === 'raw-probe') s.post({ type: 'raw-probe-reply', reply: probeReply });
      };
    });
    expect(await probeRawPort(sw.connect, 1000)).toEqual(probeReply);
    expect(sw.disconnected).toBe(true);
  });

  it('reports a service worker without raw mode, and one that stays silent', async () => {
    const refusing = fakeSw((s) => {
      s.onRequest = () =>
        s.post({ type: 'raw-response-error', code: 'unsupported', status: 501, error: 'no' });
    });
    expect(await probeRawPort(refusing.connect, 1000)).toBeNull();
    const silent = fakeSw(() => {});
    expect(await probeRawPort(silent.connect, 20)).toBe('silent');
    expect(silent.disconnected).toBe(true);
  });
});

describe('raw proxied fetch — extension realms', () => {
  beforeEach(async () => {
    await resetRawFetchCapabilities();
  });
  afterEach(() => {
    setChromeExtensionRealm(null);
    setExtensionDelegateId(null);
    vi.unstubAllGlobals();
    vi.doUnmock('../../src/kernel/panel-rpc.js');
  });

  /** An extension page whose service worker answers the probe, then `script`. */
  function extensionPage(script: (sw: FakeSw, m: RawPortRequestMsg) => void) {
    const connect = vi.fn(() =>
      fakeSw((s) => {
        s.onRequest = (m) => {
          if (m.type === 'raw-probe') s.post({ type: 'raw-probe-reply', reply: probeReply });
          else script(s, m);
        };
      }).connect()
    );
    vi.stubGlobal('chrome', { runtime: { connect } });
    setChromeExtensionRealm(true);
    return connect;
  }

  it('reports what the service worker answered, and asks only once', async () => {
    const connect = extensionPage(() => {});
    expect(await getRawFetchCapabilities()).toEqual(capabilities);
    await getRawFetchCapabilities();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('uses the id-less Port on an extension page', async () => {
    const connect = extensionPage((s, m) => {
      if (m.type === 'raw-request') s.post({ type: 'raw-response-head', head, hasBody: false });
    });
    const resp = await createProxiedStreamingFetch({ mode: 'raw' })(url);
    expect(resp.status).toBe(200);
    expect(connect).toHaveBeenCalledWith({ name: 'fetch-proxy.fetch' });
  });

  it('refuses up front when the installed extension predates raw mode', async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    vi.stubGlobal('chrome', {
      runtime: {
        connect: () => {
          const sw = fakeSw(() => {});
          sw.onRequest = (m) => sent.push(m.type);
          return sw.connect();
        },
      },
    });
    setChromeExtensionRealm(true);
    const call = createProxiedStreamingFetch({ mode: 'raw' })(url);
    const failed = expect(call).rejects.toMatchObject({ code: 'unsupported' });
    await vi.advanceTimersByTimeAsync(6000);
    await failed;
    vi.useRealTimers();
    expect(sent).toEqual(['raw-probe']);
  });

  it('drives the page over panel-RPC from the kernel worker', async () => {
    const calls: Array<[string, unknown]> = [];
    const reads = [new Uint8Array([4, 2]), null];
    const client = {
      call: vi.fn(async (op: string, payload: unknown) => {
        calls.push([op, payload]);
        if (op === 'raw-fetch-probe') return capabilities;
        if (op === 'raw-fetch-open') return { id: 's1' };
        if (op === 'raw-fetch-write') return { ok: true };
        if (op === 'raw-fetch-head') return { ok: true, head, hasBody: true };
        if (op === 'raw-fetch-read') return { ok: true, chunk: reads.shift() };
        return { ok: true };
      }),
    };
    vi.doMock('../../src/kernel/panel-rpc.js', () => ({ getPanelRpcClient: () => client }));
    setExtensionDelegateId('ext-id');
    const resp = await createProxiedStreamingFetch({ mode: 'raw' })(url, {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    });
    expect(await drain(resp.body)).toEqual([4, 2]);
    await settle();
    expect(calls[0]).toEqual(['raw-fetch-probe', {}]);
    expect(calls[1]).toEqual([
      'raw-fetch-open',
      { url, method: 'PUT', headers: [], hasBody: true, bodyLength: 3 },
    ]);
    expect(calls.filter(([op]) => op === 'raw-fetch-write').map(([, p]) => p)).toEqual([
      { id: 's1', chunk: new Uint8Array([1, 2, 3]) },
      { id: 's1', chunk: null },
    ]);
  });

  it('refuses from the kernel worker when the page reports no raw mode', async () => {
    const client = {
      call: vi.fn(async (op: string) =>
        op === 'raw-fetch-probe' ? { ...capabilities, supported: false } : { id: 'x' }
      ),
    };
    vi.doMock('../../src/kernel/panel-rpc.js', () => ({ getPanelRpcClient: () => client }));
    setExtensionDelegateId('ext-id');
    await expect(createProxiedStreamingFetch({ mode: 'raw' })(url)).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(client.call).toHaveBeenCalledTimes(1);
  });

  it('turns a panel-RPC failure into a RawFetchError', async () => {
    const client = {
      call: vi.fn(async (op: string) => {
        if (op === 'raw-fetch-probe') return capabilities;
        if (op === 'raw-fetch-open') return { id: 's2' };
        return { ok: false, code: 'upstream', status: 502, error: 'reset' };
      }),
    };
    vi.doMock('../../src/kernel/panel-rpc.js', () => ({ getPanelRpcClient: () => client }));
    setExtensionDelegateId('ext-id');
    await expect(createProxiedStreamingFetch({ mode: 'raw' })(url)).rejects.toMatchObject({
      code: 'upstream',
      status: 502,
    });
  });
});
