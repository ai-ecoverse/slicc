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
  it('emits source:"opener" and pins redirect_uri to the page origin', () => {
    const result = buildAdobeOAuthState(
      {
        pageHref: 'http://localhost:8787/?bridge=ws://localhost:5710/cdp',
        pageOrigin: 'http://localhost:8787',
        configuredRedirectUri: 'https://www.sliccy.ai/auth/callback',
      },
      nonce
    );
    expect(result.source).toBe('opener');
    expect(result.redirectUri).toBe('http://localhost:8787/auth/callback');
    const decoded = JSON.parse(atob(result.oauthState));
    expect(decoded.source).toBe('opener');
    expect(decoded.path).toBe('/auth/callback');
    expect(decoded.nonce).toBe('fixed-nonce');
    expect(decoded.port).toBeUndefined();
    expect(result.expectedNonce).toBe('fixed-nonce');
  });

  it('ignores configuredRedirectUri in worker-served mode (would break opener delivery)', () => {
    const result = buildAdobeOAuthState(
      {
        pageHref: 'https://www.sliccy.ai/?bridge=wss://host/cdp&bridgeToken=t',
        pageOrigin: 'https://www.sliccy.ai',
        configuredRedirectUri: 'https://elsewhere.example/auth/callback',
      },
      nonce
    );
    expect(result.redirectUri).toBe('https://www.sliccy.ai/auth/callback');
    expect(result.source).toBe('opener');
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
