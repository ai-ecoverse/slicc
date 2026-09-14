import { uint8ToBase64 } from '@slicc/shared-ts';
import { createLogger } from '../../../../base/logger.js';
import { bindTabCapture, type TabCaptureBinding } from '../session-rebind.js';
import { requireTab } from '../state.js';
import type {
  PlaywrightHandler,
  PlaywrightHandlerCtx,
  PlaywrightState,
  RouteEntry,
} from '../types.js';

const log = createLogger('playwright-route');

const FETCH_PATTERNS = [{ urlPattern: '*', requestStage: 'Request' }];

type BrowserAPI = PlaywrightHandlerCtx['browser'];

export function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

  const re = escaped.replace(/\*\*/g, '@@').replace(/\*/g, '[^/]*').replace(/@@/g, '.*');
  return new RegExp(`^${re}$`);
}

type FetchTransport = ReturnType<BrowserAPI['getTransport']>;

async function handleRequestPaused(
  transport: FetchTransport,
  sessionId: string,
  state: PlaywrightState,
  targetId: string,
  params: unknown
): Promise<void> {
  if ((params as { sessionId?: string })['sessionId'] !== sessionId) return;

  const { requestId, request } = params as {
    requestId: string;
    request: { url: string; headers: Record<string, string> };
  };

  const routes = state.routes.get(targetId) ?? [];
  const match = routes.find((r) => r.regex.test(request.url));

  if (!match) {
    await transport
      .send('Fetch.continueRequest', { requestId }, sessionId)
      .catch((err: unknown) => {
        log.warn('Fetch.continueRequest failed — intercepted request may hang', {
          requestId,
          err,
        });
      });
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
        body: match.body ? uint8ToBase64(new TextEncoder().encode(match.body)) : undefined,
      },
      sessionId
    )
    .catch((err: unknown) => {
      log.warn('Fetch.fulfillRequest failed', { requestId, url: request.url, err });
    });
}

async function enableFetchInterception(
  browser: BrowserAPI,
  onTab: PlaywrightHandlerCtx['onTab'],
  state: PlaywrightState,
  targetId: string
): Promise<void> {
  await onTab(targetId, async ({ sessionId, transport }) => {
    await transport.send('Fetch.enable', { patterns: FETCH_PATTERNS }, sessionId);

    let binding: TabCaptureBinding | undefined;

    const handler = (params: unknown): void => {
      if (!binding) return;
      void handleRequestPaused(binding.transport, binding.sessionId, state, targetId, params);
    };

    try {
      binding = bindTabCapture({
        browser,
        targetId,
        transport,
        sessionId,
        listeners: [['Fetch.requestPaused', handler]],
        enable: (t, s) => t.send('Fetch.enable', { patterns: FETCH_PATTERNS }, s),
      });
    } catch (err) {
      await transport.send('Fetch.disable', {}, sessionId).catch(() => undefined);
      throw err;
    }

    const bound = binding;
    state.routeCleanup.set(targetId, () => {
      bound.stop();
      bound.transport.send('Fetch.disable', {}, bound.sessionId).catch(() => undefined);
    });
  });
}

export const routeHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'route requires a URL pattern\n', exitCode: 1 };
  }

  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  const pattern = positional[0];
  const entry: RouteEntry = {
    pattern,
    regex: patternToRegex(pattern),
    status: flags['status'] ? parseInt(flags['status'], 10) : 200,
    body: flags['body'] ?? '',
    contentType: flags['content-type'] ?? 'text/plain',
    headers: {},
  };

  if (flags['header']) {
    if (flags['header'].includes(',')) {
      log.warn(
        '--header value contains comma — only last segment used. Use separate route calls for multiple headers.'
      );
    }
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
    await enableFetchInterception(browser, onTab, state, tab.targetId);
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
