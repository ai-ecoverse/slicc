import { afterEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import {
  closeWebSocket,
  expectStringOrNull,
  extractAssetPath,
  fetchFromServer,
  openWebSocket,
  serverUrl,
} from './helpers.js';

const openSockets = new Set<WebSocket>();

afterEach(async () => {
  await Promise.all(Array.from(openSockets, (socket) => closeWebSocket(socket)));
  openSockets.clear();
});

describe('shared server API conformance', () => {
  it('serves HTML for app routes, preserves API 404s, and sets HTML/JS/CSS content types', async () => {
    const root = await fetchFromServer('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');

    const rootHtml = await root.text();
    expect(rootHtml).toContain('<!DOCTYPE html>');
    expect(rootHtml).toContain('<div id="app"></div>');

    const scriptPath = extractAssetPath(rootHtml, 'script');
    const stylesheetPath = extractAssetPath(rootHtml, 'stylesheet');

    const spaFallback = await fetchFromServer('/nonexistent-path');
    expect(spaFallback.status).toBe(200);
    expect(spaFallback.headers.get('content-type')).toContain('text/html');
    expect(await spaFallback.text()).toContain('<div id="app"></div>');

    const missingApi = await fetchFromServer('/api/nonexistent');
    expect(missingApi.status).toBe(404);

    const script = await fetchFromServer(scriptPath);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toMatch(/javascript/i);

    const stylesheet = await fetchFromServer(stylesheetPath);
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get('content-type')).toContain('text/css');
  });

  it('returns runtime config with the expected nullable string fields', async () => {
    const response = await fetchFromServer('/api/runtime-config');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('trayWorkerBaseUrl');
    expect(body).toHaveProperty('trayJoinUrl');
    expectStringOrNull(body['trayWorkerBaseUrl']);
    expectStringOrNull(body['trayJoinUrl']);
  });

  it('serves the OAuth callback page and relays/stores pending OAuth results', async () => {
    const drain = await fetchFromServer('/api/oauth-result');
    expect([200, 204]).toContain(drain.status);

    const callback = await fetchFromServer('/auth/callback?code=test-code&state=test-state');
    expect(callback.status).toBe(200);
    expect(callback.headers.get('content-type')).toContain('text/html');
    const callbackHtml = await callback.text();
    expect(callbackHtml).toContain('Completing login');
    expect(callbackHtml).toContain('/api/oauth-result');

    const redirectUrl = `https://example.test/oauth/callback#state=state-${Date.now()}`;
    const post = await fetchFromServer('/api/oauth-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirectUrl, error: 'access_denied', code: 'ignored-by-server' }),
    });
    expect(post.status).toBe(200);
    await expect(post.json()).resolves.toEqual({ ok: true });

    const firstPoll = await fetchFromServer('/api/oauth-result');
    expect(firstPoll.status).toBe(200);
    await expect(firstPoll.json()).resolves.toEqual({ redirectUrl, error: 'access_denied' });

    const secondPoll = await fetchFromServer('/api/oauth-result');
    expect(secondPoll.status).toBe(204);
  });

  it('proxies local requests through /api/fetch-proxy', async () => {
    const missingHeader = await fetchFromServer('/api/fetch-proxy', { method: 'POST' });
    expect(missingHeader.status).toBe(400);

    const proxied = await fetchFromServer('/api/fetch-proxy', {
      method: 'GET',
      headers: {
        'x-target-url': serverUrl('/api/runtime-config'),
      },
    });
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get('transfer-encoding')).toBeNull();
    expect(proxied.headers.get('content-encoding')).toBeNull();
    expect(proxied.headers.get('www-authenticate')).toBeNull();

    const body = (await proxied.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('trayWorkerBaseUrl');
  });

  it('returns webhook CORS headers for preflight requests', async () => {
    const response = await fetchFromServer('/webhooks/test-id', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(response.headers.get('access-control-allow-headers')).toContain('Content-Type');
  });

  it('accepts lick websocket connections, handles request/response traffic, and broadcasts webhook events', async () => {
    const { socket, nextMessage } = await openWebSocket('/licks-ws');
    openSockets.add(socket);

    const trayStatusPromise = fetchFromServer('/api/tray-status');
    const request = await nextMessage();
    expect(request['type']).toBe('tray_status');
    expect(typeof request['requestId']).toBe('string');

    socket.send(
      JSON.stringify({
        type: 'response',
        requestId: request['requestId'],
        data: { state: 'connected', joinUrl: 'https://example.test/join' },
      })
    );

    const trayStatus = await trayStatusPromise;
    expect(trayStatus.status).toBe(200);
    await expect(trayStatus.json()).resolves.toEqual({
      state: 'connected',
      joinUrl: 'https://example.test/join',
    });

    const webhookPost = await fetchFromServer('/webhooks/test-id', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'ping' }),
    });
    expect(webhookPost.status).toBe(200);
    await expect(webhookPost.json()).resolves.toEqual({ ok: true, received: true });

    const broadcast = await nextMessage();
    expect(broadcast).toMatchObject({
      type: 'webhook_event',
      webhookId: 'test-id',
      body: { event: 'ping' },
    });
  });

  it('accepts websocket upgrades on /cdp', async () => {
    const { socket } = await openWebSocket('/cdp');
    openSockets.add(socket);
  });

  it('returns structured responses from lick-backed REST endpoints based on browser connectivity', async () => {
    const endpoints = [
      {
        path: '/api/webhooks',
        assertConnectedBody: (body: unknown) => expect(Array.isArray(body)).toBe(true),
      },
      {
        path: '/api/tray-status',
        assertConnectedBody: (body: unknown) => {
          expect(body && typeof body === 'object').toBe(true);
          expect(typeof (body as Record<string, unknown>)['state']).toBe('string');
          expectStringOrNull((body as Record<string, unknown>)['joinUrl']);
        },
      },
      {
        path: '/api/crontasks',
        assertConnectedBody: (body: unknown) => expect(Array.isArray(body)).toBe(true),
      },
    ];

    for (const { path, assertConnectedBody } of endpoints) {
      const response = await fetchFromServer(path);
      const body = (await response.json()) as Record<string, unknown> | unknown[];

      if (response.status === 503) {
        expect(typeof (body as Record<string, unknown>)['error']).toBe('string');
        continue;
      }

      expect(response.status, `${path} should either succeed or report browser unavailability`).toBe(200);
      assertConnectedBody(body);
    }
  });
});