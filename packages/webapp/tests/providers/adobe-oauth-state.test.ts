import { describe, expect, it } from 'vitest';
import { buildAdobeOAuthState, isWorkerServedSpa } from '../../src/providers/adobe-oauth-state.js';

const nonce = () => 'fixed-nonce';

describe('isWorkerServedSpa', () => {
  it('returns true when the bridge query param is present', () => {
    expect(isWorkerServedSpa('http://localhost:8787/?bridge=ws://localhost:5710/cdp')).toBe(true);
  });

  it('returns true on sliccy.ai with bridge param (hosted-leader)', () => {
    expect(isWorkerServedSpa('https://www.sliccy.ai/?bridge=wss://host/cdp&bridgeToken=t')).toBe(
      true
    );
  });

  it('returns false on a classic CLI URL (no bridge param)', () => {
    expect(isWorkerServedSpa('http://localhost:5710/')).toBe(false);
  });

  it('returns false for a malformed URL rather than throwing', () => {
    expect(isWorkerServedSpa('not a url')).toBe(false);
  });
});

describe('buildAdobeOAuthState — worker-served (thin-bridge / hosted-leader)', () => {
  it('hosted-leader (page IS the prod relay): source:"opener", redirect_uri = configured prod relay', () => {
    const result = buildAdobeOAuthState(
      {
        pageHref: 'https://www.sliccy.ai/?bridge=wss://host/cdp&bridgeToken=t',
        pageOrigin: 'https://www.sliccy.ai',
        configuredRedirectUri: 'https://www.sliccy.ai/auth/callback',
      },
      nonce
    );
    expect(result.source).toBe('opener');
    expect(result.redirectUri).toBe('https://www.sliccy.ai/auth/callback');
    const decoded = JSON.parse(atob(result.oauthState));
    expect(decoded).toEqual({ source: 'opener', path: '/auth/callback', nonce: 'fixed-nonce' });
    expect(result.expectedNonce).toBe('fixed-nonce');
  });

  it('wrangler dev (localhost:8787): source:"local", port 8787, redirect_uri = prod relay (trampoline)', () => {
    const result = buildAdobeOAuthState(
      {
        pageHref: 'http://localhost:8787/?bridge=ws://localhost:5710/cdp',
        pageOrigin: 'http://localhost:8787',
        configuredRedirectUri: 'https://www.sliccy.ai/auth/callback',
      },
      nonce
    );
    expect(result.source).toBe('local');
    // redirect_uri MUST be the prod relay — the only origin IMS allowlists.
    expect(result.redirectUri).toBe('https://www.sliccy.ai/auth/callback');
    const decoded = JSON.parse(atob(result.oauthState));
    expect(decoded).toEqual({
      source: 'local',
      port: 8787,
      path: '/auth/callback',
      nonce: 'fixed-nonce',
    });
    expect(result.expectedNonce).toBe('fixed-nonce');
  });

  it('wrangler dev on 127.0.0.1 also trampolines via prod relay', () => {
    const result = buildAdobeOAuthState(
      {
        pageHref: 'http://127.0.0.1:8787/?bridge=ws://127.0.0.1:5710/cdp',
        pageOrigin: 'http://127.0.0.1:8787',
        configuredRedirectUri: 'https://www.sliccy.ai/auth/callback',
      },
      nonce
    );
    expect(result.source).toBe('local');
    expect(result.redirectUri).toBe('https://www.sliccy.ai/auth/callback');
    const decoded = JSON.parse(atob(result.oauthState));
    expect(decoded.source).toBe('local');
    expect(decoded.port).toBe(8787);
  });

  it('preserves the wrangler-dev port (e.g. 5720) instead of hardcoding 8787', () => {
    const result = buildAdobeOAuthState(
      {
        pageHref: 'http://localhost:5720/?bridge=ws://localhost:5721/cdp',
        pageOrigin: 'http://localhost:5720',
        configuredRedirectUri: 'https://www.sliccy.ai/auth/callback',
      },
      nonce
    );
    const decoded = JSON.parse(atob(result.oauthState));
    expect(decoded.source).toBe('local');
    expect(decoded.port).toBe(5720);
    expect(result.redirectUri).toBe('https://www.sliccy.ai/auth/callback');
  });

  it('falls back to degraded opener path when configuredRedirectUri is absent', () => {
    const result = buildAdobeOAuthState(
      {
        pageHref: 'http://localhost:8787/?bridge=ws://localhost:5710/cdp',
        pageOrigin: 'http://localhost:8787',
        // no configuredRedirectUri
      },
      nonce
    );
    expect(result.source).toBe('opener');
    expect(result.redirectUri).toBe('http://localhost:8787/auth/callback');
    const decoded = JSON.parse(atob(result.oauthState));
    expect(decoded).toEqual({ source: 'opener', path: '/auth/callback', nonce: 'fixed-nonce' });
  });
});

describe('buildAdobeOAuthState — classic CLI (node-server-served SPA)', () => {
  it('emits source:"local" and the legacy { port, path, nonce } state shape', () => {
    const result = buildAdobeOAuthState(
      {
        pageHref: 'http://localhost:5710/',
        pageOrigin: 'http://localhost:5710',
      },
      nonce
    );
    expect(result.source).toBe('local');
    const decoded = JSON.parse(atob(result.oauthState));
    expect(decoded).toEqual({ port: 5710, path: '/auth/callback', nonce: 'fixed-nonce' });
    expect(decoded.source).toBeUndefined();
    expect(result.expectedNonce).toBe('fixed-nonce');
  });

  it('honors configuredRedirectUri in classic CLI mode', () => {
    const result = buildAdobeOAuthState(
      {
        pageHref: 'http://localhost:5710/',
        pageOrigin: 'http://localhost:5710',
        configuredRedirectUri: 'https://www.sliccy.ai/auth/callback',
      },
      nonce
    );
    expect(result.redirectUri).toBe('https://www.sliccy.ai/auth/callback');
    expect(result.source).toBe('local');
  });

  it('defaults to port 5710 when the URL has no explicit port', () => {
    const result = buildAdobeOAuthState(
      {
        pageHref: 'http://localhost/',
        pageOrigin: 'http://localhost',
      },
      nonce
    );
    const decoded = JSON.parse(atob(result.oauthState));
    expect(decoded.port).toBe(5710);
  });

  it('preserves a non-default port in state', () => {
    const result = buildAdobeOAuthState(
      {
        pageHref: 'http://localhost:5720/',
        pageOrigin: 'http://localhost:5720',
      },
      nonce
    );
    const decoded = JSON.parse(atob(result.oauthState));
    expect(decoded.port).toBe(5720);
  });
});
