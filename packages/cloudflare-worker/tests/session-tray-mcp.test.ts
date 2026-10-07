import { describe, expect, it } from 'vitest';
import { SessionTrayDurableObject } from '../src/session-tray.js';
import { createCapabilityToken, type TrayRecord } from '../src/shared.js';
import type { FakeWebSocket } from './fake-do-state.js';
import { createFakeWebSocketPair, FakeDurableObjectState } from './fake-do-state.js';

const HOST = 'https://www.sliccy.ai';
const REDIRECT = 'https://client.example/callback';

interface TestTray {
  durable: SessionTrayDurableObject;
  state: FakeDurableObjectState;
  trayId: string;
}

async function createTestTray(): Promise<TestTray> {
  const state = new FakeDurableObjectState();
  const now = Date.now();
  const durable = new SessionTrayDurableObject(
    state,
    {},
    {
      now: () => now,
      webSocketPairFactory: () => createFakeWebSocketPair(state),
    }
  );
  state.instance = durable;
  const trayId = crypto.randomUUID();
  const controllerToken = createCapabilityToken(trayId);
  await durable.fetch(
    new Request(`${HOST}/internal/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trayId,
        createdAt: new Date(now).toISOString(),
        joinToken: createCapabilityToken(trayId),
        controllerToken,
        webhookToken: createCapabilityToken(trayId),
      }),
    })
  );
  return { durable, state, trayId };
}

async function attachLeader(t: TestTray): Promise<FakeWebSocket> {
  const controllerToken = (await t.state.storage.get<TrayRecord>('tray'))?.controllerToken ?? '';
  const attachRes = await t.durable.fetch(
    new Request(`${HOST}/controller/${controllerToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId: 'leader-1' }),
    })
  );
  const leader = (await attachRes.json()) as { websocket: { url: string } };
  const wsRes = await t.durable.fetch(
    new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } })
  );
  return (wsRes as unknown as { webSocket: FakeWebSocket }).webSocket;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  );
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

interface EdgeResult {
  httpStatus: number;
  status: number;
  headers: Record<string, string>;
  body: string;
}

async function edge(
  durable: SessionTrayDurableObject,
  token: string,
  fields: Record<string, string | boolean>
): Promise<EdgeResult> {
  const response = await durable.fetch(
    new Request('https://internal/internal/mcp/http', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        method: 'GET',
        path: '/mcp',
        search: '',
        body: '',
        contentType: '',
        authorization: '',
        origin: 'https://client.example',
        resourceOrigin: 'https://7f3a9c.sliccy.now',
        tooLarge: false,
        ...fields,
      }),
    })
  );
  const text = await response.text();
  if (response.status === 404) return { httpStatus: 404, status: 404, headers: {}, body: text };
  const envelope = JSON.parse(text) as {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  return {
    httpStatus: response.status,
    status: envelope.status,
    headers: envelope.headers,
    body: envelope.body,
  };
}

function lastMessage(socket: FakeWebSocket): { type: string; [key: string]: unknown } {
  const raw = socket.received[socket.received.length - 1] ?? '{}';
  return JSON.parse(raw) as { type: string };
}

async function waitForMessage(
  socket: FakeWebSocket,
  after: number,
  matches: (message: { type: string; [key: string]: unknown }) => boolean
): Promise<{ type: string; [key: string]: unknown }> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    for (const raw of socket.received.slice(after)) {
      const message = JSON.parse(raw) as { type: string; [key: string]: unknown };
      if (matches(message)) return message;
    }
    await tick();
  }
  throw new Error('timed out waiting for leader message');
}

describe('session tray mcp publication', () => {
  it('mints one URL, requires a bearer, and relays a tool call', async () => {
    const t = await createTestTray();
    const socket = await attachLeader(t);
    socket.send(
      JSON.stringify({
        type: 'mcp.publish',
        requestId: 'pub-1',
        grantGeneration: 1,
        workerBaseUrl: HOST,
      })
    );
    await tick();
    const published = lastMessage(socket);
    expect(published.type).toBe('mcp.published');
    const token = String(published.token);
    expect(String(published.url)).toMatch(/^https:\/\/.+\.sliccy\.now\/mcp$/);
    socket.send(
      JSON.stringify({
        type: 'mcp.publish',
        requestId: 'pub-2',
        grantGeneration: 1,
        workerBaseUrl: HOST,
      })
    );
    await tick();
    expect(lastMessage(socket).token).toBe(token);

    const denied = await edge(t.durable, token, { method: 'POST', path: '/mcp', body: '{}' });
    expect(denied.status).toBe(401);
    expect(denied.headers['www-authenticate']).toContain(
      'resource_metadata="https://7f3a9c.sliccy.now/.well-known/oauth-protected-resource"'
    );
    expect(denied.headers['access-control-allow-origin']).toBe('https://client.example');

    const metadata = await edge(t.durable, token, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource',
    });
    expect(JSON.parse(metadata.body).scopes_supported).toEqual(['mcp']);

    const registered = await edge(t.durable, token, {
      method: 'POST',
      path: '/oauth/register',
      contentType: 'application/json',
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(registered.status).toBe(201);
    const clientId = JSON.parse(registered.body).client_id as string;
    const verifier = `v${'a'.repeat(42)}`;
    const pendingAuth = edge(t.durable, token, {
      method: 'GET',
      path: '/oauth/authorize',
      search: `?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${await s256(verifier)}&code_challenge_method=S256&state=st&scope=mcp`,
    });
    await tick();
    const challenge = lastMessage(socket);
    expect(challenge.type).toBe('mcp.request');
    expect(challenge.op).toBe('consent');
    socket.send(
      JSON.stringify({
        type: 'mcp.response',
        reqId: challenge.reqId,
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<form>accept</form>',
      })
    );
    const consent = await pendingAuth;
    expect(consent.status).toBe(200);
    expect(consent.body).toContain('accept');
    const pendingId = JSON.parse(String(challenge.body)).pendingId as string;
    const decision = await edge(t.durable, token, {
      method: 'POST',
      path: '/oauth/decision',
      contentType: 'application/x-www-form-urlencoded',
      body: `pending=${pendingId}&generation=1&decision=accept`,
    });
    expect(decision.status).toBe(302);
    const code = new URL(decision.headers.location ?? '').searchParams.get('code') ?? '';
    const tokenRes = await edge(t.durable, token, {
      method: 'POST',
      path: '/oauth/token',
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    const access = JSON.parse(tokenRes.body).access_token as string;
    const beforeCall = socket.received.length;
    const pendingCall = edge(t.durable, token, {
      method: 'POST',
      path: '/mcp',
      contentType: 'application/json',
      authorization: `Bearer ${access}`,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    const call = await waitForMessage(
      socket,
      beforeCall,
      (message) => message.type === 'mcp.request' && message.op === 'rpc'
    );
    expect(call.type).toBe('mcp.request');
    expect(call.op).toBe('rpc');
    socket.send(
      JSON.stringify({
        type: 'mcp.response',
        reqId: call.reqId,
        status: 200,
        contentType: 'application/json',
        body: '{"jsonrpc":"2.0","id":1,"result":{}}',
      })
    );
    const called = await pendingCall;
    expect(called.status).toBe(200);
    expect(called.body).toContain('"result"');

    socket.send(
      JSON.stringify({
        type: 'mcp.publish',
        requestId: 'pub-3',
        grantGeneration: 2,
        workerBaseUrl: HOST,
      })
    );
    await tick();
    const stale = await edge(t.durable, token, {
      method: 'POST',
      path: '/mcp',
      authorization: `Bearer ${access}`,
      body: '{}',
    });
    expect(stale.status).toBe(401);
    const missing = await edge(t.durable, `${token}nope`, {
      method: 'POST',
      path: '/mcp',
      body: '{}',
    });
    expect(missing.httpStatus).toBe(404);
    expect(missing.body).toContain('NOT_MCP');
  });
});
