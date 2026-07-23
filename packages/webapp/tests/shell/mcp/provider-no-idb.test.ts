import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getRegisteredProviderConfig,
  unregisterProviderConfig,
} from '../../../src/providers/index.js';
import {
  ensureAllMcpProvidersRegistered,
  ensureMcpProviderRegistered,
  mcpProviderId,
  registerMcpProvider,
  testOnlyResetMcpProviderState,
} from '../../../src/shell/mcp/provider.js';

// These tests run in Vitest's node environment where `indexedDB` is
// not defined. The provider guard short-circuits before any
// LightningFS/VFS code runs, so no unhandled rejection leaks out.

describe('MCP provider registration without indexedDB', () => {
  beforeEach(() => {
    testOnlyResetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('weather'));
    unregisterProviderConfig(mcpProviderId('cached'));
  });

  afterEach(() => {
    testOnlyResetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('weather'));
    unregisterProviderConfig(mcpProviderId('cached'));
  });

  it('confirms indexedDB really is absent in this test environment', () => {
    expect(typeof (globalThis as any).indexedDB).toBe('undefined');
  });

  it('ensureAllMcpProvidersRegistered resolves to [] without touching VFS', async () => {
    const registered = await ensureAllMcpProvidersRegistered();
    expect(registered).toEqual([]);
  });

  it('ensureMcpProviderRegistered resolves to false for an unknown provider', async () => {
    const ok = await ensureMcpProviderRegistered('weather');
    expect(ok).toBe(false);
    expect(getRegisteredProviderConfig(mcpProviderId('weather'))).toBeUndefined();
  });

  it('treats present-but-undefined indexedDB as unavailable', async () => {
    const key = 'indexedDB' as const;
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: undefined,
    });

    try {
      await expect(ensureAllMcpProvidersRegistered()).resolves.toEqual([]);
      await expect(ensureMcpProviderRegistered('weather')).resolves.toBe(false);
    } finally {
      if (prior) {
        Object.defineProperty(globalThis, key, prior);
      } else {
        delete (globalThis as { indexedDB?: unknown }).indexedDB;
      }
    }
  });

  it('still returns true for providers already in the in-session cache', async () => {
    // Populate the session cache via the synchronous registration path —
    // it doesn't touch IDB, so it works even when `indexedDB` is missing.
    registerMcpProvider({
      name: 'cached',
      serverUrl: 'https://mcp.cached.example.com',
      auth: {
        providerId: 'mcp:cached',
        authorizationServer: 'https://auth.cached.example.com',
        clientId: 'client-cached',
      },
    });
    expect(getRegisteredProviderConfig(mcpProviderId('cached'))).toBeDefined();

    const ok = await ensureMcpProviderRegistered('cached');
    expect(ok).toBe(true);
  });
});
