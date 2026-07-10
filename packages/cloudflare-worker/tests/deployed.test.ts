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
        'GET /download/slicc.dmg',
        'GET /handoff',
        'GET /.well-known/api-catalog',
        'GET /llms.txt',
        'GET /status',
        'GET /rel/:name',
        'GET|POST /join/:token',
        'GET|POST /controller/:token',
        'POST /webhook/:token/:webhookId',
        'POST /api/tray/:trayId/preview',
        'POST /api/tray/:trayId/preview/stop',
        'GET /api/tray/:trayId/previews',
        'POST /api/tray/:trayId/supersede',
        'GET /auth/callback',
        'POST /oauth/token',
        'POST /oauth/revoke',
        'GET /api/runtime-config',
        'ANY /api/fetch-proxy',
        'GET /api/cloud/config',
        'POST /api/cloud/start',
        'GET /api/cloud/list',
        'POST /api/cloud/pause',
        'POST /api/cloud/resume',
        'POST /api/cloud/kill',
        'GET /api/cloud/cone-config',
        'POST /api/cloud/sign-out',
        'GET /api/cloud/admin/stats',
        'GET /auth/cloud-callback',
        'GET /auth/cloud-callback.js',
        'GET /cloud',
        'GET /cloud/*',
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

    // Round-trip a ping/pong to guarantee the DO has processed the bootstrap.offer
    // message above before the follow-up HTTP poll arrives. Durable Objects process
    // WebSocket messages FIFO on a given connection, so pong implies offer is applied.
    socket.send(JSON.stringify({ type: 'ping' }));
    const offerAckPong = await nextMessage();
    expect(offerAckPong).toMatchObject({ type: 'pong', trayId: created.trayId });

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

  // GitHub validates (client_id, client_secret) before the code, so a fake-code
  // probe distinguishes "credentials wrong" from "credentials fine, code fake".
  it('exchanges fake GitHub OAuth codes through valid worker credentials', async () => {
    const baseUrl = new URL(workerBaseUrl!);
    const response = await fetch(new URL('/oauth/token', baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'github',
        code: 'FAKE_CODE_FOR_SMOKE_TEST',
      }),
    });
    const body = (await response.json()) as { error?: string; error_description?: string };
    expect(body.error).toBe('bad_verification_code');
  }, 15_000);

  it('POST /tray with kind=hosted creates a tray against the deployed worker', async () => {
    if (!workerBaseUrl) return;
    const baseUrl = new URL(workerBaseUrl);
    const response = await fetch(new URL('/tray', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'hosted' }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as CreateTrayResponse;
    expect(body.trayId).toBeTruthy();
    expect(body.capabilities.join.url).toBeTruthy();
    expect(body.capabilities.controller.url).toBeTruthy();
    expect(body.capabilities.webhook.url).toBeTruthy();
  }, 15_000);

  it('POST /tray with no body still creates a desktop tray (back-compat)', async () => {
    if (!workerBaseUrl) return;
    const baseUrl = new URL(workerBaseUrl);
    const response = await fetch(new URL('/tray', baseUrl), { method: 'POST' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as CreateTrayResponse;
    expect(body.trayId).toBeTruthy();
    expect(body.capabilities.join.url).toBeTruthy();
    expect(body.capabilities.controller.url).toBeTruthy();
    expect(body.capabilities.webhook.url).toBeTruthy();
  }, 15_000);

  // Hibernation regression guard. With the WebSocket Hibernation API the runtime
  // can evict the Durable Object from memory while the leader socket stays open,
  // so a webhook POST arrives on a *separate* invocation that must recover the
  // socket via getWebSockets() rather than an in-memory field. This is the exact
  // path that the duration-cost fix changed, and it is otherwise unexercised
  // live (the existing webhook checks only hit the WEBHOOK_ID_REQUIRED branch).
  it('forwards a webhook to a hibernatable leader socket on a separate request', async () => {
    const baseUrl = new URL(workerBaseUrl!);
    const createResponse = await fetch(new URL('/tray', baseUrl), { method: 'POST' });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as CreateTrayResponse;

    const attachResponse = await fetch(created.capabilities.controller.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId: 'ci-webhook-leader', runtime: 'github-actions' }),
    });
    expect(attachResponse.status).toBe(200);
    const controller = (await attachResponse.json()) as ControllerAttachResponse;
    expect(controller.websocket?.url).toBeTruthy();

    const { socket, nextMessage } = await openWebSocket(controller.websocket!.url);
    try {
      const connected = await nextMessage();
      expect(connected).toMatchObject({ type: 'leader.connected', trayId: created.trayId });

      const webhookResponse = await fetch(`${created.capabilities.webhook.url}/ci-hook-1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'opened', repo: 'ci/repo' }),
      });
      expect(webhookResponse.status).toBe(202);
      await expect(webhookResponse.json()).resolves.toMatchObject({ ok: true, accepted: true });

      const forwarded = await nextMessage();
      expect(forwarded).toMatchObject({
        type: 'webhook.event',
        webhookId: 'ci-hook-1',
        body: { action: 'opened', repo: 'ci/repo' },
      });
    } finally {
      socket.close();
    }
  }, 30_000);

  // Idle gap long enough for the runtime to potentially hibernate the object.
  // The test passes whether or not eviction actually happens, but if the leader
  // socket were pinned in an in-memory field (the pre-fix behavior) a rehydration
  // bug would only ever surface here, after the object has been reclaimed.
  it('still delivers webhooks to the leader after an idle gap that may trigger hibernation', async () => {
    const baseUrl = new URL(workerBaseUrl!);
    const created = (await (
      await fetch(new URL('/tray', baseUrl), { method: 'POST' })
    ).json()) as CreateTrayResponse;
    const controller = (await (
      await fetch(created.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'ci-idle-leader', runtime: 'github-actions' }),
      })
    ).json()) as ControllerAttachResponse;
    expect(controller.websocket?.url).toBeTruthy();

    const { socket, nextMessage } = await openWebSocket(controller.websocket!.url);
    try {
      await nextMessage(); // leader.connected

      await new Promise((resolve) => setTimeout(resolve, 10_000));

      const webhookResponse = await fetch(
        `${created.capabilities.webhook.url}/ci-hook-after-idle`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phase: 'after-idle' }),
        }
      );
      expect(webhookResponse.status).toBe(202);

      const forwarded = await nextMessage();
      expect(forwarded).toMatchObject({
        type: 'webhook.event',
        webhookId: 'ci-hook-after-idle',
        body: { phase: 'after-idle' },
      });
    } finally {
      socket.close();
    }
  }, 30_000);

  // After the leader socket closes, the runtime delivers webSocketClose on a
  // possibly-fresh instance. Liveness must drop so webhooks are rejected with
  // NO_LIVE_LEADER instead of being silently dropped against a dead socket.
  it('drops leader liveness after the socket closes so webhooks are rejected', async () => {
    const baseUrl = new URL(workerBaseUrl!);
    const created = (await (
      await fetch(new URL('/tray', baseUrl), { method: 'POST' })
    ).json()) as CreateTrayResponse;
    const controller = (await (
      await fetch(created.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'ci-close-leader', runtime: 'github-actions' }),
      })
    ).json()) as ControllerAttachResponse;
    expect(controller.websocket?.url).toBeTruthy();

    const { socket, nextMessage } = await openWebSocket(controller.websocket!.url);
    await nextMessage(); // leader.connected
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close();
    });

    // webSocketClose is processed asynchronously by the runtime; poll until the
    // tray no longer reports a live leader.
    let rejected = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const webhookResponse = await fetch(`${created.capabilities.webhook.url}/ci-hook-closed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phase: 'after-close' }),
      });
      if (webhookResponse.status === 410) {
        await expect(webhookResponse.json()).resolves.toMatchObject({ code: 'NO_LIVE_LEADER' });
        rejected = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(rejected).toBe(true);
  }, 30_000);
});

describe('static assets + R2 archive', () => {
  // Both prod and staging: confirm present assets serve and archive doesn't block JSON split.
  it('serves present assets with correct content-type and archive bypass (both envs)', async () => {
    if (!workerBaseUrl) return;

    const baseUrl = new URL(workerBaseUrl);
    // Fetch the SPA with redirect: 'manual' to detect any redirect (prod redirects bare / to .com)
    const spaResponse = await fetch(new URL('/?json=false', baseUrl), {
      redirect: 'manual',
    });
    // Should not redirect — the ?json=false param should load the SPA (200) even at
    // prod root (bare `/` redirects to .com; the query suppresses that). toBe(200)
    // catches any 3xx/opaqueredirect (redirect: 'manual') — a numeric status can't
    // use toMatch (string-only).
    expect(spaResponse.status).toBe(200);

    const spaBody = await spaResponse.text();
    // Extract a real /assets/* URL from the HTML
    const assetMatch = spaBody.match(/\/assets\/[A-Za-z0-9._-]+\.(js|css)/);
    expect(assetMatch).toBeTruthy();
    const assetPath = assetMatch![0];

    // Fetch the asset with Accept-Encoding to test compression headers
    const assetResponse = await fetch(new URL(assetPath, baseUrl), {
      headers: { 'Accept-Encoding': 'br,gzip' },
    });
    expect(assetResponse.status).toBe(200);
    const assetCt = assetResponse.headers.get('content-type') || '';
    expect(assetCt).toMatch(/text\/javascript|text\/css/);

    // Log the compression header for debugging
    const encoding = assetResponse.headers.get('content-encoding');
    console.log(`Asset ${assetPath} served with Content-Encoding: ${encoding || 'none'}`);

    // Repeat the asset fetch with ?json=true to confirm it's not intercepted
    const assetWithJsonResponse = await fetch(new URL(assetPath + '?json=true', baseUrl));
    expect(assetWithJsonResponse.status).toBe(200);
    const assetWithJsonCt = assetWithJsonResponse.headers.get('content-type') || '';
    expect(assetWithJsonCt).toMatch(/text\/javascript|text\/css/);
  }, 15_000);

  // Staging only: upload a synthetic asset to R2, fetch via worker, verify archive recovery
  it('recovers archived assets on ASSETS miss (staging-only R2 smoke)', async () => {
    if (!workerBaseUrl) return;

    const archiveSmoke = process.env.SLICC_ARCHIVE_SMOKE === '1';
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const bucket = process.env.SLICC_ARCHIVE_BUCKET;

    // Self-gate: skip if not configured
    if (!archiveSmoke || !apiToken || !accountId || !bucket) {
      console.log(
        'Skipping archive smoke test (requires SLICC_ARCHIVE_SMOKE=1, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, SLICC_ARCHIVE_BUCKET)'
      );
      return;
    }

    // Defense-in-depth: verify we're pointed at staging, not prod
    const baseUrl = new URL(workerBaseUrl);
    const host = baseUrl.host.toLowerCase();
    const isStaging = host.includes('staging') || host.includes('workers.dev');
    const isProd = host.includes('sliccy.ai') && !host.includes('staging');

    if (isProd) {
      throw new Error(
        `SLICC_ARCHIVE_SMOKE=1 but WORKER_BASE_URL points to production (${host}). Refusing to write to prod R2.`
      );
    }

    if (!isStaging) {
      console.warn(
        `Archive smoke test: cannot verify staging (host: ${host}). Proceeding with caution.`
      );
    }

    // Generate a random hash for the test asset
    const randomHash = Math.random().toString(36).substring(2, 10);
    const testKey = `assets/r2-retention-smoke-${randomHash}.js`;
    const testContent = `console.log('r2-retention-smoke test: ${randomHash}');`;

    try {
      // Write test asset to R2 via wrangler
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);

      // Write to temp file
      const { writeFileSync } = await import('node:fs');
      const tmpFile = `/tmp/r2-retention-smoke-${randomHash}.js`;
      writeFileSync(tmpFile, testContent);

      try {
        // Upload via wrangler
        await exec('npx', [
          'wrangler',
          'r2',
          'object',
          'put',
          `${bucket}/${testKey}`,
          '--file',
          tmpFile,
          '--content-type',
          'text/javascript',
          '--remote',
        ]);
      } finally {
        // Clean up temp file
        const { unlinkSync } = await import('node:fs');
        try {
          unlinkSync(tmpFile);
        } catch {
          // ignore
        }
      }

      // Fetch through the worker (should hit the archive path since asset is not in current build)
      const assetUrl = new URL(`/${testKey}`, baseUrl);
      const fetchResponse = await fetch(assetUrl.toString());
      expect(fetchResponse.status).toBe(200);

      const contentType = fetchResponse.headers.get('content-type') || '';
      expect(contentType).toBe('text/javascript');

      const etag = fetchResponse.headers.get('etag');
      expect(etag).toBeTruthy();

      const body = await fetchResponse.text();
      expect(body).toContain('r2-retention-smoke');

      // Verify HEAD request works
      const headResponse = await fetch(assetUrl.toString(), { method: 'HEAD' });
      expect(headResponse.status).toBe(200);
      expect(headResponse.headers.get('content-type')).toBe('text/javascript');
      expect(headResponse.headers.get('etag')).toBe(etag);

      // Verify second fetch (cache hit)
      const cachedResponse = await fetch(assetUrl.toString());
      expect(cachedResponse.status).toBe(200);
      const cachedBody = await cachedResponse.text();
      expect(cachedBody).toContain('r2-retention-smoke');

      // Verify unknown asset returns shell
      const unknownUrl = new URL(`/assets/nonexistent-${randomHash}.js`, baseUrl);
      const shellResponse = await fetch(unknownUrl.toString());
      expect(shellResponse.status).toBe(200);
      const shellCt = shellResponse.headers.get('content-type') || '';
      expect(shellCt).toContain('text/html');
    } finally {
      // Clean up the test asset from R2
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);

      try {
        await exec('npx', [
          'wrangler',
          'r2',
          'object',
          'delete',
          `${bucket}/${testKey}`,
          '--remote',
        ]);
      } catch {
        // Best-effort cleanup; don't fail the test
      }
    }
  }, 30_000);
});

describe('cloud routes smoke', () => {
  it('rejects unauthenticated /api/cloud/list with 401', async () => {
    if (!workerBaseUrl) return;
    const res = await fetch(`${workerBaseUrl}/api/cloud/list`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/MISSING_TOKEN|INVALID_TOKEN/);
  });

  it('serves /cloud dashboard with CSP', async () => {
    if (!workerBaseUrl) return;
    const res = await fetch(`${workerBaseUrl}/cloud`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('content-security-policy')).toBeTruthy();
  });
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
