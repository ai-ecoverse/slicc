import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_FS_DB_NAME } from '../../../src/fs/global-db.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import {
  _testOnly_resetStoreCache,
  deleteServer,
  getServer,
  listServers,
  MCP_STORE_PATH,
  readMcpAuthEntries,
  readMcpAuthEntry,
  readServersFile,
  setServer,
  writeServersFile,
} from '../../../src/shell/mcp/store.js';
import type { McpServerEntry } from '../../../src/shell/mcp/types.js';

describe('mcp store', () => {
  beforeEach(async () => {
    _testOnly_resetStoreCache();
    // Wipe the global FS DB so each test starts clean.
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME, wipe: true });
    // touch a path so LightningFS commits the wipe
    void fs;
  });

  afterEach(async () => {
    // Let LightningFS finish its debounced superblock write.
    await new Promise((r) => setTimeout(r, 600));
    _testOnly_resetStoreCache();
  });

  it('returns an empty file when servers.json is missing', async () => {
    const file = await readServersFile();
    expect(file).toEqual({ version: 1, servers: {} });
  });

  it('round-trips writeServersFile → readServersFile', async () => {
    const entry: McpServerEntry = {
      url: 'https://mcp.example.com',
      sessionId: 'sess-1',
      tools: [{ name: 'echo', description: 'Echo a string' }],
      apps: [{ name: 'demo', title: 'Demo' }],
      addedAt: '2026-05-20T00:00:00.000Z',
      lastRefreshedAt: '2026-05-20T00:00:00.000Z',
      auth: {
        providerId: 'mcp:demo',
        authorizationServer: 'https://auth.example.com',
        clientId: 'abc',
        scope: 'read',
      },
    };
    await writeServersFile({ version: 1, servers: { demo: entry } });
    const loaded = await readServersFile();
    expect(loaded.servers.demo.url).toBe('https://mcp.example.com');
    expect(loaded.servers.demo.tools).toEqual([{ name: 'echo', description: 'Echo a string' }]);
    expect(loaded.servers.demo.auth?.clientId).toBe('abc');
  });

  it('survives an unknown extra field at the top level and on entries', async () => {
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    await fs.mkdir('/workspace/.mcp', { recursive: true });
    const raw = {
      version: 1,
      extraTopLevel: 'ignored',
      servers: {
        demo: {
          url: 'https://mcp.example.com',
          unknownField: { nested: true },
        },
      },
    };
    await fs.writeFile(MCP_STORE_PATH, JSON.stringify(raw));
    const loaded = await readServersFile();
    expect(loaded.version).toBe(1);
    expect(loaded.servers.demo.url).toBe('https://mcp.example.com');
    // Unknown fields on entries are preserved verbatim.
    expect((loaded.servers.demo as unknown as Record<string, unknown>).unknownField).toEqual({
      nested: true,
    });
  });

  it('treats invalid JSON as an empty file (warns but does not throw)', async () => {
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    await fs.mkdir('/workspace/.mcp', { recursive: true });
    await fs.writeFile(MCP_STORE_PATH, 'not json at all');
    const loaded = await readServersFile();
    expect(loaded).toEqual({ version: 1, servers: {} });
  });

  it('drops entries that are missing a url during normalization', async () => {
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    await fs.mkdir('/workspace/.mcp', { recursive: true });
    await fs.writeFile(
      MCP_STORE_PATH,
      JSON.stringify({ version: 1, servers: { broken: { auth: {} } } })
    );
    const loaded = await readServersFile();
    expect(loaded.servers.broken).toBeUndefined();
  });

  it('setServer + getServer + deleteServer behave as expected', async () => {
    await setServer('demo', { url: 'https://a.example' });
    expect((await getServer('demo'))?.url).toBe('https://a.example');
    await setServer('demo', { url: 'https://a.example', sessionId: 'sid-1' });
    expect((await getServer('demo'))?.sessionId).toBe('sid-1');
    expect(await deleteServer('demo')).toBe(true);
    expect(await deleteServer('demo')).toBe(false);
    expect(await getServer('demo')).toBeNull();
  });

  it('listServers returns every entry', async () => {
    await setServer('a', { url: 'https://a.example' });
    await setServer('b', { url: 'https://b.example' });
    const all = await listServers();
    expect(Object.keys(all).sort()).toEqual(['a', 'b']);
  });

  it('readMcpAuthEntry returns null when no auth block is present', async () => {
    await setServer('demo', { url: 'https://a.example' });
    expect(await readMcpAuthEntry('demo')).toBeNull();
  });

  it('readMcpAuthEntry surfaces the auth block when present', async () => {
    await setServer('demo', {
      url: 'https://a.example',
      auth: {
        providerId: 'mcp:demo',
        authorizationServer: 'https://auth.example.com',
        clientId: 'abc',
      },
    });
    const rec = await readMcpAuthEntry('demo');
    expect(rec?.name).toBe('demo');
    expect(rec?.serverUrl).toBe('https://a.example');
    expect(rec?.auth.clientId).toBe('abc');
  });

  it('readMcpAuthEntries skips entries without a complete auth block', async () => {
    await setServer('with-auth', {
      url: 'https://a.example',
      auth: {
        providerId: 'mcp:with-auth',
        authorizationServer: 'https://auth.example.com',
        clientId: 'abc',
      },
    });
    await setServer('no-auth', { url: 'https://b.example' });
    const all = await readMcpAuthEntries();
    expect(all.map((e) => e.name)).toEqual(['with-auth']);
  });
});
