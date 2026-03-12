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

    const rootResponse = await fetch(baseUrl);
    expect(rootResponse.status).toBe(200);
    await expect(rootResponse.json()).resolves.toMatchObject({
      routes: ['POST /tray', 'GET|POST /join/:token', 'GET|POST /controller/:token', 'POST /webhook/:token'],
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

    const joinResponse = await fetch(created.capabilities.join.url);
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
    expect(webhookBeforeLeader.status).toBe(410);
    await expect(webhookBeforeLeader.json()).resolves.toMatchObject({ code: 'NO_LIVE_LEADER' });

    const socket = await openWebSocket(controller.websocket!.url);
    const connected = await waitForJsonMessage(socket);
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

    const joinRequested = await waitForJsonMessage(socket);
    expect(joinRequested).toMatchObject({
      type: 'follower.join_requested',
      controllerId: 'ci-follower-signal',
      bootstrapId: signalFollower.result.bootstrap.bootstrapId,
      attempt: 1,
    });

    socket.send(JSON.stringify({ type: 'ping' }));
    const pong = await waitForJsonMessage(socket);
    expect(pong).toMatchObject({ type: 'pong', trayId: created.trayId });

    const joinWithLeader = await fetch(created.capabilities.join.url);
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

    socket.send(JSON.stringify({
      type: 'bootstrap.offer',
      controllerId: 'ci-follower-signal',
      bootstrapId: signalFollower.result.bootstrap.bootstrapId,
      offer: { type: 'offer', sdp: 'offer-sdp' },
    }));

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

    const answerMessage = await waitForJsonMessage(socket);
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
    expect(webhookWithLeader.status).toBe(501);
    await expect(webhookWithLeader.json()).resolves.toMatchObject({ code: 'WEBHOOK_FORWARDING_NOT_IMPLEMENTED' });

    socket.close();
  }, 30_000);
});

function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForJsonMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
      cleanup();
      try {
        const raw = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      socket.off('message', onMessage);
      socket.off('error', onError);
    };

    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}