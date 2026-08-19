import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocked collaborators of resolveMcpRedirectUri. The module resolves topology
// from the shell layer and lazily imports the proxied-fetch / oauth-service
// helpers, so each branch is exercised by controlling these returns.
const resolveFloatTopology = vi.fn();
const getLocalApiBaseUrl = vi.fn();
const getOAuthPageOrigin = vi.fn();

vi.mock('../../../src/shell/float-topology.js', () => ({
  resolveFloatTopology: () => resolveFloatTopology(),
}));
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
    resolveFloatTopology.mockReset();
    getLocalApiBaseUrl.mockReset();
    getOAuthPageOrigin.mockReset();
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  });

  it('uses chrome.identity.getRedirectURL for extension-direct', async () => {
    resolveFloatTopology.mockReturnValue('extension-direct');
    (globalThis as { chrome?: unknown }).chrome = {
      identity: { getRedirectURL: (path?: string) => `https://ext-id.chromiumapp.org/${path}` },
    };
    expect(await resolveMcpRedirectUri()).toBe('https://ext-id.chromiumapp.org/mcp-callback');
  });

  it('falls back to runtime.id origin when identity API is unavailable', async () => {
    resolveFloatTopology.mockReturnValue('extension-direct');
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'abc123' } };
    expect(await resolveMcpRedirectUri()).toBe('https://abc123.chromiumapp.org/mcp-callback');
  });

  it('uses the local API origin for node-rest when present', async () => {
    resolveFloatTopology.mockReturnValue('node-rest');
    getLocalApiBaseUrl.mockReturnValue('http://localhost:5710');
    expect(await resolveMcpRedirectUri()).toBe('http://localhost:5710/auth/callback');
  });

  it('falls back to the OAuth page origin when node-rest has no local API', async () => {
    resolveFloatTopology.mockReturnValue('node-rest');
    getLocalApiBaseUrl.mockReturnValue('');
    getOAuthPageOrigin.mockResolvedValue({ origin: 'https://hosted.example' });
    expect(await resolveMcpRedirectUri()).toBe('https://hosted.example/auth/callback');
  });

  it('uses the hosted MCP callback path for extension-delegate', async () => {
    resolveFloatTopology.mockReturnValue('extension-delegate');
    getOAuthPageOrigin.mockResolvedValue({ origin: 'https://hosted.example' });
    expect(await resolveMcpRedirectUri()).toBe(`https://hosted.example${MCP_HOSTED_CALLBACK_PATH}`);
  });

  it('uses the plain callback path for connect topology', async () => {
    resolveFloatTopology.mockReturnValue('connect');
    getOAuthPageOrigin.mockResolvedValue({ origin: 'https://hosted.example' });
    expect(await resolveMcpRedirectUri()).toBe('https://hosted.example/auth/callback');
  });
});
