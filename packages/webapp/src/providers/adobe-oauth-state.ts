import { BRIDGE_WS_QUERY_PARAM, isLoopbackHostname } from '@slicc/shared-ts';

export interface BuildAdobeOAuthStateInput {
  pageHref: string;

  pageOrigin: string;

  configuredRedirectUri?: string;
}

export interface BuildAdobeOAuthStateResult {
  redirectUri: string;

  oauthState: string;

  expectedNonce: string;

  source: 'local' | 'opener';
}

export function isWorkerServedSpa(pageHref: string): boolean {
  try {
    const url = new URL(pageHref);
    if (url.searchParams.has(BRIDGE_WS_QUERY_PARAM)) return true;
    return !isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function buildAdobeOAuthState(
  input: BuildAdobeOAuthStateInput,
  nonceFactory: () => string
): BuildAdobeOAuthStateResult {
  const workerServed = isWorkerServedSpa(input.pageHref);
  const nonce = nonceFactory();

  if (workerServed) {
    if (input.configuredRedirectUri) {
      let relayOrigin = '';
      try {
        relayOrigin = new URL(input.configuredRedirectUri).origin;
      } catch {
        relayOrigin = '';
      }

      if (relayOrigin && input.pageOrigin === relayOrigin) {
        const oauthState = btoa(
          JSON.stringify({ source: 'opener', path: '/auth/callback', nonce })
        );
        return {
          redirectUri: input.configuredRedirectUri,
          oauthState,
          expectedNonce: nonce,
          source: 'opener',
        };
      }

      let pageUrl: URL | null = null;
      try {
        pageUrl = new URL(input.pageHref);
      } catch {
        pageUrl = null;
      }
      const isLocalhostWithPort =
        pageUrl !== null &&
        pageUrl.protocol === 'http:' &&
        isLoopbackHostname(pageUrl.hostname) &&
        pageUrl.port !== '';
      if (isLocalhostWithPort && pageUrl) {
        const port = parseInt(pageUrl.port, 10);
        const oauthState = btoa(
          JSON.stringify({ source: 'local', port, path: '/auth/callback', nonce })
        );
        return {
          redirectUri: input.configuredRedirectUri,
          oauthState,
          expectedNonce: nonce,
          source: 'local',
        };
      }
    }

    const redirectUri = `${input.pageOrigin}/auth/callback`;
    const oauthState = btoa(
      JSON.stringify({
        source: 'opener',
        path: '/auth/callback',
        nonce,
      })
    );
    return { redirectUri, oauthState, expectedNonce: nonce, source: 'opener' };
  }

  const redirectUri = input.configuredRedirectUri ?? `${input.pageOrigin}/auth/callback`;
  const port = parseInt(new URL(input.pageHref).port || '5710', 10);
  const oauthState = btoa(
    JSON.stringify({
      port,
      path: '/auth/callback',
      nonce,
    })
  );
  return { redirectUri, oauthState, expectedNonce: nonce, source: 'local' };
}
