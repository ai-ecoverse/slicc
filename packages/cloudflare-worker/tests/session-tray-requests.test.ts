/**
 * Request parsing / wire-shape guards extracted from the tray DO (issue #2674).
 * These are pure, so they are tested directly rather than through a DO harness.
 */

import { describe, expect, it } from 'vitest';
import {
  buildLeaderWebSocketUrl,
  isBootstrapRequest,
  isIceCandidate,
  isSessionDescription,
  joinRequestControllerId,
  readAttachRequest,
  readJoinRequest,
} from '../src/session-tray-requests.js';

function jsonPost(body: unknown, url = 'https://hub.example/join/tok'): [Request, URL] {
  return [
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    new URL(url),
  ];
}

describe('readJoinRequest', () => {
  it('reads controllerId and runtime from the query string on GET', async () => {
    const url = new URL('https://hub.example/join/tok?controllerId=c1&runtime=ios');
    const request = new Request(url.toString());
    expect(await readJoinRequest(request, url)).toEqual({ controllerId: 'c1', runtime: 'ios' });
  });

  it('lets the JSON body override the query string', async () => {
    const url = new URL('https://hub.example/join/tok?controllerId=fromQuery&runtime=web');
    const request = new Request(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId: 'fromBody' }),
    });
    expect(await readJoinRequest(request, url)).toEqual({
      controllerId: 'fromBody',
      runtime: 'web',
    });
  });

  it.each([
    ['poll', { action: 'poll', controllerId: 'c1', bootstrapId: 'b1', cursor: 3 }],
    ['retry', { action: 'retry', controllerId: 'c1', bootstrapId: 'b1', runtime: 'ios' }],
  ])('narrows the %s signaling action', async (_action, body) => {
    const parsed = await readJoinRequest(...jsonPost(body));
    expect(isBootstrapRequest(parsed)).toBe(true);
    expect(parsed).toMatchObject(body);
  });

  it('carries answer and candidate payloads through untouched', async () => {
    const answer = { type: 'answer', sdp: 'v=0' };
    const candidate = { candidate: 'candidate:1 1 udp' };
    expect(await readJoinRequest(...jsonPost({ action: 'answer', answer }))).toMatchObject({
      action: 'answer',
      answer,
    });
    expect(
      await readJoinRequest(...jsonPost({ action: 'ice-candidate', candidate }))
    ).toMatchObject({ action: 'ice-candidate', candidate });
  });

  it('treats an unknown action as a plain attach', async () => {
    const parsed = await readJoinRequest(...jsonPost({ action: 'teleport', controllerId: 'c1' }));
    expect(isBootstrapRequest(parsed)).toBe(false);
    expect(parsed).toEqual({ controllerId: 'c1', runtime: undefined });
  });

  it('ignores non-string fields rather than trusting the wire', async () => {
    const parsed = await readJoinRequest(
      ...jsonPost({ action: 'poll', controllerId: 42, bootstrapId: null, cursor: 'nope' })
    );
    expect(parsed).toMatchObject({
      action: 'poll',
      controllerId: undefined,
      bootstrapId: undefined,
      cursor: undefined,
    });
  });

  it('degrades to the query-only attach for a malformed body', async () => {
    const url = new URL('https://hub.example/join/tok?controllerId=c1');
    const request = new Request(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(await readJoinRequest(request, url)).toEqual({
      controllerId: 'c1',
      runtime: undefined,
    });
  });

  it('ignores a body that is not declared as JSON', async () => {
    const url = new URL('https://hub.example/join/tok');
    const request = new Request(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ action: 'poll', controllerId: 'c1' }),
    });
    expect(await readJoinRequest(request, url)).toEqual({
      controllerId: undefined,
      runtime: undefined,
    });
  });
});

describe('readAttachRequest', () => {
  it('reads the leader key from the query string', async () => {
    const url = new URL('https://hub.example/controller/tok?controllerId=c1&leaderKey=k1');
    expect(await readAttachRequest(new Request(url.toString()), url)).toEqual({
      controllerId: 'c1',
      leaderKey: 'k1',
      runtime: undefined,
    });
  });

  it('prefers body fields but falls back to the query per field', async () => {
    const url = new URL('https://hub.example/controller/tok?controllerId=c1&leaderKey=k1');
    const request = new Request(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaderKey: 'k2', runtime: 'electron' }),
    });
    expect(await readAttachRequest(request, url)).toEqual({
      controllerId: 'c1',
      leaderKey: 'k2',
      runtime: 'electron',
    });
  });

  it('degrades to the query-only attach for a malformed body', async () => {
    const url = new URL('https://hub.example/controller/tok?leaderKey=k1');
    const request = new Request(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(await readAttachRequest(request, url)).toMatchObject({ leaderKey: 'k1' });
  });
});

describe('joinRequestControllerId', () => {
  it('returns the supplied id', () => {
    expect(joinRequestControllerId({ controllerId: 'c1' })).toBe('c1');
  });

  it('mints one when the request did not name a controller', () => {
    const id = joinRequestControllerId({});
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('wire-shape guards', () => {
  it('accepts only a session description of the expected type', () => {
    expect(isSessionDescription({ type: 'answer', sdp: 'v=0' }, 'answer')).toBe(true);
    expect(isSessionDescription({ type: 'offer', sdp: 'v=0' }, 'answer')).toBe(false);
    expect(isSessionDescription(undefined, 'answer')).toBe(false);
    expect(isSessionDescription({ type: 'answer' } as never, 'answer')).toBe(false);
  });

  it('requires a string candidate', () => {
    expect(isIceCandidate({ candidate: 'candidate:1' })).toBe(true);
    expect(isIceCandidate({} as never)).toBe(false);
    expect(isIceCandidate(undefined)).toBe(false);
  });
});

describe('buildLeaderWebSocketUrl', () => {
  it('upgrades https to wss and carries the leader credentials', () => {
    const url = new URL('https://hub.example/controller/tok?ignored=1');
    expect(buildLeaderWebSocketUrl(url, 'c1', 'k1')).toBe(
      'wss://hub.example/controller/tok?controllerId=c1&leaderKey=k1'
    );
  });

  it('uses ws for a plaintext origin', () => {
    const url = new URL('http://localhost:8787/controller/tok');
    expect(buildLeaderWebSocketUrl(url, 'c1', 'k1')).toBe(
      'ws://localhost:8787/controller/tok?controllerId=c1&leaderKey=k1'
    );
  });
});
