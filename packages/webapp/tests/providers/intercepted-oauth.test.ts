/**
 * Tests for the intercepted-OAuth abstraction.
 *
 * Covers:
 *   - JSON config validation (parseInterceptOAuthConfig)
 *   - URL-rewrite rule application (applyRewrites)
 *   - End-to-end launcher behaviour with a fake CDPTransport:
 *       * captures the URL when a request matches redirectUriPattern
 *       * closes the tab on capture (onCapture: 'close', default)
 *       * leaves the tab open when onCapture: 'leave'
 *       * applies request rewrites on intermediate hops
 *       * resolves null on timeout
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CDPTransport } from '../../src/cdp/transport.js';
import {
  applyRewrites,
  createInterceptingOAuthLauncher,
  parseInterceptOAuthConfig,
} from '../../src/providers/intercepted-oauth.js';

// ── Fake CDPTransport ─────────────────────────────────────────────────

type Listener = (params: Record<string, unknown>) => void;

interface FakeTransportState {
  sent: Array<{ method: string; params: Record<string, unknown> | undefined; sessionId?: string }>;
  listeners: Map<string, Set<Listener>>;
  /** Stub responses keyed by command name. */
  responses: Map<string, Record<string, unknown>>;
}

function createFakeTransport(): { transport: CDPTransport; state: FakeTransportState } {
  const state: FakeTransportState = {
    sent: [],
    listeners: new Map(),
    responses: new Map([
      ['Target.createTarget', { targetId: 'target-xyz' }],
      ['Target.attachToTarget', { sessionId: 'session-abc' }],
    ]),
  };

  const transport: CDPTransport = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(() => {}),
    send: vi.fn(async (method, params, sessionId) => {
      state.sent.push({ method, params, sessionId });
      return state.responses.get(method) ?? {};
    }),
    on: vi.fn((event, listener) => {
      if (!state.listeners.has(event)) state.listeners.set(event, new Set());
      state.listeners.get(event)!.add(listener);
    }),
    off: vi.fn((event, listener) => {
      state.listeners.get(event)?.delete(listener);
    }),
    once: vi.fn(async () => ({})),
    state: 'connected' as const,
  };

  return { transport, state };
}

function emit(state: FakeTransportState, event: string, params: Record<string, unknown>): void {
  const listeners = state.listeners.get(event);
  if (!listeners) return;
  for (const fn of listeners) fn(params);
}

// ── parseInterceptOAuthConfig ─────────────────────────────────────────

describe('parseInterceptOAuthConfig', () => {
  it('accepts a minimal valid config', () => {
    const r = parseInterceptOAuthConfig({
      authorizeUrl: 'https://auth.example/authorize',
      redirectUriPattern: 'http://127.0.0.1:56121/*',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.authorizeUrl).toBe('https://auth.example/authorize');
      expect(r.config.onCapture).toBeUndefined();
      expect(r.config.rewrite).toBeUndefined();
    }
  });

  it('rejects missing authorizeUrl', () => {
    const r = parseInterceptOAuthConfig({ redirectUriPattern: 'http://127.0.0.1/*' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/authorizeUrl/);
  });

  it('rejects unknown onCapture values', () => {
    const r = parseInterceptOAuthConfig({
      authorizeUrl: 'https://x',
      redirectUriPattern: 'http://127.0.0.1/*',
      onCapture: 'minimise',
    });
    expect(r.ok).toBe(false);
  });

  it('validates rewrite rules', () => {
    const r = parseInterceptOAuthConfig({
      authorizeUrl: 'https://x',
      redirectUriPattern: 'http://127.0.0.1/*',
      rewrite: [{ match: 'authorize', appendParams: { plan: 'generic' } }],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects rewrite rules with non-string appendParams values', () => {
    const r = parseInterceptOAuthConfig({
      authorizeUrl: 'https://x',
      redirectUriPattern: 'http://127.0.0.1/*',
      rewrite: [{ match: 'authorize', appendParams: { plan: 1 } }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/appendParams/);
  });
});

// ── applyRewrites ─────────────────────────────────────────────────────

describe('applyRewrites', () => {
  it('appends params to matching URLs', () => {
    const out = applyRewrites('https://auth.x.ai/oauth2/auth?x=1', [
      { match: 'auth.x.ai', appendParams: { plan: 'generic', referrer: 'slicc' } },
    ]);
    expect(out).toContain('plan=generic');
    expect(out).toContain('referrer=slicc');
    expect(out).toContain('x=1');
  });

  it('leaves non-matching URLs alone', () => {
    const out = applyRewrites('https://other.example/', [
      { match: 'auth.x.ai', appendParams: { plan: 'generic' } },
    ]);
    expect(out).toBe('https://other.example/');
  });

  it('replaceUrl wins over appendParams when both match', () => {
    const out = applyRewrites('https://a/', [
      { match: 'a/', replaceUrl: 'https://b/', appendParams: { x: 'y' } },
    ]);
    expect(out).toBe('https://b/');
  });
});

// ── End-to-end launcher behaviour ─────────────────────────────────────

describe('createInterceptingOAuthLauncher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures the URL of the first request matching redirectUriPattern and closes the tab', async () => {
    const { transport, state } = createFakeTransport();
    const launcher = createInterceptingOAuthLauncher(transport);

    const flowPromise = launcher({
      authorizeUrl: 'https://auth.x.ai/oauth2/auth',
      redirectUriPattern: 'http://127.0.0.1:56121/*',
    });

    // Yield once so the setup `await transport.send(...)` chain runs.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    emit(state, 'Fetch.requestPaused', {
      requestId: 'r1',
      request: {
        url: 'http://127.0.0.1:56121/callback?code=ABC&state=xyz',
        method: 'GET',
        headers: {},
      },
    });

    const captured = await flowPromise;
    expect(captured).toBe('http://127.0.0.1:56121/callback?code=ABC&state=xyz');

    const methods = state.sent.map((c) => c.method);
    expect(methods).toContain('Target.createTarget');
    expect(methods).toContain('Target.attachToTarget');
    expect(methods).toContain('Fetch.enable');
    expect(methods).toContain('Page.navigate');
    expect(methods).toContain('Fetch.failRequest');
    expect(methods).toContain('Target.closeTarget');
  });

  it('does not close the tab when onCapture is "leave"', async () => {
    const { transport, state } = createFakeTransport();
    const launcher = createInterceptingOAuthLauncher(transport);

    const flowPromise = launcher({
      authorizeUrl: 'https://auth.x.ai/oauth2/auth',
      redirectUriPattern: 'http://127.0.0.1:56121/*',
      onCapture: 'leave',
    });

    for (let i = 0; i < 5; i++) await Promise.resolve();

    emit(state, 'Fetch.requestPaused', {
      requestId: 'r1',
      request: { url: 'http://127.0.0.1:56121/callback?code=ABC', method: 'GET', headers: {} },
    });

    await flowPromise;
    expect(state.sent.map((c) => c.method)).not.toContain('Target.closeTarget');
  });

  it('applies appendParams rewrites to intermediate requests', async () => {
    const { transport, state } = createFakeTransport();
    const launcher = createInterceptingOAuthLauncher(transport);

    const flowPromise = launcher({
      authorizeUrl: 'https://auth.x.ai/oauth2/auth',
      redirectUriPattern: 'http://127.0.0.1:56121/*',
      rewrite: [{ match: 'auth.x.ai', appendParams: { plan: 'generic' } }],
    });

    for (let i = 0; i < 5; i++) await Promise.resolve();

    // An intermediate request to the authorize URL — should be rewritten.
    emit(state, 'Fetch.requestPaused', {
      requestId: 'r-auth',
      request: { url: 'https://auth.x.ai/oauth2/auth?x=1', method: 'GET', headers: {} },
    });

    // Drain microtasks so the rewrite send() lands in state.sent.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Finish the flow.
    emit(state, 'Fetch.requestPaused', {
      requestId: 'r-redir',
      request: { url: 'http://127.0.0.1:56121/callback?code=ABC', method: 'GET', headers: {} },
    });

    await flowPromise;

    const continueCalls = state.sent.filter((c) => c.method === 'Fetch.continueRequest');
    const rewrittenCall = continueCalls.find(
      (c) => typeof c.params?.url === 'string' && (c.params.url as string).includes('plan=generic')
    );
    expect(rewrittenCall).toBeDefined();
  });

  it('resolves null on timeout', async () => {
    const { transport } = createFakeTransport();
    const launcher = createInterceptingOAuthLauncher(transport);

    const flowPromise = launcher({
      authorizeUrl: 'https://auth.x.ai/oauth2/auth',
      redirectUriPattern: 'http://127.0.0.1:56121/*',
      timeoutMs: 1_000,
    });

    for (let i = 0; i < 5; i++) await Promise.resolve();
    vi.advanceTimersByTime(2_000);

    const result = await flowPromise;
    expect(result).toBeNull();
  });
});
