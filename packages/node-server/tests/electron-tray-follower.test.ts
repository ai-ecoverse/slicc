import { describe, expect, it } from 'vitest';
import {
  ChunkReassembler,
  ElectronTrayFollower,
  FOLLOWER_RUNTIME_TAG,
  normalizeIceServers,
  TrayFollowerSignaling,
} from '../src/electron-tray-follower.js';

/** Queue of scripted signalling responses, capturing the URL each hit. */
function scriptedFetch(responses: Array<{ status?: number; body: unknown }>): {
  fetch: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: impl, urls };
}

function makeFollower(fetchImpl: typeof fetch): ElectronTrayFollower {
  return new ElectronTrayFollower({
    joinUrl: 'https://tray.example/join/old',
    browserWsUrl: 'ws://127.0.0.1:9224/devtools/browser/x',
    listTargets: async () => [],
    fetchImpl,
  });
}

const chunk = (chunkId: string, chunkIndex: number, totalChunks: number, chunkData: string) => ({
  type: '__chunk' as const,
  chunkId,
  chunkIndex,
  totalChunks,
  chunkData,
});

describe('normalizeIceServers', () => {
  it('accepts worker `urls` (string or array) with optional TURN creds', () => {
    expect(
      normalizeIceServers([
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: ['turns:turn.example:5349'], username: 'u', credential: 'c' },
      ])
    ).toEqual([
      { urls: 'stun:stun.l.google.com:19302', username: undefined, credential: undefined },
      { urls: ['turns:turn.example:5349'], username: 'u', credential: 'c' },
    ]);
  });

  it('tolerates a singular `url` key and drops malformed entries', () => {
    expect(normalizeIceServers([{ url: 'stun:s' }, { nope: 1 }, null, 'x'])).toEqual([
      { urls: 'stun:s', username: undefined, credential: undefined },
    ]);
  });

  it('returns [] for non-array input', () => {
    expect(normalizeIceServers(undefined)).toEqual([]);
    expect(normalizeIceServers({})).toEqual([]);
  });
});

describe('TrayFollowerSignaling', () => {
  function fakeFetch(capture: Array<{ url: string; body: unknown }>): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      capture.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ role: 'follower', ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  }

  it('posts the attach body (controllerId + runtime) to the join URL', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const sig = new TrayFollowerSignaling('https://tray.example/join/abc', fakeFetch(calls));
    await sig.attach('ctrl-1', FOLLOWER_RUNTIME_TAG);
    expect(calls[0]?.url).toBe('https://tray.example/join/abc');
    expect(calls[0]?.body).toEqual({ controllerId: 'ctrl-1', runtime: 'slicc-electron' });
  });

  it('shapes poll / answer / ice-candidate bodies per the bootstrap protocol', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const sig = new TrayFollowerSignaling('https://tray.example/join/abc', fakeFetch(calls));
    await sig.poll('c', 'b', 3);
    await sig.sendAnswer('c', 'b', 'v=0...');
    await sig.sendIceCandidate('c', 'b', { candidate: 'candidate:1 1 udp ...', sdpMid: '0' });
    expect(calls[0]?.body).toEqual({
      action: 'poll',
      controllerId: 'c',
      bootstrapId: 'b',
      cursor: 3,
    });
    expect(calls[1]?.body).toEqual({
      action: 'answer',
      controllerId: 'c',
      bootstrapId: 'b',
      answer: { type: 'answer', sdp: 'v=0...' },
    });
    expect(calls[2]?.body).toEqual({
      action: 'ice-candidate',
      controllerId: 'c',
      bootstrapId: 'b',
      candidate: { candidate: 'candidate:1 1 udp ...', sdpMid: '0' },
    });
  });

  it('throws on a non-OK poll/answer/ice response', async () => {
    const failing = (async () =>
      new Response('nope', { status: 503, statusText: 'Service Unavailable' })) as typeof fetch;
    const sig = new TrayFollowerSignaling('https://tray.example/join/abc', failing);
    await expect(sig.poll('c', 'b', 0)).rejects.toThrow(/503/);
  });

  it('attach tolerates a non-OK status and returns the decoded body', async () => {
    // The tray signals TRAY_SUPERSEDED with HTTP 409 + a body; attach must
    // decode it rather than throw so the redirect can be followed.
    const failing = (async () =>
      new Response(JSON.stringify({ result: { code: 'TRAY_SUPERSEDED', joinUrl: 'x' } }), {
        status: 409,
      })) as typeof fetch;
    const sig = new TrayFollowerSignaling('https://tray.example/join/abc', failing);
    const { status, body } = await sig.attach('c', 'r');
    expect(status).toBe(409);
    expect((body['result'] as Record<string, unknown>)['code']).toBe('TRAY_SUPERSEDED');
  });
});

describe('ElectronTrayFollower.attachWithRedirects', () => {
  it('follows a TRAY_SUPERSEDED 409 redirect, then attaches to the fresh tray', async () => {
    const { fetch, urls } = scriptedFetch([
      {
        status: 409,
        body: { result: { code: 'TRAY_SUPERSEDED', joinUrl: 'https://tray.example/join/new' } },
      },
      {
        status: 200,
        body: { result: { bootstrap: { bootstrapId: 'bs-1' } }, iceServers: [{ urls: 'stun:s' }] },
      },
    ]);
    const ice = await makeFollower(fetch).attachWithRedirects();
    expect(ice).toEqual([{ urls: 'stun:s', username: undefined, credential: undefined }]);
    expect(urls[1]).toBe('https://tray.example/join/new');
  });

  it('retries a `wait` attach plan until the leader is ready', async () => {
    const { fetch } = scriptedFetch([
      { body: { result: { action: 'wait', code: 'LEADER_NOT_ELECTED', retryAfterMs: 1 } } },
      { body: { result: { action: 'wait', code: 'LEADER_NOT_CONNECTED', retryAfterMs: 1 } } },
      { body: { result: { bootstrap: { bootstrapId: 'bs' } }, iceServers: [] } },
    ]);
    expect(await makeFollower(fetch).attachWithRedirects()).toEqual([]);
  });

  it('gives up (null) on a terminal attach failure', async () => {
    const { fetch } = scriptedFetch([{ status: 403, body: { result: { code: 'FORBIDDEN' } } }]);
    expect(await makeFollower(fetch).attachWithRedirects()).toBeNull();
  });

  it('bounds `wait` retries so a never-ready leader does not loop forever', async () => {
    const { fetch, urls } = scriptedFetch([
      { body: { result: { action: 'wait', code: 'LEADER_NOT_ELECTED', retryAfterMs: 0 } } },
    ]);
    expect(await makeFollower(fetch).attachWithRedirects(4, 3)).toBeNull();
    expect(urls.length).toBe(4); // 3 waits + the over-limit attempt
  });
});

describe('ChunkReassembler', () => {
  it('reassembles frames of one message in index order', () => {
    const r = new ChunkReassembler();
    expect(r.push(chunk('a', 0, 2, 'Hel'))).toBeNull();
    expect(r.push(chunk('a', 1, 2, 'lo'))).toBe('Hello');
  });

  it('handles out-of-order and duplicate frames', () => {
    const r = new ChunkReassembler();
    expect(r.push(chunk('a', 2, 3, 'C'))).toBeNull();
    expect(r.push(chunk('a', 2, 3, 'C'))).toBeNull(); // duplicate
    expect(r.push(chunk('a', 0, 3, 'A'))).toBeNull();
    expect(r.push(chunk('a', 1, 3, 'B'))).toBe('ABC');
  });

  it('keeps concurrent messages separate', () => {
    const r = new ChunkReassembler();
    r.push(chunk('a', 0, 2, 'x'));
    r.push(chunk('b', 0, 2, 'y'));
    expect(r.push(chunk('a', 1, 2, '1'))).toBe('x1');
    expect(r.push(chunk('b', 1, 2, '2'))).toBe('y2');
  });
});

describe('ElectronTrayFollower.dispatchRaw', () => {
  it('reassembles __chunk frames before decoding the leader message', () => {
    const follower = makeFollower((async () => new Response('{}')) as typeof fetch);
    const seen: unknown[] = [];
    follower.dispatchLeaderMessage = (m) => {
      seen.push(m);
    };
    const full = JSON.stringify({
      type: 'cdp.request',
      requestId: 'r1',
      localTargetId: 't1',
      method: 'Runtime.evaluate',
      params: { expression: 'x'.repeat(200) },
    });
    const mid = Math.ceil(full.length / 2);
    follower.dispatchRaw(JSON.stringify(chunk('c', 0, 2, full.slice(0, mid))));
    expect(seen).toEqual([]); // first frame: nothing dispatched yet
    follower.dispatchRaw(JSON.stringify(chunk('c', 1, 2, full.slice(mid))));
    expect(seen).toEqual([JSON.parse(full)]);
  });
});

// The full WebRTC path (werift answerer + tray-control data channel + hello +
// federated-CDP servicing) is covered by the e2e integration test
// (`tests/integration/electron-tray-follower.integration.test.ts`, kept out of
// the default gate) and was live-validated end-to-end against Signal's real CDP.
describe('ElectronTrayFollower module surface', () => {
  it('exposes the tray runtime tag', () => {
    expect(FOLLOWER_RUNTIME_TAG).toBe('slicc-electron');
  });
});
