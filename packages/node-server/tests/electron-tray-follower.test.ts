import { describe, expect, it } from 'vitest';
import {
  FOLLOWER_RUNTIME_TAG,
  normalizeIceServers,
  TrayFollowerSignaling,
} from '../src/electron-tray-follower.js';

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

  it('throws on a non-OK signalling response', async () => {
    const failing = (async () =>
      new Response('nope', { status: 503, statusText: 'Service Unavailable' })) as typeof fetch;
    const sig = new TrayFollowerSignaling('https://tray.example/join/abc', failing);
    await expect(sig.attach('c', 'r')).rejects.toThrow(/503/);
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
