// The CDP virtual-network loader runtime. This is the code that runs inside an
// Electron app which denies the renderer *all* network egress (Signal), so it
// cannot be exercised against a real server — but it can be exercised against a
// real frame: every test here boots the loader into a disposable same-origin
// `<iframe>` whose "network" is a fake controller relay answering from an
// in-memory asset table. That covers the parts that used to be validated only
// by hand: request/response correlation, the WebSocket shim, body encoding, and
// the blob + import-map bootstrap.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assetKey } from '../src/tunnel/asset-graph.js';
import {
  TUNNEL_CONFIG_GLOBAL,
  TUNNEL_FRAME_REGISTER_GLOBAL,
  TUNNEL_SEND_GLOBAL,
  type TunnelRequest,
  type TunnelResponse,
} from '../src/tunnel/tunnel-protocol.js';
import {
  ambientTunnelEnv,
  base64ToBytes,
  boot,
  bytesToBase64,
  makeTunneledFetch,
  makeTunneledWebSocket,
  type TopRelay,
  TunnelClient,
  virtualizeLocation,
} from '../src/tunnel/tunnel-runtime.js';

const HOSTED_ORIGIN = 'https://hosted.test';

function encode(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}
function decode(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}

/** A controller stub: collects what the frame sent and lets a test answer. */
function fakeController(): {
  sent: TunnelRequest[];
  send: (json: string) => void;
  answer: (res: TunnelResponse) => void;
  deliver: ((json: string) => void) | null;
} {
  const ctl = {
    sent: [] as TunnelRequest[],
    send: (json: string) => {
      ctl.sent.push(JSON.parse(json) as TunnelRequest);
    },
    answer: (res: TunnelResponse) => {
      ctl.deliver?.(JSON.stringify(res));
    },
    deliver: null as ((json: string) => void) | null,
  };
  return ctl;
}

describe('base64 helpers', () => {
  it('round-trip arbitrary bytes, including the high range and empty input', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
  });

  it('round-trips non-ASCII text through the UTF-8 encoder', () => {
    const text = 'sliccy 🍦 — überraschung';
    expect(decode(encode(text))).toBe(text);
  });
});

describe('TunnelClient', () => {
  it('correlates concurrent fetches by id and resolves each with its own body', async () => {
    const ctl = fakeController();
    const client = new TunnelClient(ctl.send);
    ctl.deliver = (json) => {
      client.deliver(json);
    };

    const first = client.fetch(`${HOSTED_ORIGIN}/a`, 'GET', {}, null);
    const second = client.fetch(`${HOSTED_ORIGIN}/b`, 'GET', {}, null);
    expect(ctl.sent.map((r) => (r.op === 'fetch' ? r.url : r.op))).toEqual([
      `${HOSTED_ORIGIN}/a`,
      `${HOSTED_ORIGIN}/b`,
    ]);
    const [idA, idB] = ctl.sent.map((r) => r.id);

    // Answer out of order — the ids, not the arrival order, decide.
    ctl.answer({ op: 'fetch-res', id: idB!, status: 200, headers: {}, bodyB64: encode('B') });
    ctl.answer({ op: 'fetch-res', id: idA!, status: 200, headers: {}, bodyB64: encode('A') });

    expect(new TextDecoder().decode((await first).body)).toBe('A');
    expect(new TextDecoder().decode((await second).body)).toBe('B');
  });

  it('base64-encodes the request body and passes method + headers through', async () => {
    const ctl = fakeController();
    const client = new TunnelClient(ctl.send);
    ctl.deliver = (json) => {
      client.deliver(json);
    };
    const pending = client.fetch(
      `${HOSTED_ORIGIN}/post`,
      'POST',
      { 'content-type': 'text/plain' },
      new TextEncoder().encode('payload')
    );
    const req = ctl.sent[0];
    expect(req?.op).toBe('fetch');
    if (req?.op !== 'fetch') throw new Error('unreachable');
    expect(req.method).toBe('POST');
    expect(req.headers).toEqual({ 'content-type': 'text/plain' });
    expect(decode(req.bodyB64 ?? '')).toBe('payload');
    ctl.answer({ op: 'fetch-res', id: req.id, status: 200, headers: {}, bodyB64: '' });
    await pending;
  });

  it('rejects on fetch-err and on a nonsense response op', async () => {
    const ctl = fakeController();
    const client = new TunnelClient(ctl.send);
    ctl.deliver = (json) => {
      client.deliver(json);
    };

    const failing = client.fetch(`${HOSTED_ORIGIN}/x`, 'GET', {}, null);
    ctl.answer({ op: 'fetch-err', id: ctl.sent[0]!.id, message: 'ERR_ACCESS_DENIED' });
    await expect(failing).rejects.toThrow('ERR_ACCESS_DENIED');

    const confused = client.fetch(`${HOSTED_ORIGIN}/y`, 'GET', {}, null);
    // A mis-routed frame carrying a pending fetch's id fails that fetch rather
    // than leaving it pending forever (which would hang the boot silently).
    ctl.answer({ op: 'ws-msg', id: ctl.sent[1]!.id, dataB64: '', binary: false });
    await expect(confused).rejects.toThrow('unexpected tunnel response');
  });

  it('ignores malformed json and messages for unknown ids', () => {
    const ctl = fakeController();
    const client = new TunnelClient(ctl.send);
    expect(() => {
      client.deliver('}{ not json');
    }).not.toThrow();
    expect(() => {
      client.deliver(
        JSON.stringify({ op: 'fetch-res', id: 999, status: 200, headers: {}, bodyB64: '' })
      );
    }).not.toThrow();
    expect(() => {
      client.deliver(JSON.stringify({ op: 'ws-msg', id: 999, dataB64: '', binary: false }));
    }).not.toThrow();
  });

  it('delivers a fetch response only once', async () => {
    const ctl = fakeController();
    const client = new TunnelClient(ctl.send);
    ctl.deliver = (json) => {
      client.deliver(json);
    };
    const pending = client.fetch(`${HOSTED_ORIGIN}/once`, 'GET', {}, null);
    const id = ctl.sent[0]!.id;
    ctl.answer({ op: 'fetch-res', id, status: 200, headers: {}, bodyB64: encode('first') });
    expect(new TextDecoder().decode((await pending).body)).toBe('first');
    // A duplicate (or late retry) answer for a settled id is dropped.
    expect(() => {
      ctl.answer({ op: 'fetch-res', id, status: 500, headers: {}, bodyB64: encode('second') });
    }).not.toThrow();
  });
});

describe('tunnelled fetch', () => {
  function harness(): {
    ctl: ReturnType<typeof fakeController>;
    tunneled: typeof fetch;
    realFetch: ReturnType<typeof vi.fn>;
    nextRequest: () => Promise<TunnelRequest>;
    respond: (
      res: Omit<Extract<TunnelResponse, { op: 'fetch-res' }>, 'id' | 'op'>
    ) => Promise<void>;
    fail: (message: string) => Promise<void>;
  } {
    const ctl = fakeController();
    const client = new TunnelClient(ctl.send);
    ctl.deliver = (json) => {
      client.deliver(json);
    };
    const realFetch = vi.fn(async () => new Response('local'));
    // The body is encoded through a `Request` before anything is posted, so a
    // request lands a microtask or two after the call — wait for it rather
    // than assuming a synchronous send.
    const nextRequest = async (): Promise<TunnelRequest> => {
      const seen = ctl.sent.length;
      await vi.waitFor(() => {
        expect(ctl.sent.length).toBeGreaterThan(seen - 1);
        expect(ctl.sent[seen]).toBeDefined();
      });
      return ctl.sent[seen]!;
    };
    return {
      ctl,
      realFetch,
      nextRequest,
      tunneled: makeTunneledFetch(client, HOSTED_ORIGIN, realFetch as unknown as typeof fetch),
      respond: async (res) => {
        const req = await nextRequest();
        ctl.answer({ op: 'fetch-res', id: req.id, ...res });
      },
      fail: async (message: string) => {
        const req = await nextRequest();
        ctl.answer({ op: 'fetch-err', id: req.id, message });
      },
    };
  }

  it('resolves relative urls against the hosted origin', async () => {
    const { tunneled, ctl, respond } = harness();
    const pending = tunneled('/assets/app.js');
    await respond({
      status: 200,
      headers: { 'content-type': 'text/javascript' },
      bodyB64: encode('ok'),
    });
    const res = await pending;
    expect((ctl.sent[0] as Extract<TunnelRequest, { op: 'fetch' }>).url).toBe(
      `${HOSTED_ORIGIN}/assets/app.js`
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript');
    expect(await res.text()).toBe('ok');
  });

  it('keeps blob: and data: URLs on the real fetch', async () => {
    const { tunneled, ctl, realFetch } = harness();
    await tunneled('blob:https://hosted.test/1234');
    await tunneled('data:text/plain,hi');
    expect(realFetch).toHaveBeenCalledTimes(2);
    expect(ctl.sent).toHaveLength(0);
  });

  it('accepts a URL object and a Request as input', async () => {
    const { tunneled, ctl, respond } = harness();
    const byUrl = tunneled(new URL('/from-url.js', HOSTED_ORIGIN));
    await respond({ status: 200, headers: {}, bodyB64: '' });
    await byUrl;
    const byRequest = tunneled(new Request(`${HOSTED_ORIGIN}/from-request.js`));
    await respond({ status: 200, headers: {}, bodyB64: '' });
    await byRequest;
    expect(ctl.sent.map((r) => (r as Extract<TunnelRequest, { op: 'fetch' }>).url)).toEqual([
      `${HOSTED_ORIGIN}/from-url.js`,
      `${HOSTED_ORIGIN}/from-request.js`,
    ]);
  });

  it('forwards the body of a Request passed as input', async () => {
    const { tunneled, ctl, respond } = harness();
    const pending = tunneled(
      new Request(`${HOSTED_ORIGIN}/rpc`, { method: 'POST', body: 'from-the-request' })
    );
    await respond({ status: 200, headers: {}, bodyB64: '' });
    await pending;
    const req = ctl.sent[0] as Extract<TunnelRequest, { op: 'fetch' }>;
    expect(req.method).toBe('POST');
    expect(decode(req.bodyB64 ?? '')).toBe('from-the-request');
  });

  it.each([
    ['string', () => 'hello', 'hello'],
    ['ArrayBuffer', () => new TextEncoder().encode('hello').buffer, 'hello'],
    ['Uint8Array', () => new TextEncoder().encode('hello'), 'hello'],
    ['Blob', () => new Blob(['hello']), 'hello'],
    ['URLSearchParams', () => new URLSearchParams({ q: 'hello' }), 'q=hello'],
  ])('encodes a %s body', async (_label, makeBody, expected) => {
    const { tunneled, ctl, respond } = harness();
    const pending = tunneled(`${HOSTED_ORIGIN}/rpc`, {
      method: 'POST',
      body: makeBody() as BodyInit,
    });
    await respond({ status: 200, headers: {}, bodyB64: '' });
    await pending;
    const req = ctl.sent[0] as Extract<TunnelRequest, { op: 'fetch' }>;
    expect(decode(req.bodyB64 ?? '')).toBe(expected);
  });

  it('sends only the requested slice of a view onto a larger buffer', async () => {
    const { tunneled, ctl, respond } = harness();
    const backing = new TextEncoder().encode('XXXXpayloadXXXX');
    const view = new Uint8Array(backing.buffer, 4, 7);
    const pending = tunneled(`${HOSTED_ORIGIN}/rpc`, { method: 'POST', body: view });
    await respond({ status: 200, headers: {}, bodyB64: '' });
    await pending;
    const req = ctl.sent[0] as Extract<TunnelRequest, { op: 'fetch' }>;
    expect(decode(req.bodyB64 ?? '')).toBe('payload');
  });

  it('sends no body for a bodiless request', async () => {
    const { tunneled, ctl, respond } = harness();
    const pending = tunneled(`${HOSTED_ORIGIN}/get`);
    await respond({ status: 200, headers: {}, bodyB64: '' });
    await pending;
    expect((ctl.sent[0] as Extract<TunnelRequest, { op: 'fetch' }>).bodyB64).toBeNull();
  });

  it.each([204, 205, 304])('builds a bodiless Response for status %i', async (status) => {
    const { tunneled, respond } = harness();
    const pending = tunneled(`${HOSTED_ORIGIN}/assets/cached.js`);
    // The controller relays the upstream status verbatim; a conditional asset
    // request answering 304 must not blow up the loader.
    await respond({ status, headers: {}, bodyB64: '' });
    const res = await pending;
    expect(res.status).toBe(status);
    expect(res.body).toBeNull();
  });

  it('surfaces an out-of-range status as a typed error, not a RangeError', async () => {
    const { tunneled, respond } = harness();
    const pending = tunneled(`${HOSTED_ORIGIN}/broken`);
    await respond({ status: 0, headers: {}, bodyB64: '' });
    await expect(pending).rejects.toThrow(/out-of-range status 0/);
  });

  it('propagates a controller-side failure as a rejected fetch', async () => {
    const { tunneled, fail } = harness();
    const pending = tunneled(`${HOSTED_ORIGIN}/nope`);
    await fail('net::ERR_ACCESS_DENIED');
    await expect(pending).rejects.toThrow('net::ERR_ACCESS_DENIED');
  });

  it('forwards request headers to the controller', async () => {
    const { tunneled, ctl, respond } = harness();
    const pending = tunneled(`${HOSTED_ORIGIN}/api`, {
      headers: { 'X-Slicc-Tray': 'abc', Accept: 'application/json' },
    });
    await respond({ status: 200, headers: {}, bodyB64: '' });
    await pending;
    const req = ctl.sent[0] as Extract<TunnelRequest, { op: 'fetch' }>;
    expect(req.headers['x-slicc-tray']).toBe('abc');
    expect(req.headers.accept).toBe('application/json');
  });
});

describe('tunnelled WebSocket', () => {
  function harness(): {
    ctl: ReturnType<typeof fakeController>;
    Sock: typeof WebSocket;
  } {
    const ctl = fakeController();
    const client = new TunnelClient(ctl.send);
    ctl.deliver = (json) => {
      client.deliver(json);
    };
    return { ctl, Sock: makeTunneledWebSocket(client) };
  }

  it('opens through the tunnel and reports the negotiated protocol', () => {
    const { ctl, Sock } = harness();
    const sock = new Sock(`wss://hosted.test/bridge`, 'slicc-v1');
    expect(ctl.sent[0]).toMatchObject({
      op: 'ws-open',
      url: 'wss://hosted.test/bridge',
      protocols: ['slicc-v1'],
    });
    expect(sock.readyState).toBe(Sock.CONNECTING);

    const onopen = vi.fn();
    sock.onopen = onopen;
    ctl.answer({ op: 'ws-open-ack', id: ctl.sent[0]!.id, protocol: 'slicc-v1' });
    expect(onopen).toHaveBeenCalledTimes(1);
    expect(sock.readyState).toBe(Sock.OPEN);
    expect(sock.protocol).toBe('slicc-v1');
  });

  it('exposes the readyState constants on the instance as well as the class', () => {
    const { Sock } = harness();
    const sock = new Sock('wss://hosted.test/bridge');
    expect([sock.CONNECTING, sock.OPEN, sock.CLOSING, sock.CLOSED]).toEqual([0, 1, 2, 3]);
    expect([Sock.CONNECTING, Sock.OPEN, Sock.CLOSING, Sock.CLOSED]).toEqual([0, 1, 2, 3]);
  });

  it('accepts an array of protocols and no protocol at all', () => {
    const { ctl, Sock } = harness();
    new Sock('wss://hosted.test/a', ['x', 'y']);
    new Sock('wss://hosted.test/b');
    expect(ctl.sent[0]).toMatchObject({ protocols: ['x', 'y'] });
    expect(ctl.sent[1]).toMatchObject({ protocols: [] });
  });

  it('delivers text frames to both onmessage and addEventListener', () => {
    const { ctl, Sock } = harness();
    const sock = new Sock('wss://hosted.test/bridge');
    const id = ctl.sent[0]!.id;
    const viaProp = vi.fn();
    const viaListener = vi.fn();
    sock.onmessage = viaProp;
    sock.addEventListener('message', viaListener);
    ctl.answer({ op: 'ws-msg', id, dataB64: encode('{"hello":1}'), binary: false });
    expect(viaProp).toHaveBeenCalledTimes(1);
    expect(viaListener).toHaveBeenCalledTimes(1);
    expect((viaProp.mock.calls[0]?.[0] as MessageEvent).data).toBe('{"hello":1}');
  });

  it('honors binaryType for binary frames', async () => {
    const { ctl, Sock } = harness();
    const sock = new Sock('wss://hosted.test/bridge');
    const id = ctl.sent[0]!.id;
    const frames: unknown[] = [];
    sock.onmessage = (ev) => frames.push(ev.data);

    ctl.answer({ op: 'ws-msg', id, dataB64: encode('blobby'), binary: true });
    sock.binaryType = 'arraybuffer';
    ctl.answer({ op: 'ws-msg', id, dataB64: encode('buffery'), binary: true });

    expect(frames[0]).toBeInstanceOf(Blob);
    expect(await (frames[0] as Blob).text()).toBe('blobby');
    expect(frames[1]).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(frames[1] as ArrayBuffer)).toBe('buffery');
  });

  it.each([
    ['string', () => 'ping', 'ping', false],
    ['ArrayBuffer', () => new TextEncoder().encode('ping').buffer, 'ping', true],
    ['Uint8Array', () => new TextEncoder().encode('ping'), 'ping', true],
  ])('sends a %s frame', (_label, makeData, expected, binary) => {
    const { ctl, Sock } = harness();
    const sock = new Sock('wss://hosted.test/bridge');
    ctl.answer({ op: 'ws-open-ack', id: ctl.sent[0]!.id, protocol: '' });
    sock.send(makeData() as string | ArrayBuffer);
    const frame = ctl.sent[1] as Extract<TunnelRequest, { op: 'ws-send' }>;
    expect(frame.op).toBe('ws-send');
    expect(frame.binary).toBe(binary);
    expect(decode(frame.dataB64)).toBe(expected);
  });

  it('sends only the requested slice of a view onto a larger buffer', () => {
    const { ctl, Sock } = harness();
    const sock = new Sock('wss://hosted.test/bridge');
    ctl.answer({ op: 'ws-open-ack', id: ctl.sent[0]!.id, protocol: '' });
    const backing = new TextEncoder().encode('XXXXframeXXXX');
    sock.send(new Uint8Array(backing.buffer, 4, 5));
    expect(decode((ctl.sent[1] as Extract<TunnelRequest, { op: 'ws-send' }>).dataB64)).toBe(
      'frame'
    );
  });

  it('sends a Blob frame once its bytes are read', async () => {
    const { ctl, Sock } = harness();
    const sock = new Sock('wss://hosted.test/bridge');
    ctl.answer({ op: 'ws-open-ack', id: ctl.sent[0]!.id, protocol: '' });
    sock.send(new Blob(['blobframe']));
    await vi.waitFor(() => {
      expect(ctl.sent).toHaveLength(2);
    });
    const frame = ctl.sent[1] as Extract<TunnelRequest, { op: 'ws-send' }>;
    expect(frame.binary).toBe(true);
    expect(decode(frame.dataB64)).toBe('blobframe');
  });

  it('fires onclose when the controller acks a locally requested close', () => {
    const { ctl, Sock } = harness();
    const sock = new Sock('wss://hosted.test/bridge');
    const id = ctl.sent[0]!.id;
    ctl.answer({ op: 'ws-open-ack', id, protocol: '' });
    const onclose = vi.fn();
    sock.onclose = onclose;

    sock.close(4000);
    expect(ctl.sent[1]).toMatchObject({ op: 'ws-close', id, code: 4000 });
    expect(sock.readyState).toBe(Sock.CLOSING);

    // The ack must still reach the socket — reconnect logic waits on onclose.
    ctl.answer({ op: 'ws-close', id, code: 4000 });
    expect(onclose).toHaveBeenCalledTimes(1);
    expect((onclose.mock.calls[0]?.[0] as CloseEvent).code).toBe(4000);
    expect(sock.readyState).toBe(Sock.CLOSED);
  });

  it('follows a transport error with a close, so reconnect logic still runs', () => {
    const { ctl, Sock } = harness();
    const sock = new Sock('wss://hosted.test/bridge');
    const id = ctl.sent[0]!.id;
    const events: string[] = [];
    sock.onerror = () => events.push('error');
    sock.onclose = (event) => events.push(`close:${event.code}:${event.wasClean}`);

    ctl.answer({ op: 'ws-err', id, message: 'refused' });

    // A real socket always closes after an error, and the controller sends no
    // further frame for a failed socket — consumers that reconnect from
    // `onclose` (and only log `onerror`) would otherwise wait forever.
    expect(events).toEqual(['error', 'close:1006:false']);
    expect(sock.readyState).toBe(Sock.CLOSED);
  });

  it('fires onclose for a remote close and onerror for a transport error', () => {
    const { ctl, Sock } = harness();
    const remote = new Sock('wss://hosted.test/a');
    const remoteId = ctl.sent[0]!.id;
    const onclose = vi.fn();
    remote.onclose = onclose;
    ctl.answer({ op: 'ws-close', id: remoteId, code: 1006 });
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(remote.readyState).toBe(Sock.CLOSED);

    const failing = new Sock('wss://hosted.test/b');
    const failingId = ctl.sent[1]!.id;
    const onerror = vi.fn();
    failing.onerror = onerror;
    ctl.answer({ op: 'ws-err', id: failingId, message: 'refused' });
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(failing.readyState).toBe(Sock.CLOSED);
  });

  it('drops sends and repeat closes once closing', () => {
    const { ctl, Sock } = harness();
    const sock = new Sock('wss://hosted.test/bridge');
    const id = ctl.sent[0]!.id;
    ctl.answer({ op: 'ws-open-ack', id, protocol: '' });
    sock.close();
    const afterClose = ctl.sent.length;
    sock.send('too late');
    sock.close();
    expect(ctl.sent).toHaveLength(afterClose);
  });

  it('ignores a frame op the shim does not understand', () => {
    const { ctl, Sock } = harness();
    const sock = new Sock('wss://hosted.test/bridge');
    const id = ctl.sent[0]!.id;
    const onmessage = vi.fn();
    const onclose = vi.fn();
    sock.onmessage = onmessage;
    sock.onclose = onclose;
    // A fetch response mis-addressed to a socket id must not be mistaken for a
    // frame (and must not throw inside the relay's delivery callback).
    expect(() => {
      ctl.answer({ op: 'fetch-res', id, status: 200, headers: {}, bodyB64: encode('nope') });
    }).not.toThrow();
    expect(onmessage).not.toHaveBeenCalled();
    expect(onclose).not.toHaveBeenCalled();
    expect(sock.readyState).toBe(Sock.CONNECTING);
  });

  it('stops routing frames to a socket after its terminal event', () => {
    const { ctl, Sock } = harness();
    const sock = new Sock('wss://hosted.test/bridge');
    const id = ctl.sent[0]!.id;
    const onmessage = vi.fn();
    sock.onmessage = onmessage;
    ctl.answer({ op: 'ws-close', id, code: 1000 });
    ctl.answer({ op: 'ws-msg', id, dataB64: encode('ghost'), binary: false });
    expect(onmessage).not.toHaveBeenCalled();
  });
});

describe('ambientTunnelEnv', () => {
  it('defaults to the frame the loader was injected into', () => {
    const env = ambientTunnelEnv();
    expect(env.win).toBe(window);
    expect(env.doc).toBe(document);
    expect(env.top).toBe(window.top);
  });
});

describe('virtualizeLocation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replays the app url query onto the frame history', () => {
    const replaceState = vi.fn();
    const win = { history: { replaceState } } as unknown as Window;
    expect(virtualizeLocation(win, 'https://hosted.test/follower?tray=abc&bridge=1')).toBe(true);
    expect(replaceState).toHaveBeenCalledWith(null, '', '?tray=abc&bridge=1');
  });

  it('does nothing for a query-less or unparseable url', () => {
    const replaceState = vi.fn();
    const win = { history: { replaceState } } as unknown as Window;
    expect(virtualizeLocation(win, 'https://hosted.test/follower')).toBe(false);
    expect(virtualizeLocation(win, 'not a url')).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('warns (and keeps going) when the frame refuses a history state object', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = {
      history: {
        replaceState: () => {
          throw new Error('SecurityError');
        },
      },
    } as unknown as Window;
    expect(virtualizeLocation(win, 'https://hosted.test/follower?tray=abc')).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[slicc-tunnel] could not virtualize location; the app will not see',
      '?tray=abc',
      expect.anything()
    );
  });
});

describe('boot', () => {
  let frame: HTMLIFrameElement;

  beforeEach(async () => {
    frame = document.createElement('iframe');
    frame.srcdoc = '<!doctype html><html><head></head><body></body></html>';
    document.body.appendChild(frame);
    await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
  });

  afterEach(() => {
    frame.remove();
    vi.restoreAllMocks();
  });

  /** Boot into the disposable frame with a controller that answers from a
   *  fixed asset table (the app's index plus its module graph). */
  function bootWith(
    assets: Record<string, string>,
    config: unknown = { appUrl: `${HOSTED_ORIGIN}/follower?tray=abc`, hostedOrigin: HOSTED_ORIGIN }
  ): { done: Promise<void>; requested: string[]; relay: TopRelay } {
    const win = frame.contentWindow as Window & typeof globalThis & Record<string, unknown>;
    if (config !== undefined) win[TUNNEL_CONFIG_GLOBAL] = config;
    const requested: string[] = [];
    let deliver: ((json: string) => void) | null = null;
    const relay: TopRelay = {
      [TUNNEL_SEND_GLOBAL]: (json: string) => {
        const req = JSON.parse(json) as TunnelRequest;
        if (req.op !== 'fetch') return;
        const path = new URL(req.url).pathname + new URL(req.url).search;
        requested.push(path);
        const body = assets[path] ?? assets[new URL(req.url).pathname];
        const res: TunnelResponse =
          body === undefined
            ? { op: 'fetch-err', id: req.id, message: `404 ${path}` }
            : { op: 'fetch-res', id: req.id, status: 200, headers: {}, bodyB64: encode(body) };
        // Answer asynchronously, like a real CDP round trip.
        queueMicrotask(() => deliver?.(JSON.stringify(res)));
      },
      [TUNNEL_FRAME_REGISTER_GLOBAL]: (recv: (json: string) => void) => {
        deliver = recv;
      },
    };
    const done = boot({
      win,
      top: relay,
      doc: frame.contentDocument as Document,
    });
    return { done, requested, relay };
  }

  it('boots the module graph from blob URLs and runs the entry module', async () => {
    const marker = 'spoonTunnelBooted';
    const { done } = bootWith({
      '/follower?tray=abc':
        '<!doctype html><html><head>' +
        '<link rel="modulepreload" href="/assets/dep-1.js">' +
        '<script type="module" src="/assets/entry-1.js"></script>' +
        '</head><body></body></html>',
      '/assets/entry-1.js': `import { mark } from './dep-1.js';\nmark();`,
      '/assets/dep-1.js': `export function mark() { window.${marker} = true; }`,
    });
    await done;

    const doc = frame.contentDocument as Document;
    const importMap = doc.querySelector('script[type="importmap"]');
    expect(importMap).not.toBeNull();
    const imports = (
      JSON.parse(importMap?.textContent ?? '{}') as { imports: Record<string, string> }
    ).imports;
    expect(Object.keys(imports).sort()).toEqual([
      assetKey('/assets/dep-1.js'),
      assetKey('/assets/entry-1.js'),
    ]);
    expect(Object.values(imports).every((u) => u.startsWith('blob:'))).toBe(true);

    const bootScript = doc.querySelector('script[type="module"]:not([src])');
    expect(bootScript?.textContent).toBe(
      `import ${JSON.stringify(assetKey('/assets/entry-1.js'))};`
    );

    // The graph really executes: the entry imported its dep through the map.
    await vi.waitFor(() => {
      expect((frame.contentWindow as unknown as Record<string, unknown>)[marker]).toBe(true);
    });
  });

  it('installs the tunnelled fetch and WebSocket on the frame', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = frame.contentWindow as Window & typeof globalThis;
    const nativeFetch = win.fetch;
    const nativeWs = win.WebSocket;
    const { done } = bootWith({
      '/follower?tray=abc': '<script type="module" src="/assets/entry-1.js"></script>',
      '/assets/entry-1.js': 'export {};',
    });
    await done;
    expect(win.fetch).not.toBe(nativeFetch);
    expect(win.WebSocket).not.toBe(nativeWs);
    // The app's params could NOT be replayed: Chromium refuses a history state
    // object in an `about:srcdoc` document (SecurityError), which is exactly
    // the kind of frame this loader boots in. That must be loud, not silent —
    // a follower booting without its `?tray=` param looks like an auth bug.
    expect(win.location.search).toBe('');
    expect(warn).toHaveBeenCalledWith(
      '[slicc-tunnel] could not virtualize location; the app will not see',
      '?tray=abc',
      expect.anything()
    );
  });

  it('skips modules that fail to fetch instead of aborting the boot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { done } = bootWith({
      '/follower?tray=abc':
        '<link rel="modulepreload" href="/assets/missing-1.js">' +
        '<script type="module" src="/assets/entry-1.js"></script>',
      '/assets/entry-1.js': 'export {};',
    });
    await done;
    const imports = JSON.parse(
      (frame.contentDocument as Document).querySelector('script[type="importmap"]')?.textContent ??
        '{}'
    ) as { imports: Record<string, string> };
    expect(Object.keys(imports.imports)).toEqual([assetKey('/assets/entry-1.js')]);
    expect(warn).toHaveBeenCalledWith(
      '[slicc-tunnel] module fetch failed',
      '/assets/missing-1.js',
      expect.anything()
    );
  });

  it('gives up (loudly) with no config, no relay, or no module entry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const win = frame.contentWindow as Window & typeof globalThis & Record<string, unknown>;
    const doc = frame.contentDocument as Document;

    await boot({ win, top: {}, doc });
    expect(error).toHaveBeenLastCalledWith('[slicc-tunnel] missing config');

    win[TUNNEL_CONFIG_GLOBAL] = {
      appUrl: `${HOSTED_ORIGIN}/follower`,
      hostedOrigin: HOSTED_ORIGIN,
    };
    await boot({ win, top: {}, doc });
    expect(error).toHaveBeenLastCalledWith('[slicc-tunnel] top-frame relay unavailable');
    await boot({ win, top: null, doc });
    expect(error).toHaveBeenLastCalledWith('[slicc-tunnel] top-frame relay unavailable');

    delete win[TUNNEL_CONFIG_GLOBAL];
    const { done } = bootWith({
      '/follower?tray=abc': '<html><body>no modules here</body></html>',
    });
    await done;
    expect(error).toHaveBeenLastCalledWith('[slicc-tunnel] no module entry in app index');
    expect(doc.querySelector('script[type="importmap"]')).toBeNull();
  });
});
