import { createLogger } from '../base/logger.js';
import {
  createOwnTabMatcher,
  type DiscoveryEvent,
  NavigationWatcher,
} from '../cdp/navigation-watcher.js';
import type { CDPTransport } from '../cdp/transport.js';
import { getDiscoveryEnabled } from '../core/discovery-preference.js';
import type { ProbeFetch } from '../net/well-known-probe.js';
import type { LickEvent } from '../scoops/lick-manager.js';
import { createProxiedFetch } from '../shell/proxied-fetch.js';

const log = createLogger('follower-navigate-watcher');

interface ForwardSync {
  forwardLick(event: LickEvent): boolean;
}

function buildFollowerDiscoveryOptions(getSync: () => ForwardSync | null): {
  onDiscovery: (event: DiscoveryEvent) => void;
  probeFetch: ProbeFetch;
  isDiscoveryEnabled: () => boolean;
} {
  const proxiedFetch = createProxiedFetch();

  const probeFetch: ProbeFetch = async (url, init) => {
    const doFetch = proxiedFetch(url, { method: init?.method ?? 'GET' });
    const signal = init?.signal;
    const res = signal
      ? await Promise.race([
          doFetch,
          new Promise<never>((_resolve, reject) => {
            if (signal.aborted) {
              reject(new Error('aborted'));
              return;
            }
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        ])
      : await doFetch;
    const headers = res.headers as Record<string, string> | undefined;
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: {
        get(name: string): string | null {
          if (!headers) return null;

          return headers[name.toLowerCase()] ?? headers[name] ?? null;
        },
      },
    };
  };

  return {
    onDiscovery: (event: DiscoveryEvent) => {
      const sync = getSync();
      if (!sync) {
        log.warn('discovery lick dropped — no follower sync connected', { url: event.url });
        return;
      }
      sync.forwardLick({
        type: 'discovery',
        targetScoop: undefined,
        timestamp: new Date().toISOString(),
        discoveryOrigin: event.origin,
        discoveryKind: event.kind,
        discoveryUrl: event.url,
        discoverySource: 'live-navigation',
        body: {
          origin: event.origin,
          kind: event.kind,
          url: event.url,
          targetId: event.targetId,
        },
      });
    },
    probeFetch,

    isDiscoveryEnabled: () => getDiscoveryEnabled(),
  };
}

interface NavigateLickBody {
  url: string;
  verb: string;
  target: string;
  instruction?: string;
  branch?: string;
  path?: string;
  title?: string;
}

export function startFollowerNavigateWatcher(
  transport: CDPTransport,
  getSync: () => ForwardSync | null
): () => void {
  const watcher = new NavigationWatcher(
    transport,
    (event) => {
      const body: NavigateLickBody = {
        url: event.url,
        verb: event.verb,
        target: event.target,
      };
      if (event.instruction != null) body.instruction = event.instruction;
      if (event.branch != null) body.branch = event.branch;
      if (event.path != null) body.path = event.path;
      if (event.title != null) body.title = event.title;
      const sync = getSync();
      if (!sync) {
        log.warn('navigate lick dropped — no follower sync connected', { url: event.url });
        return;
      }
      sync.forwardLick({
        type: 'navigate',
        navigateUrl: event.url,
        targetScoop: undefined,
        timestamp: new Date().toISOString(),
        body,
      });
    },
    {
      ...buildFollowerDiscoveryOptions(getSync),

      isOwnTab: createOwnTabMatcher(() => globalThis.location?.href ?? null),
    }
  );
  void watcher.start();
  return () => void watcher.stop();
}
