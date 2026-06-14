/**
 * Unit coverage for the lick WebSocket bridge and the lick-backed HTTP routes
 * extracted from index.ts. The bridge is exercised with a fake ws client; the
 * routes are exercised against a real (ephemeral) Express server with an
 * injected bridge stub so the request/response contract is verified without a
 * live browser.
 */
import { EventEmitter } from 'node:events';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { registerLickApiRoutes } from '../../src/routes/lick-api.js';
import type { LickBridge } from '../../src/routes/lick-bridge.js';
import { createLickBridge } from '../../src/routes/lick-bridge.js';

/** Minimal stand-in for a connected `ws` client. */
class FakeClient extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: string[] = [];
  send(msg: string): void {
    this.sent.push(msg);
  }
}

describe('createLickBridge', () => {
  it('rejects sendLickRequest when no browser is connected', async () => {
    const bridge = createLickBridge();
    await expect(bridge.sendLickRequest('tray_status', {})).rejects.toThrow('No browser connected');
  });

  it('resolves a request when the browser replies with a matching requestId', async () => {
    const bridge = createLickBridge();
    const client = new FakeClient();
    bridge.lickWss.emit('connection', client);

    const pending = bridge.sendLickRequest('list_webhooks', { foo: 1 });
    expect(client.sent).toHaveLength(1);
    const sent = JSON.parse(client.sent[0]) as { type: string; requestId: string; foo: number };
    expect(sent.type).toBe('list_webhooks');
    expect(sent.foo).toBe(1);

    client.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'response', requestId: sent.requestId, data: { ok: true } })
      )
    );
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('rejects a request when the browser replies with an error', async () => {
    const bridge = createLickBridge();
    const client = new FakeClient();
    bridge.lickWss.emit('connection', client);

    const pending = bridge.sendLickRequest('create_webhook', {});
    const { requestId } = JSON.parse(client.sent[0]) as { requestId: string };
    client.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'response', requestId, error: 'Invalid url' }))
    );
    await expect(pending).rejects.toThrow('Invalid url');
  });

  it('times out when no reply arrives', async () => {
    vi.useFakeTimers();
    try {
      const bridge = createLickBridge();
      bridge.lickWss.emit('connection', new FakeClient());
      const pending = bridge.sendLickRequest('tray_status', {}, 10);
      const assertion = expect(pending).rejects.toThrow('Request timeout');
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('broadcasts events to every open client and drops the client on close', () => {
    const bridge = createLickBridge();
    const client = new FakeClient();
    bridge.lickWss.emit('connection', client);

    bridge.broadcastLickEvent({ type: 'webhook_event', id: 'x' });
    expect(client.sent).toHaveLength(1);
    expect(JSON.parse(client.sent[0])).toMatchObject({ type: 'webhook_event', id: 'x' });

    client.emit('close');
    bridge.broadcastLickEvent({ type: 'webhook_event', id: 'y' });
    expect(client.sent).toHaveLength(1); // disconnected — no further sends
  });
});

interface TestServer {
  port: number;
  close(): Promise<void>;
}

function startServer(bridge: LickBridge): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  registerLickApiRoutes(app, bridge);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function stubBridge(overrides: Partial<LickBridge> = {}): LickBridge {
  return {
    lickWss: null as unknown as LickBridge['lickWss'],
    sendLickRequest: vi.fn().mockResolvedValue({ ok: true }),
    broadcastLickEvent: vi.fn(),
    ...overrides,
  };
}

describe('registerLickApiRoutes', () => {
  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('forwards tray-status and returns the browser payload', async () => {
    const sendLickRequest = vi.fn().mockResolvedValue({ state: 'leader' });
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await fetch(`http://localhost:${server.port}/api/tray-status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'leader' });
    expect(sendLickRequest).toHaveBeenCalledWith('tray_status', {});
  });

  it('returns 503 when the browser is unavailable', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('No browser connected'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await fetch(`http://localhost:${server.port}/api/webhooks`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'No browser connected' });
  });

  it('maps an "Invalid" create_webhook error to 400', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('Invalid webhook id'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await fetch(`http://localhost:${server.port}/api/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'bad id' }),
    });
    expect(res.status).toBe(400);
  });

  it('maps a delete_webhook not-found error payload to 404', async () => {
    const sendLickRequest = vi.fn().mockResolvedValue({ error: 'no such webhook' });
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await fetch(`http://localhost:${server.port}/api/webhooks/abc`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(sendLickRequest).toHaveBeenCalledWith('delete_webhook', { id: 'abc' });
  });

  it('maps a "required" create_crontask error to 400', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('schedule is required'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await fetch(`http://localhost:${server.port}/api/crontasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns the browser payload for list webhooks / crontasks', async () => {
    const sendLickRequest = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'w1' }])
      .mockResolvedValueOnce([{ id: 'c1' }]);
    server = await startServer(stubBridge({ sendLickRequest }));
    const webhooks = await fetch(`http://localhost:${server.port}/api/webhooks`);
    expect(await webhooks.json()).toEqual([{ id: 'w1' }]);
    const crontasks = await fetch(`http://localhost:${server.port}/api/crontasks`);
    expect(await crontasks.json()).toEqual([{ id: 'c1' }]);
    expect(sendLickRequest).toHaveBeenNthCalledWith(1, 'list_webhooks', {});
    expect(sendLickRequest).toHaveBeenNthCalledWith(2, 'list_crontasks', {});
  });

  it('returns the created entity on a successful webhook / crontask POST', async () => {
    const sendLickRequest = vi
      .fn()
      .mockResolvedValueOnce({ id: 'w-new' })
      .mockResolvedValueOnce({ id: 'c-new' });
    server = await startServer(stubBridge({ sendLickRequest }));
    const webhook = await fetch(`http://localhost:${server.port}/api/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://x' }),
    });
    expect(webhook.status).toBe(200);
    expect(await webhook.json()).toEqual({ id: 'w-new' });
    const crontask = await fetch(`http://localhost:${server.port}/api/crontasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: '* * * * *' }),
    });
    expect(crontask.status).toBe(200);
    expect(await crontask.json()).toEqual({ id: 'c-new' });
  });

  it('returns the delete result on a successful webhook / crontask DELETE', async () => {
    const sendLickRequest = vi.fn().mockResolvedValue({ ok: true });
    server = await startServer(stubBridge({ sendLickRequest }));
    const webhook = await fetch(`http://localhost:${server.port}/api/webhooks/w1`, {
      method: 'DELETE',
    });
    expect(webhook.status).toBe(200);
    expect(await webhook.json()).toEqual({ ok: true });
    const crontask = await fetch(`http://localhost:${server.port}/api/crontasks/c1`, {
      method: 'DELETE',
    });
    expect(crontask.status).toBe(200);
    expect(sendLickRequest).toHaveBeenNthCalledWith(2, 'delete_crontask', { id: 'c1' });
  });

  it('maps a delete_crontask not-found payload to 404 and a browser drop to 503', async () => {
    const sendLickRequest = vi
      .fn()
      .mockResolvedValueOnce({ error: 'no such crontask' })
      .mockRejectedValueOnce(new Error('No browser connected'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const notFound = await fetch(`http://localhost:${server.port}/api/crontasks/c1`, {
      method: 'DELETE',
    });
    expect(notFound.status).toBe(404);
    const dropped = await fetch(`http://localhost:${server.port}/api/crontasks`);
    expect(dropped.status).toBe(503);
  });

  it('answers the webhook CORS preflight with 204 + allow headers', async () => {
    server = await startServer(stubBridge());
    const res = await fetch(`http://localhost:${server.port}/webhooks/abc`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('broadcasts a webhook_event for an inbound webhook POST', async () => {
    const broadcastLickEvent = vi.fn();
    server = await startServer(stubBridge({ broadcastLickEvent }));
    const res = await fetch(`http://localhost:${server.port}/webhooks/hook-1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: true });
    expect(broadcastLickEvent).toHaveBeenCalledTimes(1);
    expect(broadcastLickEvent.mock.calls[0][0]).toMatchObject({
      type: 'webhook_event',
      webhookId: 'hook-1',
      body: { hello: 'world' },
    });
  });
});
