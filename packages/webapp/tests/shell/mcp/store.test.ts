import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_FS_DB_NAME } from '../../../src/fs/global-db.js';
import { FsError } from '../../../src/fs/types.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import {
  deleteServer,
  getServer,
  listServers,
  MCP_STORE_PATH,
  readMcpAuthEntries,
  readMcpAuthEntry,
  readServersFile,
  setServer,
  testOnlyResetStoreCache,
  writeServersFile,
} from '../../../src/shell/mcp/store.js';
import type { McpServerEntry } from '../../../src/shell/mcp/types.js';

function faultingMcpFs(code: 'ENOENT' | 'EIO' | 'EACCES') {
  const writes: string[] = [];
  return {
    writes,
    fs: {
      async readFile(): Promise<string> {
        throw new FsError(code, `${code} reading MCP registry`, MCP_STORE_PATH);
      },
      async writeFile(_path: string, content: string | Uint8Array): Promise<void> {
        writes.push(typeof content === 'string' ? content : 'binary');
      },
      async mkdir(): Promise<void> {},
    },
  };
}

describe('mcp store', () => {
  beforeEach(async () => {
    testOnlyResetStoreCache();
    // Wipe the global FS DB so each test starts clean.
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME, wipe: true });
    // touch a path so LightningFS commits the wipe
    void fs;
  });

  afterEach(async () => {
    // Let LightningFS finish its debounced superblock write.
    await new Promise((r) => setTimeout(r, 600));
    testOnlyResetStoreCache();
  });

  it('returns an empty file when servers.json is missing', async () => {
    const file = await readServersFile();
    expect(file).toEqual({ version: 1, servers: {} });
  });

  it('round-trips writeServersFile → readServersFile', async () => {
    const entry: McpServerEntry = {
      url: 'https://mcp.example.com',
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
    await setServer('demo', { url: 'https://a.example', tools: [{ name: 'echo' }] });
    expect((await getServer('demo'))?.tools).toEqual([{ name: 'echo' }]);
    expect(await deleteServer('demo')).toBe(true);
    expect(await deleteServer('demo')).toBe(false);
    expect(await getServer('demo')).toBeNull();
  });

  it('tolerates legacy sessionId fields but scrubs them from reads and writes', async () => {
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    await fs.mkdir('/workspace/.mcp', { recursive: true });
    const legacyEntry = {
      url: 'https://mcp.example.com',
      sessionId: 'stale-session',
      unknownField: 'preserved',
    };
    await fs.writeFile(
      MCP_STORE_PATH,
      JSON.stringify({ version: 1, servers: { demo: legacyEntry } })
    );

    const loaded = await readServersFile();
    expect((loaded.servers.demo as unknown as Record<string, unknown>).sessionId).toBeUndefined();
    expect((loaded.servers.demo as unknown as Record<string, unknown>).unknownField).toBe(
      'preserved'
    );

    await writeServersFile({
      version: 1,
      servers: { demo: legacyEntry as unknown as McpServerEntry },
    });
    let raw = JSON.parse((await fs.readFile(MCP_STORE_PATH, { encoding: 'utf-8' })) as string) as {
      servers: Record<string, Record<string, unknown>>;
    };
    expect(raw.servers.demo.sessionId).toBeUndefined();

    await fs.writeFile(
      MCP_STORE_PATH,
      JSON.stringify({ version: 1, servers: { demo: legacyEntry } })
    );
    await setServer('demo', { url: legacyEntry.url, tools: [{ name: 'echo' }] });
    raw = JSON.parse((await fs.readFile(MCP_STORE_PATH, { encoding: 'utf-8' })) as string) as {
      servers: Record<string, Record<string, unknown>>;
    };
    expect(raw.servers.demo.sessionId).toBeUndefined();
    expect(raw.servers.demo.unknownField).toBe('preserved');
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

describe('mcp store read-modify-write faults', () => {
  it('readServersFile treats ENOENT as empty and does not write', async () => {
    const { fs, writes } = faultingMcpFs('ENOENT');
    await expect(readServersFile(fs)).resolves.toEqual({ version: 1, servers: {} });
    expect(writes).toEqual([]);
  });

  it('readServersFile treats invalid JSON as empty', async () => {
    const writes: string[] = [];
    const fs = {
      async readFile(): Promise<string> {
        return 'not json at all';
      },
      async writeFile(_path: string, content: string | Uint8Array): Promise<void> {
        writes.push(typeof content === 'string' ? content : 'binary');
      },
      async mkdir(): Promise<void> {},
    };
    await expect(readServersFile(fs)).resolves.toEqual({ version: 1, servers: {} });
    expect(writes).toEqual([]);
  });

  it('setServer from ENOENT writes the new entry onto an empty registry', async () => {
    const { fs, writes } = faultingMcpFs('ENOENT');
    await setServer('foo', { url: 'https://foo.example' }, fs);
    expect(writes).toHaveLength(1);
    const payload = JSON.parse(writes[0]) as { servers: Record<string, { url: string }> };
    expect(payload.servers.foo.url).toBe('https://foo.example');
  });

  it('setServer propagates a non-ENOENT FsError and does not truncate the registry', async () => {
    const { fs, writes } = faultingMcpFs('EIO');
    await expect(setServer('foo', { url: 'https://foo.example' }, fs)).rejects.toThrow(
      'EIO reading MCP registry'
    );
    expect(writes).toEqual([]);
  });

  it('deleteServer propagates a non-ENOENT FsError and does not truncate the registry', async () => {
    const { fs, writes } = faultingMcpFs('EACCES');
    await expect(deleteServer('foo', fs)).rejects.toThrow('EACCES reading MCP registry');
    expect(writes).toEqual([]);
  });
});
