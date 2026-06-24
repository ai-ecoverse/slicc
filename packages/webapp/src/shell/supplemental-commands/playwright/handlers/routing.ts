/**
 * Network route interception subcommands.
 *
 * Uses the CDP Fetch domain to intercept requests before they are sent,
 * allowing agents to mock API responses per-tab.
 *
 * Commands: route, route-list, unroute
 */

import type { BrowserAPI } from '../../../../cdp/index.js';
import { requireTab } from '../state.js';
import type { PlaywrightHandler, PlaywrightState, RouteEntry } from '../types.js';

/** Convert a glob-style URL pattern to a RegExp. */
export function patternToRegex(pattern: string): RegExp {
  // Escape regex special chars except * which we handle specially
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // Replace ** (now @@-encoded to avoid double processing) then *
  const re = escaped.replace(/\*\*/g, '@@').replace(/\*/g, '[^/]*').replace(/@@/g, '.*');
  return new RegExp(`^${re}$`);
}

/** Enable CDP Fetch domain interception for a tab and register the event handler. */
async function enableFetchInterception(
  browser: BrowserAPI,
  state: PlaywrightState,
  targetId: string
): Promise<void> {
  await browser.withTab(targetId, async (sessionId) => {
    const transport = browser.getTransport();

    await transport.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      sessionId
    );

    const handler = async (params: unknown) => {
      if ((params as { sessionId?: string })['sessionId'] !== sessionId) return;

      const { requestId, request } = params as {
        requestId: string;
        request: { url: string; headers: Record<string, string> };
      };

      const routes = state.routes.get(targetId) ?? [];
      const match = routes.find((r) => patternToRegex(r.pattern).test(request.url));

      if (!match) {
        await transport
          .send('Fetch.continueRequest', { requestId }, sessionId)
          .catch(() => undefined);
        return;
      }

      const responseHeaders: Array<{ name: string; value: string }> = [
        { name: 'Content-Type', value: match.contentType },
        ...Object.entries(match.headers).map(([name, value]) => ({ name, value })),
      ];

      await transport
        .send(
          'Fetch.fulfillRequest',
          {
            requestId,
            responseCode: match.status,
            responseHeaders,
            body: match.body ? btoa(match.body) : '',
          },
          sessionId
        )
        .catch(() => undefined);
    };

    transport.on('Fetch.requestPaused', handler);

    state.routeCleanup.set(targetId, () => {
      transport.off('Fetch.requestPaused', handler);
      transport.send('Fetch.disable', {}, sessionId).catch(() => undefined);
    });
  });
}

export const routeHandler: PlaywrightHandler = async ({ browser, state, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'route requires a URL pattern\n', exitCode: 1 };
  }

  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  const pattern = positional[0];
  const entry: RouteEntry = {
    pattern,
    status: flags['status'] ? parseInt(flags['status'], 10) : 200,
    body: flags['body'] ?? '',
    contentType: flags['content-type'] ?? 'text/plain',
    headers: {},
    removeHeaders: flags['remove-header'] ? flags['remove-header'].split(',') : [],
  };

  if (flags['header']) {
    for (const h of flags['header'].split(',')) {
      const colonIdx = h.indexOf(':');
      if (colonIdx > 0) {
        const name = h.slice(0, colonIdx).trim();
        const value = h.slice(colonIdx + 1).trim();
        entry.headers[name] = value;
      }
    }
  }

  if (!state.routeCleanup.has(tab.targetId)) {
    if (!state.routes.has(tab.targetId)) state.routes.set(tab.targetId, []);
    await enableFetchInterception(browser, state, tab.targetId);
  }

  const routes = state.routes.get(tab.targetId) ?? [];
  routes.unshift(entry);
  state.routes.set(tab.targetId, routes);

  return { stdout: `Route added: ${pattern}\n`, stderr: '', exitCode: 0 };
};

export const routeListHandler: PlaywrightHandler = async ({ state, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  const routes = state.routes.get(tab.targetId) ?? [];
  if (routes.length === 0) {
    return { stdout: 'No active routes\n', stderr: '', exitCode: 0 };
  }

  const lines = routes.map((r, i) => `${i + 1}. ${r.pattern} → ${r.status} ${r.contentType}`);
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
};

export const unrouteHandler: PlaywrightHandler = async ({ state, positional, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  const pattern = positional[0];

  if (!pattern) {
    state.routes.set(tab.targetId, []);
    const cleanup = state.routeCleanup.get(tab.targetId);
    if (cleanup) {
      cleanup();
      state.routeCleanup.delete(tab.targetId);
    }
    return { stdout: 'All routes removed\n', stderr: '', exitCode: 0 };
  }

  const routes = state.routes.get(tab.targetId) ?? [];
  const before = routes.length;
  const filtered = routes.filter((r) => r.pattern !== pattern);
  state.routes.set(tab.targetId, filtered);

  if (filtered.length === 0) {
    const cleanup = state.routeCleanup.get(tab.targetId);
    if (cleanup) {
      cleanup();
      state.routeCleanup.delete(tab.targetId);
    }
  }

  const removed = before - filtered.length;
  return { stdout: `Removed ${removed} route(s) matching "${pattern}"\n`, stderr: '', exitCode: 0 };
};
