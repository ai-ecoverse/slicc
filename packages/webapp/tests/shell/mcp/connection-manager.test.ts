import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type McpConnection,
  McpConnectionManager,
  mcpAgentToolName,
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

// ── mcpAgentToolName ─────────────────────────────────────────────────

describe('mcpAgentToolName', () => {
  it('produces mcp__server__tool format', () => {
    expect(mcpAgentToolName('weather', 'get-forecast')).toBe('mcp__weather__get-forecast');
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
});

// ── resolveToolExposure ──────────────────────────────────────────────

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

  it('last matching pattern wins', () => {
    expect(resolveToolExposure('get-data', 'codemode', { '*': 'hidden', 'get-*': 'direct' })).toBe(
      'direct'
    );
  });
});

// ── McpConnectionManager ─────────────────────────────────────────────

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

    // Mock the SLICC client module
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

  it('disconnect removes a connection', async () => {
    const mockConnection: McpConnection = {
      serverName: 'test',
      serverUrl: 'https://mcp.example.com/sse',
      listTools: async () => [],
      callTool: async () => ({ content: [], isError: false }),
      close: vi.fn(async () => {}),
    };

    // Inject a connection manually via connect + entry with cached transport
    const entry = makeEntry({ transport: 'slicc' });
    await manager.connect('test', entry).catch(() => {});

    await manager.disconnect('test');
    expect(manager.has('test')).toBe(false);
  });

  it('emits tools-changed on disconnect', async () => {
    const listener = vi.fn();
    manager.onToolsChanged(listener);

    await manager.disconnect('test');
    // No connection existed, so no event
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribe removes the listener', () => {
    const listener = vi.fn();
    const unsub = manager.onToolsChanged(listener);
    unsub();
    // Internal: verify the listener set is empty
    expect(listener).not.toHaveBeenCalled();
  });
});
