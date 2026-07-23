import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getRegisteredProviderConfig,
  unregisterProviderConfig,
} from '../../../src/providers/index.js';
import {
  ensureMcpProviderRegistered,
  mcpProviderId,
  registerMcpProvider,
  removeMcpProvider,
  testOnlyResetMcpProviderState,
} from '../../../src/shell/mcp/provider.js';
import {
  testOnlyResetStoreCache,
  testOnlySetFsModule,
} from '../../../src/shell/mcp/provider-store-access.js';

// ── Stub fs module ─────────────────────────────────────────────────
//
// `provider-store-access` reads `/workspace/.mcp/servers.json` through a
// `VirtualFS.create(...).readFile(...)` chain. We inject a minimal stub
// instead of standing up a real LightningFS/IndexedDB instance so the
// idempotence test stays a pure unit test.

function makeFakeFsModule(storeJson: string | null) {
  const fakeFs = {
    readFile: async (path: string) => {
      if (path !== '/workspace/.mcp/servers.json' || storeJson === null) {
        throw new Error('ENOENT');
      }
      return storeJson;
    },
  };
  return {
    VirtualFS: {
      create: async () => fakeFs,
    },
  } as unknown as typeof import('../../../src/fs/index.js');
}

const SERVERS_JSON = JSON.stringify({
  version: 1,
  servers: {
    weather: {
      url: 'https://mcp.weather.example.com',
      auth: {
        providerId: 'mcp:weather',
        authorizationServer: 'https://auth.weather.example.com',
        clientId: 'client-abc',
        scope: 'read',
      },
    },
  },
});

describe('ensureMcpProviderRegistered', () => {
  let hadIndexedDB = false;
  let originalIndexedDB: unknown;

  beforeEach(() => {
    testOnlyResetMcpProviderState();
    testOnlyResetStoreCache();
    // Drop any registry entry left over from a previous test run.
    unregisterProviderConfig(mcpProviderId('weather'));
    // The guard in `ensureMcpProviderRegistered` short-circuits when
    // `globalThis.indexedDB` is missing. These tests stub the FS module
    // directly, so we mark IDB as "present" with a sentinel to take the
    // FS-reading path.
    hadIndexedDB = 'indexedDB' in globalThis;
    originalIndexedDB = (globalThis as any).indexedDB;
    (globalThis as any).indexedDB = {};
  });

  afterEach(() => {
    testOnlySetFsModule(null);
    testOnlyResetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('weather'));
    if (hadIndexedDB) {
      (globalThis as any).indexedDB = originalIndexedDB;
    } else {
      delete (globalThis as any).indexedDB;
    }
  });

  it('registers the provider on first call and is a no-op on subsequent calls', async () => {
    testOnlySetFsModule(makeFakeFsModule(SERVERS_JSON));

    const first = await ensureMcpProviderRegistered('weather');
    expect(first).toBe(true);
    const cfgFirst = getRegisteredProviderConfig(mcpProviderId('weather'));
    expect(cfgFirst).toBeDefined();
    expect(cfgFirst?.id).toBe('mcp:weather');
    expect(cfgFirst?.isOAuth).toBe(true);

    const second = await ensureMcpProviderRegistered('weather');
    expect(second).toBe(true);
    const cfgSecond = getRegisteredProviderConfig(mcpProviderId('weather'));
    // Same reference — the in-session cache short-circuits before
    // `buildProviderConfig` runs again.
    expect(cfgSecond).toBe(cfgFirst);
  });

  it('returns false when the server has no persisted auth entry', async () => {
    testOnlySetFsModule(makeFakeFsModule(null));
    const ok = await ensureMcpProviderRegistered('weather');
    expect(ok).toBe(false);
    expect(getRegisteredProviderConfig(mcpProviderId('weather'))).toBeUndefined();
  });

  it('re-registers after removeMcpProvider clears the session cache', async () => {
    testOnlySetFsModule(makeFakeFsModule(SERVERS_JSON));

    await ensureMcpProviderRegistered('weather');
    expect(getRegisteredProviderConfig(mcpProviderId('weather'))).toBeDefined();

    const removed = removeMcpProvider('weather');
    expect(removed).toBe(true);
    expect(getRegisteredProviderConfig(mcpProviderId('weather'))).toBeUndefined();

    const reRegistered = await ensureMcpProviderRegistered('weather');
    expect(reRegistered).toBe(true);
    expect(getRegisteredProviderConfig(mcpProviderId('weather'))).toBeDefined();
  });
});

describe('registerMcpProvider', () => {
  beforeEach(() => {
    testOnlyResetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('synthetic'));
  });

  afterEach(() => {
    testOnlyResetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('synthetic'));
  });

  it('is idempotent — second call leaves the registry entry unchanged', () => {
    registerMcpProvider({
      name: 'synthetic',
      serverUrl: 'https://mcp.synth.example.com',
      auth: {
        providerId: 'mcp:synthetic',
        authorizationServer: 'https://auth.synth.example.com',
        clientId: 'c1',
      },
    });
    const first = getRegisteredProviderConfig(mcpProviderId('synthetic'));
    expect(first).toBeDefined();

    registerMcpProvider({
      name: 'synthetic',
      serverUrl: 'https://mcp.synth.example.com',
      auth: {
        providerId: 'mcp:synthetic',
        authorizationServer: 'https://auth.synth.example.com',
        clientId: 'c1',
      },
    });
    const second = getRegisteredProviderConfig(mcpProviderId('synthetic'));
    expect(second).toBe(first);
  });
});
