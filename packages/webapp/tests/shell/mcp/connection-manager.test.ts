import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deduplicateToolNames,
  type McpConnection,
  McpConnectionManager,
  mcpAgentToolName,
  mcpAgentToolNames,
  resolveToolExposure,
} from '../../../src/shell/mcp/connection-manager.js';
import type { McpFetchLike, McpServerEntry } from '../../../src/shell/mcp/types.js';

function stubFetchLike(
  responder?: (url: string) => { status: number; body: string }
): McpFetchLike {
  return async (url, init) => {
    const r = responder?.(url) ?? { status: 200, body: '{}' };
    return {
      status: r.status,
      statusText: r.status === 200 ? 'OK' : 'Error',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(r.body),
    };
  };
}

function jsonRpc(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function makeDiscoverResponse(id: number): string {
  return jsonRpc(id, { supportedVersions: ['2026-07-28', '2025-06-18'] });
}

function makeEntry(overrides?: Partial<McpServerEntry>): McpServerEntry {
  return {
    url: 'https://mcp.example.com/sse',
    ...overrides,
  };
}

describe('mcpAgentToolName', () => {
  it('produces mcp__server__tool format', () => {
    expect(mcpAgentToolName('weather', 'get-forecast')).toBe('mcp__weather__get_forecast');
  });

  it('sanitizes non-alphanumeric characters', () => {
    expect(mcpAgentToolName('my server', 'get/data')).toBe('mcp__my_server__get_data');
  });

  it('truncates to 64 characters', () => {
    const longServer = 'a'.repeat(30);
    const longTool = 'b'.repeat(30);
    const result = mcpAgentToolName(longServer, longTool);
    expect(result.length).toBeLessThanOrEqual(64);
    expect(result.startsWith('mcp__')).toBe(true);
  });

  it('hashes both tools when hyphens and underscores normalize to the same name', () => {
    const names = mcpAgentToolNames('my-server', ['read-file', 'read_file']);
    expect(names.get('read-file')).toMatch(/^mcp__my_server__read_file_[0-9a-f]{8}$/);
    expect(names.get('read_file')).toMatch(/^mcp__my_server__read_file_[0-9a-f]{8}$/);
    expect(names.get('read-file')).not.toBe(names.get('read_file'));
    expect(mcpAgentToolNames('my-server', ['read_file', 'read-file']).get('read-file')).toBe(
      names.get('read-file')
    );
  });

  it('reserves original names before assigning collision suffixes', () => {
    const initial = mcpAgentToolNames('my-server', ['read-file', 'read_file']);
    const third = `read_file_${initial.get('read-file')!.slice(-8)}`;
    const wireNames = ['read-file', 'read_file', third];
    const names = mcpAgentToolNames('my-server', wireNames);
    expect(new Set(names.values()).size).toBe(3);
    expect(names.get(third)).toBe(mcpAgentToolName('my-server', third));
    expect(mcpAgentToolNames('my-server', [...wireNames].reverse()).get('read-file')).toBe(
      names.get('read-file')
    );
  });

  it('rejects duplicate wire tool names', () => {
    expect(() => mcpAgentToolNames('my-server', ['read-file', 'read-file'])).toThrow(
      'duplicate tool names'
    );
  });
});

describe('resolveToolExposure', () => {
  it('returns server default when no overrides', () => {
    expect(resolveToolExposure('foo', 'direct', undefined)).toBe('direct');
  });

  it('defaults to codemode when no exposure set', () => {
    expect(resolveToolExposure('foo', undefined, undefined)).toBe('codemode');
  });

  it('per-tool override wins', () => {
    expect(resolveToolExposure('get-data', 'codemode', { 'get-*': 'direct' })).toBe('direct');
  });

  it('exact match wins', () => {
    expect(
      resolveToolExposure('get-data', 'codemode', { '*': 'hidden', 'get-data': 'direct' })
    ).toBe('direct');
  });

  it('wildcard matches all', () => {
    expect(resolveToolExposure('anything', 'codemode', { '*': 'hidden' })).toBe('hidden');
  });

  it('more-specific pattern wins regardless of order', () => {
    expect(resolveToolExposure('get-data', 'codemode', { '*': 'hidden', 'get-*': 'direct' })).toBe(
      'direct'
    );
    expect(resolveToolExposure('get-data', 'codemode', { 'get-*': 'direct', '*': 'hidden' })).toBe(
      'direct'
    );
  });

  it('exact match beats prefix glob', () => {
    expect(
      resolveToolExposure('delete_all', 'codemode', { '*': 'direct', delete_all: 'hidden' })
    ).toBe('hidden');
  });

  it('non-matching pattern falls through to server default', () => {
    expect(resolveToolExposure('list-items', 'direct', { 'get-*': 'hidden' })).toBe('direct');
  });
});

describe('McpConnectionManager', () => {
  let manager: McpConnectionManager;
  let fetchCalls: Array<{ url: string }>;

  beforeEach(() => {
    fetchCalls = [];
    const fetchImpl = stubFetchLike((url) => {
      fetchCalls.push({ url });
      return {
        status: 200,
        body: jsonRpc(1, { supportedVersions: ['2026-07-28', '2025-06-18'] }),
      };
    });

    manager = new McpConnectionManager({
      getMcpFetchLike: async () => fetchImpl,
    });
  });

  it('connect creates a connection for a slicc-transport server', async () => {
    const entry = makeEntry({ transport: 'slicc' });

    vi.doMock('../../../src/shell/mcp/client.js', () => ({
      McpClient: class MockMcpClient {
        async initialize() {}
        async toolsList() {
          return [{ name: 'test-tool', description: 'A test tool' }];
        }
        async toolsCall(name: string, args: unknown) {
          return { content: [{ type: 'text', text: 'result' }] };
        }
        async appsList() {
          return [];
        }
        getNegotiatedProtocolVersion() {
          return '2026-07-28';
        }
      },
      wrapProxiedFetchAsMcpFetch: (fn: unknown) => fn,
    }));

    const { connection, transport } = await manager.connect('test', entry);
    expect(transport).toBe('slicc');
    expect(connection.serverName).toBe('test');
    expect(connection.serverUrl).toBe('https://mcp.example.com/sse');
    expect(manager.has('test')).toBe(true);
  });

  it('get returns undefined for unknown servers', () => {
    expect(manager.get('nonexistent')).toBeUndefined();
  });

  it('has returns false for unknown servers', () => {
    expect(manager.has('nonexistent')).toBe(false);
  });

  it('does not connect a second server with the same normalized namespace', async () => {
    await manager.connect('dev-radius', makeEntry({ transport: 'slicc' }));
    await expect(manager.connect('dev_radius', makeEntry({ transport: 'slicc' }))).rejects.toThrow(
      'conflicts with "dev-radius"'
    );
  });

  it('disconnect removes a connection', async () => {
    const mockConnection: McpConnection = {
      serverName: 'test',
      serverUrl: 'https://mcp.example.com/sse',
      listTools: async () => [],
      callTool: async () => ({ content: [], isError: false }),
      close: vi.fn(async () => {}),
    };

    const entry = makeEntry({ transport: 'slicc' });
    await manager.connect('test', entry).catch(() => {});

    await manager.disconnect('test');
    expect(manager.has('test')).toBe(false);
  });

  it('emits tools-changed on disconnect', async () => {
    const listener = vi.fn();
    manager.onToolsChanged(listener);

    await manager.disconnect('test');

    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribe removes the listener', () => {
    const listener = vi.fn();
    const unsub = manager.onToolsChanged(listener);
    unsub();

    expect(listener).not.toHaveBeenCalled();
  });

  it('slicc-transport callTool aborts mid-flight when signal fires', async () => {
    const entry = makeEntry({ transport: 'slicc' });
    let resolveToolsCall!: (v: unknown) => void;
    const hangingPromise = new Promise((resolve) => {
      resolveToolsCall = resolve;
    });

    vi.doMock('../../../src/shell/mcp/client.js', () => ({
      McpClient: class MockMcpClient {
        async initialize() {}
        async toolsList() {
          return [{ name: 'slow-tool', description: 'hangs' }];
        }
        async toolsCall() {
          return hangingPromise;
        }
        async appsList() {
          return [];
        }
        getNegotiatedProtocolVersion() {
          return '2026-07-28';
        }
      },
      wrapProxiedFetchAsMcpFetch: (fn: unknown) => fn,
    }));

    const { connection } = await manager.connect('slow', entry);
    const controller = new AbortController();

    const callPromise = connection.callTool('slow-tool', {}, { signal: controller.signal });
    controller.abort();

    await expect(callPromise).rejects.toThrow(DOMException);
    await expect(callPromise).rejects.toMatchObject({ name: 'AbortError' });

    resolveToolsCall({ content: [] });
  });
});

describe('deduplicateToolNames', () => {
  it('passes unique names through unchanged', () => {
    const result = deduplicateToolNames(['mcp__a__foo', 'mcp__b__bar']);
    expect(result.get('mcp__a__foo#0')).toBe('mcp__a__foo');
    expect(result.get('mcp__b__bar#0')).toBe('mcp__b__bar');
  });

  it('appends _N suffix for collisions', () => {
    const result = deduplicateToolNames(['mcp__a__tool', 'mcp__a__tool']);
    expect(result.get('mcp__a__tool#0')).toBe('mcp__a__tool');
    expect(result.get('mcp__a__tool#1')).toBe('mcp__a__tool_1');
  });

  it('truncates deduplicated name to 64 chars', () => {
    const longName = 'mcp__' + 'x'.repeat(59);
    expect(longName.length).toBe(64);
    const result = deduplicateToolNames([longName, longName]);
    const deduped = result.get(longName + '#1')!;
    expect(deduped.length).toBeLessThanOrEqual(64);
    expect(deduped.endsWith('_1')).toBe(true);
  });
});
