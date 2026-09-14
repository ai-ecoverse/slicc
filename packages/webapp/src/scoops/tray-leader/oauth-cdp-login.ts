import type { CDPPayload } from '@slicc/shared-ts';

import { createLogger } from '../../base/logger.js';
import type { BrowserAPI } from '../../cdp/browser-api.js';

const log = createLogger('oauth-cdp-login');

const CDP_LOGIN_TIMEOUT_MS = 120_000;

const URL_POLL_INTERVAL_MS = 500;

export interface DelegatedCdpLoginDeps {
  browser: BrowserAPI;

  runtimeId: string;
  authorizeUrl: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface NavigatedFrame {
  url?: string;
  parentId?: string;
}

function navigatedFrameFrom(params: CDPPayload): NavigatedFrame | undefined {
  const raw = params.frame;
  if (raw === null || typeof raw !== 'object') return undefined;
  return raw as NavigatedFrame;
}

export function callbackMatcherFor(authorizeUrl: string): ((url: string) => boolean) | null {
  let redirectUri: string | null;
  try {
    redirectUri = new URL(authorizeUrl).searchParams.get('redirect_uri');
  } catch {
    return null;
  }
  if (!redirectUri) return null;
  let base: string;
  try {
    const parsed = new URL(redirectUri);
    base = `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
  return (candidate: string): boolean => {
    try {
      const parsed = new URL(candidate);
      if (`${parsed.origin}${parsed.pathname}` !== base) return false;

      return (
        parsed.searchParams.has('code') ||
        parsed.searchParams.has('error') ||
        parsed.hash.includes('access_token')
      );
    } catch {
      return false;
    }
  };
}

export function liftNonceFromState(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('nonce')) return rawUrl;
    const raw = url.searchParams.get('state');
    if (!raw) return rawUrl;
    const parsed: unknown = JSON.parse(atob(raw));
    const nonce = (parsed as { nonce?: unknown } | null)?.nonce;
    if (typeof nonce !== 'string' || !nonce) return rawUrl;
    url.searchParams.delete('state');
    url.searchParams.set('nonce', nonce);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

async function readCurrentHref(browser: BrowserAPI, targetId: string): Promise<string | null> {
  try {
    const raw = await browser.withTab(targetId, (page) => page.evaluate('window.location.href'));
    return typeof raw === 'string' ? raw : null;
  } catch {
    return null;
  }
}

export async function runDelegatedCdpLogin(deps: DelegatedCdpLoginDeps): Promise<string | null> {
  const { browser, runtimeId, authorizeUrl, signal } = deps;
  const isCallback = callbackMatcherFor(authorizeUrl);
  if (!isCallback) {
    throw new Error('authorize URL has no redirect_uri to watch for');
  }

  const rawTargetId = await browser.createRemotePage(runtimeId, authorizeUrl);
  const targetId = rawTargetId.includes(':') ? rawTargetId : `${runtimeId}:${rawTargetId}`;
  log.info('Opened delegated login tab on follower', { runtimeId });

  return await new Promise<string | null>((resolve) => {
    const cleanups: Array<() => void> = [];
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();

      void browser.closePage(targetId).catch((err) => {
        log.warn('Could not close delegated login tab', { error: String(err) });
      });
      resolve(typeof value === 'string' ? liftNonceFromState(value) : value);
    };

    void (async () => {
      try {
        const transport = await browser.withTab(targetId, async (page) => {
          await page.send('Page.enable');
          return page.transport;
        });

        const onNavigated = (params: CDPPayload): void => {
          const frame = navigatedFrameFrom(params);
          if (!frame?.url || frame.parentId) return;
          if (isCallback(frame.url)) {
            log.info('Delegated login reached the callback', { via: 'frameNavigated' });
            settle(frame.url);
          }
        };
        transport.on('Page.frameNavigated', onNavigated);
        cleanups.push(() => transport.off('Page.frameNavigated', onNavigated));

        const pollOnce = async (): Promise<void> => {
          if (settled) return;
          const href = await readCurrentHref(browser, targetId);
          if (settled || !href || !isCallback(href)) return;
          log.info('Delegated login reached the callback', { via: 'poll' });
          settle(href);
        };
        const poll = setInterval(() => void pollOnce(), URL_POLL_INTERVAL_MS);
        cleanups.push(() => clearInterval(poll));
      } catch (err) {
        log.warn('Delegated CDP login could not start', { error: String(err) });
        settle(null);
      }
    })();

    const timer = setTimeout(() => {
      log.warn('Delegated CDP login timed out');
      settle(null);
    }, deps.timeoutMs ?? CDP_LOGIN_TIMEOUT_MS);
    cleanups.push(() => clearTimeout(timer));

    const onAbort = (): void => settle(null);
    signal?.addEventListener('abort', onAbort);
    cleanups.push(() => signal?.removeEventListener('abort', onAbort));
    if (signal?.aborted) settle(null);
  });
}
