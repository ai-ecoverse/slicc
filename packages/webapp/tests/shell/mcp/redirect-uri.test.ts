import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocked collaborators of resolveMcpRedirectUri. Topology is injected
// directly by the caller (#2276) rather than probed from inside this module,
// so each branch is exercised by passing the topology in and controlling
// these lazily-imported returns.
const getLocalApiBaseUrl = vi.fn();
const getOAuthPageOrigin = vi.fn();

vi.mock('../../../src/shell/proxied-fetch.js', () => ({
  getLocalApiBaseUrl: () => getLocalApiBaseUrl(),
}));
vi.mock('../../../src/providers/oauth-service.js', () => ({
  getOAuthPageOrigin: () => getOAuthPageOrigin(),
}));

import {
  MCP_HOSTED_CALLBACK_PATH,
  resolveMcpRedirectUri,
} from '../../../src/shell/mcp/redirect-uri.js';

describe('resolveMcpRedirectUri', () => {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;

  beforeEach(() => {
    getLocalApiBaseUrl.mockReset();
    getOAuthPageOrigin.mockReset();
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  });

  it('uses chrome.identity.getRedirectURL for extension-direct', async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      identity: { getRedirectURL: (path?: string) => `https://ext-id.chromiumapp.org/${path}` },
    };
    expect(await resolveMcpRedirectUri('extension-direct')).toBe(
      'https://ext-id.chromiumapp.org/mcp-callback'
    );
  });

  it('falls back to runtime.id origin when identity API is unavailable', async () => {
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'abc123' } };
    expect(await resolveMcpRedirectUri('extension-direct')).toBe(
      'https://abc123.chromiumapp.org/mcp-callback'
    );
  });

  it('uses the local API origin for node-rest when present', async () => {
    getLocalApiBaseUrl.mockReturnValue('http://localhost:5710');
    expect(await resolveMcpRedirectUri('node-rest')).toBe('http://localhost:5710/auth/callback');
  });

  it('falls back to the OAuth page origin when node-rest has no local API', async () => {
    getLocalApiBaseUrl.mockReturnValue('');
    getOAuthPageOrigin.mockResolvedValue({ origin: 'https://hosted.example' });
    expect(await resolveMcpRedirectUri('node-rest')).toBe('https://hosted.example/auth/callback');
  });

  it('uses the hosted MCP callback path for extension-delegate', async () => {
    getOAuthPageOrigin.mockResolvedValue({ origin: 'https://hosted.example' });
    expect(await resolveMcpRedirectUri('extension-delegate')).toBe(
      `https://hosted.example${MCP_HOSTED_CALLBACK_PATH}`
    );
  });

  it('uses the plain callback path for connect topology', async () => {
    getOAuthPageOrigin.mockResolvedValue({ origin: 'https://hosted.example' });
    expect(await resolveMcpRedirectUri('connect')).toBe('https://hosted.example/auth/callback');
  });
});
