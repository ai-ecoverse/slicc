import { describe, expect, it } from 'vitest';
import {
  patternToRegex,
  routeHandler,
  routeListHandler,
  unrouteHandler,
} from '../../../../../src/shell/supplemental-commands/playwright/handlers/routing.js';
import {
  createHandlerCtx,
  createMockBrowser,
  createPlaywrightState,
} from '../../../helpers/playwright-harness.js';

const TAB = 'tab-1';
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('patternToRegex', () => {
  it('matches * within a path segment only', () => {
    const re = patternToRegex('https://x/*');
    expect(re.test('https://x/api')).toBe(true);
    expect(re.test('https://x/api/nested')).toBe(false);
  });

  it('matches ** across segments', () => {
    const re = patternToRegex('https://x/**');
    expect(re.test('https://x/api/nested')).toBe(true);
  });

  it('anchors the whole string', () => {
    const re = patternToRegex('https://x/api');
    expect(re.test('https://x/api')).toBe(true);
    expect(re.test('prefix-https://x/api')).toBe(false);
  });
});

describe('routeHandler', () => {
  it('requires a URL pattern', async () => {
    const r = await routeHandler(createHandlerCtx({ flags: { tab: TAB } }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('requires a URL pattern');
  });

  it('requires a --tab flag', async () => {
    const r = await routeHandler(createHandlerCtx({ positional: ['**'] }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--tab');
  });

  it('adds a route, enabling Fetch interception once', async () => {
    const { browser, transport } = createMockBrowser();
    const state = createPlaywrightState();
    const r = await routeHandler(
      createHandlerCtx({
        browser,
        state,
        positional: ['**'],
        flags: {
          tab: TAB,
          status: '404',
          body: 'nope',
          'content-type': 'application/json',
          header: 'X-A: 1',
        },
      })
    );
    expect(r.stdout).toBe('Route added: **\n');
    expect(transport.send).toHaveBeenCalledWith('Fetch.enable', expect.anything(), 'session-1');
    const entry = state.routes.get(TAB)![0];
    expect(entry.status).toBe(404);
    expect(entry.body).toBe('nope');
    expect(entry.contentType).toBe('application/json');
    expect(entry.headers['X-A']).toBe('1');
    expect(state.routeCleanup.has(TAB)).toBe(true);
  });

  it('fulfills a matching intercepted request and continues a non-matching one', async () => {
    const { browser, transport } = createMockBrowser();
    const state = createPlaywrightState();
    await routeHandler(
      createHandlerCtx({
        browser,
        state,
        positional: ['https://x/**'],
        flags: { tab: TAB, body: 'B' },
      })
    );

    transport.emit('Fetch.requestPaused', {
      sessionId: 'session-1',
      requestId: 'q1',
      request: { url: 'https://x/api', headers: {} },
    });
    await flush();
    expect(transport.send).toHaveBeenCalledWith(
      'Fetch.fulfillRequest',
      expect.objectContaining({ requestId: 'q1', responseCode: 200 }),
      'session-1'
    );

    transport.emit('Fetch.requestPaused', {
      sessionId: 'session-1',
      requestId: 'q2',
      request: { url: 'https://other/api', headers: {} },
    });
    await flush();
    expect(transport.send).toHaveBeenCalledWith(
      'Fetch.continueRequest',
      { requestId: 'q2' },
      'session-1'
    );
  });

  it('ignores intercepted requests from a different session', async () => {
    const { browser, transport } = createMockBrowser();
    const state = createPlaywrightState();
    await routeHandler(
      createHandlerCtx({ browser, state, positional: ['**'], flags: { tab: TAB } })
    );
    transport.send.mockClear();
    transport.emit('Fetch.requestPaused', {
      sessionId: 'other',
      requestId: 'q9',
      request: { url: 'https://x', headers: {} },
    });
    await flush();
    expect(transport.send).not.toHaveBeenCalled();
  });
});

describe('routeListHandler', () => {
  it('reports no active routes', async () => {
    const r = await routeListHandler(createHandlerCtx({ flags: { tab: TAB } }));
    expect(r.stdout).toBe('No active routes\n');
  });

  it('lists active routes', async () => {
    const state = createPlaywrightState();
    state.routes.set(TAB, [
      { pattern: 'a', regex: /a/, status: 200, body: '', contentType: 'text/plain', headers: {} },
    ]);
    const r = await routeListHandler(createHandlerCtx({ state, flags: { tab: TAB } }));
    expect(r.stdout).toContain('1. a → 200 text/plain');
  });
});

describe('unrouteHandler', () => {
  it('removes all routes and runs cleanup when no pattern is given', async () => {
    const state = createPlaywrightState();
    let cleaned = false;
    state.routes.set(TAB, [
      { pattern: 'a', regex: /a/, status: 200, body: '', contentType: 'text/plain', headers: {} },
    ]);
    state.routeCleanup.set(TAB, () => {
      cleaned = true;
    });
    const r = await unrouteHandler(createHandlerCtx({ state, flags: { tab: TAB } }));
    expect(r.stdout).toBe('All routes removed\n');
    expect(state.routes.get(TAB)).toEqual([]);
    expect(cleaned).toBe(true);
    expect(state.routeCleanup.has(TAB)).toBe(false);
  });

  it('removes only routes matching a pattern and cleans up when empty', async () => {
    const state = createPlaywrightState();
    let cleaned = false;
    state.routes.set(TAB, [
      { pattern: 'a', regex: /a/, status: 200, body: '', contentType: 'text/plain', headers: {} },
    ]);
    state.routeCleanup.set(TAB, () => {
      cleaned = true;
    });
    const r = await unrouteHandler(
      createHandlerCtx({ state, positional: ['a'], flags: { tab: TAB } })
    );
    expect(r.stdout).toBe('Removed 1 route(s) matching "a"\n');
    expect(cleaned).toBe(true);
  });

  it('requires a --tab flag', async () => {
    const r = await unrouteHandler(createHandlerCtx());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--tab');
  });
});
