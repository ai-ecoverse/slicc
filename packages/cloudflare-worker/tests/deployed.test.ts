import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

interface CreateTrayResponse {
  trayId: string;
  capabilities: {
    join: { url: string };
    controller: { url: string };
    webhook: { url: string };
  };
}

interface ControllerAttachResponse {
  role: string;
  leaderKey?: string;
  websocket?: { url: string } | null;
}

const workerBaseUrl = process.env.WORKER_BASE_URL;
const describeIfConfigured = workerBaseUrl ? describe : describe.skip;

describeIfConfigured('deployed tray worker', () => {
  it('exercises the phase 1 flow against a deployed worker', async () => {
    const baseUrl = new URL(workerBaseUrl!);

    const rootResponse = await fetch(new URL('/?json=true', baseUrl));
    expect(rootResponse.status).toBe(200);
    await expect(rootResponse.json()).resolves.toMatchObject({
      routes: [
        'POST /tray',
        'GET|POST /join/:token',
        'GET|POST /controller/:token',
        'POST /webhook/:token/:webhookId',
        'GET /auth/callback',
      ],
    });

    const legacyCreate = await fetch(new URL('/session', baseUrl), { method: 'POST' });
    expect(legacyCreate.status).toBe(410);
    await expect(legacyCreate.json()).resolves.toMatchObject({
      code: 'TRAY_CREATE_ENDPOINT_MOVED',
      canonical: 'POST /tray',
    });

    const legacyPluralCreate = await fetch(new URL('/trays', baseUrl), { method: 'POST' });
    expect(legacyPluralCreate.status).toBe(410);
    await expect(legacyPluralCreate.json()).resolves.toMatchObject({
      code: 'TRAY_CREATE_ENDPOINT_MOVED',
      canonical: 'POST /tray',
    });

    const createResponse = await fetch(new URL('/tray', baseUrl), { method: 'POST' });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as CreateTrayResponse;

    const joinResponse = await fetch(`${created.capabilities.join.url}?json=true`);
    expect(joinResponse.status).toBe(409);
    await expect(joinResponse.json()).resolves.toMatchObject({
      trayId: created.trayId,
      capability: 'join',
      code: 'FOLLOWER_JOIN_NOT_READY',
      retryable: true,
    });

    const waitingFollowerResponse = await fetch(created.capabilities.join.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId: 'ci-follower-wait', runtime: 'github-actions' }),
    });
    expect(waitingFollowerResponse.status).toBe(200);
    await expect(waitingFollowerResponse.json()).resolves.toMatchObject({
      role: 'follower',
      controllerId: 'ci-follower-wait',
      result: {
        action: 'wait',
        code: 'LEADER_NOT_ELECTED',
      },
    });

    const attachResponse = await fetch(created.capabilities.controller.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId: 'ci-live-check', runtime: 'github-actions' }),
    });
    expect(attachResponse.status).toBe(200);
    const controller = (await attachResponse.json()) as ControllerAttachResponse;
    expect(controller.role).toBe('leader');
    expect(controller.leaderKey).toBeTruthy();
    expect(controller.websocket?.url).toBeTruthy();

    const webhookBeforeLeader = await fetch(created.capabilities.webhook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(webhookBeforeLeader.status).toBe(400);
    await expect(webhookBeforeLeader.json()).resolves.toMatchObject({
      code: 'WEBHOOK_ID_REQUIRED',
    });

    const { socket, nextMessage } = await openWebSocket(controller.websocket!.url);
    const connected = await nextMessage();
    expect(connected).toMatchObject({
      type: 'leader.connected',
      trayId: created.trayId,
      controllerId: 'ci-live-check',
    });

    const signalFollowerResponse = await fetch(created.capabilities.join.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId: 'ci-follower-signal', runtime: 'github-actions' }),
    });
    expect(signalFollowerResponse.status).toBe(200);
    const signalFollower = (await signalFollowerResponse.json()) as {
      controllerId: string;
      result: { action: string; code: string; bootstrap: { bootstrapId: string; attempt: number } };
    };
    expect(signalFollower).toMatchObject({
      role: 'follower',
      controllerId: 'ci-follower-signal',
      result: {
        action: 'signal',
        code: 'LEADER_CONNECTED',
        bootstrap: { attempt: 1 },
      },
    });

    const joinRequested = await nextMessage();
    expect(joinRequested).toMatchObject({
      type: 'follower.join_requested',
      controllerId: 'ci-follower-signal',
      bootstrapId: signalFollower.result.bootstrap.bootstrapId,
      attempt: 1,
    });

    socket.send(JSON.stringify({ type: 'ping' }));
    const pong = await nextMessage();
    expect(pong).toMatchObject({ type: 'pong', trayId: created.trayId });

    const joinWithLeader = await fetch(`${created.capabilities.join.url}?json=true`);
    expect(joinWithLeader.status).toBe(200);
    await expect(joinWithLeader.json()).resolves.toMatchObject({
      trayId: created.trayId,
      capability: 'join',
      leader: { controllerId: 'ci-live-check', connected: true },
      signaling: {
        transport: 'http-poll',
        maxRetries: 3,
      },
    });

    socket.send(
      JSON.stringify({
        type: 'bootstrap.offer',
        controllerId: 'ci-follower-signal',
        bootstrapId: signalFollower.result.bootstrap.bootstrapId,
        offer: { type: 'offer', sdp: 'offer-sdp' },
      })
    );

    const polledBootstrap = await fetch(created.capabilities.join.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'poll',
        controllerId: 'ci-follower-signal',
        bootstrapId: signalFollower.result.bootstrap.bootstrapId,
        cursor: 0,
      }),
    });
    expect(polledBootstrap.status).toBe(200);
    await expect(polledBootstrap.json()).resolves.toMatchObject({
      controllerId: 'ci-follower-signal',
      bootstrap: { bootstrapId: signalFollower.result.bootstrap.bootstrapId, state: 'offered' },
      events: [{ type: 'bootstrap.offer', offer: { type: 'offer', sdp: 'offer-sdp' } }],
    });

    const answeredBootstrap = await fetch(created.capabilities.join.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'answer',
        controllerId: 'ci-follower-signal',
        bootstrapId: signalFollower.result.bootstrap.bootstrapId,
        answer: { type: 'answer', sdp: 'answer-sdp' },
      }),
    });
    expect(answeredBootstrap.status).toBe(200);
    await expect(answeredBootstrap.json()).resolves.toMatchObject({
      bootstrap: { bootstrapId: signalFollower.result.bootstrap.bootstrapId, state: 'connected' },
    });

    const answerMessage = await nextMessage();
    expect(answerMessage).toMatchObject({
      type: 'bootstrap.answer',
      controllerId: 'ci-follower-signal',
      bootstrapId: signalFollower.result.bootstrap.bootstrapId,
      answer: { type: 'answer', sdp: 'answer-sdp' },
    });

    const webhookWithLeader = await fetch(created.capabilities.webhook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'leader' }),
    });
    expect(webhookWithLeader.status).toBe(400);
    await expect(webhookWithLeader.json()).resolves.toMatchObject({ code: 'WEBHOOK_ID_REQUIRED' });

    socket.close();
  }, 30_000);

  it('serves the webapp SPA for plain GET requests', async () => {
    const baseUrl = new URL(workerBaseUrl!);
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    const contentType = response.headers.get('content-type') || '';
    expect(contentType).toContain('text/html');
    const body = await response.text();
    expect(body).toContain('<!DOCTYPE html>');
  }, 15_000);
});

function openWebSocket(
  url: string
): Promise<{ socket: WebSocket; nextMessage: () => Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const queue: Record<string, unknown>[] = [];
    const waiters: Array<(msg: Record<string, unknown>) => void> = [];

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const raw = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (waiters.length > 0) {
        waiters.shift()!(parsed);
      } else {
        queue.push(parsed);
      }
    });

    const nextMessage = (): Promise<Record<string, unknown>> => {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift()!);
      }
      return new Promise((res, rej) => {
        const timeout = setTimeout(() => rej(new Error('WebSocket message timeout')), 15_000);
        waiters.push((msg) => {
          clearTimeout(timeout);
          res(msg);
        });
      });
    };

    socket.once('open', () => resolve({ socket, nextMessage }));
    socket.once('error', reject);
  });
}
