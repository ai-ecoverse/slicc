import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TIMEOUT_MS,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  McpAuthRequiredError,
  McpClient,
  McpTimeoutError,
  parseResourceMetadataUrl,
  selectSseResponseFrame,
} from '../../../src/shell/mcp/client.js';
import type { McpFetchLike } from '../../../src/shell/mcp/types.js';

// ── Test helpers ────────────────────────────────────────────────────

interface StubResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

function bodyToBytes(body: string | Uint8Array | undefined): Uint8Array {
  if (!body) return new Uint8Array();
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return body;
}

function stubFetch(responder: (url: string, init: Parameters<McpFetchLike>[1]) => StubResponse): {
  fetchImpl: McpFetchLike;
  calls: Array<{ url: string; init: Parameters<McpFetchLike>[1] }>;
} {
  const calls: Array<{ url: string; init: Parameters<McpFetchLike>[1] }> = [];
  const fetchImpl: McpFetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responder(url, init);
    return {
      status: r.status ?? 200,
      statusText: r.statusText ?? 'OK',
      headers: r.headers ?? { 'content-type': 'application/json' },
      body: bodyToBytes(r.body ?? '{}'),
    };
  };
  return { fetchImpl, calls };
}

function jsonRpc(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: number, code: number, message: string, data?: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

function sseFrames(frames: string[]): string {
  return frames.map((data) => `event: message\ndata: ${data}\n`).join('\n') + '\n';
}

// ── parseResourceMetadataUrl ────────────────────────────────────────

describe('parseResourceMetadataUrl', () => {
  it('extracts quoted resource_metadata', () => {
    expect(
      parseResourceMetadataUrl(
        'Bearer realm="x", resource_metadata="https://a.example/.well-known/oauth-protected-resource"'
      )
    ).toBe('https://a.example/.well-known/oauth-protected-resource');
  });
  it('extracts unquoted resource_metadata', () => {
    expect(parseResourceMetadataUrl('Bearer resource_metadata=https://a.example/x')).toBe(
      'https://a.example/x'
    );
  });
  it('returns undefined when absent', () => {
    expect(parseResourceMetadataUrl('Bearer realm="x"')).toBeUndefined();
    expect(parseResourceMetadataUrl(undefined)).toBeUndefined();
  });
});

// ── selectSseResponseFrame ──────────────────────────────────────────

describe('selectSseResponseFrame', () => {
  it('selects the frame matching the target id and ignores notifications', () => {
    const stream = sseFrames([
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { p: 1 } }),
      jsonRpc(42, { ok: true }),
    ]);
    const frame = selectSseResponseFrame(new TextEncoder().encode(stream), 42);
    expect(frame.id).toBe(42);
    expect(frame.result).toEqual({ ok: true });
  });

  it('throws when no matching frame is present', () => {
    const stream = sseFrames([jsonRpc(99, { other: true })]);
    expect(() => selectSseResponseFrame(new TextEncoder().encode(stream), 7)).toThrow(/id 7/);
  });
});

// ── McpClient — JSON response path ──────────────────────────────────

describe('McpClient: JSON response path', () => {
  it('POSTs JSON-RPC and returns the result on a plain JSON response', async () => {
    const { fetchImpl, calls } = stubFetch((_url, init) => {
      const sent = JSON.parse(init?.body ?? '{}') as { id: number; method: string };
      return {
        status: sent.method === 'server/discover' ? 400 : 200,
        statusText: sent.method === 'server/discover' ? 'Bad Request' : 'OK',
        headers: { 'content-type': 'application/json' },
        body:
          sent.method === 'server/discover'
            ? jsonRpcError(sent.id, -32601, 'Method not found')
            : jsonRpc(sent.id, { protocolVersion: '2025-06-18' }),
      };
    });
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });
    const result = await c.initialize();
    expect(result).toEqual({ protocolVersion: '2025-06-18' });
    expect(calls).toHaveLength(2);
    const init = calls[1].init!;
    expect(init.method).toBe('POST');
    expect(init.headers!['Content-Type']).toBe('application/json');
    expect(init.headers!['Accept']).toContain('application/json');
    expect(init.headers!['Accept']).toContain('text/event-stream');
    const sent = JSON.parse(init.body!);
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.method).toBe('initialize');
    expect(sent.id).toBe(2);
  });

  it('threads getAuthHeader into the Authorization header', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      body: jsonRpc(1, { supportedVersions: ['2026-07-28'] }),
    }));
    const c = new McpClient({
      url: 'https://mcp.example/rpc',
      fetchImpl,
      getAuthHeader: async () => 'Bearer abc',
    });
    await c.initialize();
    expect(calls[0].init!.headers!['Authorization']).toBe('Bearer abc');
  });

  it('throws when the JSON-RPC response carries an error envelope', async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'no method' },
      }),
    }));
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });
    await expect(c.toolsList()).rejects.toThrow(/-32601/);
  });
});

describe('McpClient: protocol negotiation', () => {
  it('exports supported revisions in preference order', () => {
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).toEqual(['2026-07-28', '2025-06-18']);
  });

  it('selects 2026-07-28 from server/discover without a legacy initialize', async () => {
    const { fetchImpl, calls } = stubFetch((_url, init) => {
      const sent = JSON.parse(init?.body ?? '{}') as { id: number; method: string };
      return sent.method === 'server/discover'
        ? {
            headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'must-ignore' },
            body: jsonRpc(sent.id, { supportedVersions: ['2026-07-28', '2025-06-18'] }),
          }
        : {
            headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'also-ignore' },
            body: jsonRpc(sent.id, { tools: [] }),
          };
    });
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });

    await c.initialize();

    await c.toolsList();

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].init!.body!).method).toBe('server/discover');
    expect(calls[1].init!.headers!['Mcp-Session-Id']).toBeUndefined();
    expect(c.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(c.getSessionId()).toBeUndefined();
  });

  it('falls back to the legacy initialize handshake when discovery is unsupported', async () => {
    const { fetchImpl, calls } = stubFetch((_url, init) => {
      const sent = JSON.parse(init?.body ?? '{}') as { id: number; method: string };
      return sent.method === 'server/discover'
        ? {
            status: 400,
            statusText: 'Bad Request',
            body: jsonRpcError(sent.id, -32601, 'Method not found'),
          }
        : {
            headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'legacy-session' },
            body: jsonRpc(sent.id, { protocolVersion: '2025-06-18' }),
          };
    });
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });

    await c.initialize();

    expect(calls.map((call) => JSON.parse(call.init!.body!).method)).toEqual([
      'server/discover',
      'initialize',
    ]);
    expect(JSON.parse(calls[1].init!.body!).params.protocolVersion).toBe('2025-06-18');
    expect(c.getNegotiatedProtocolVersion()).toBe('2025-06-18');
    expect(c.getSessionId()).toBe('legacy-session');
  });

  it('retries a mutually supported modern version when discovery returns -32022', async () => {
    const { fetchImpl, calls } = stubFetch((_url, init) => {
      const sent = JSON.parse(init?.body ?? '{}') as {
        id: number;
        params: { protocolVersion: string };
      };
      return sent.params.protocolVersion === '2099-01-01'
        ? {
            status: 400,
            statusText: 'Bad Request',
            body: jsonRpcError(sent.id, -32022, 'Unsupported protocol version', {
              supported: ['2026-07-28', '2025-06-18'],
              requested: '2099-01-01',
            }),
          }
        : { body: jsonRpc(sent.id, { supportedVersions: ['2026-07-28'] }) };
    });
    const c = new McpClient({
      url: 'https://mcp.example/rpc',
      fetchImpl,
      protocolVersion: '2099-01-01',
    });

    await c.initialize();

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => JSON.parse(call.init!.body!).method)).toEqual([
      'server/discover',
      'server/discover',
    ]);
    expect(JSON.parse(calls[1].init!.body!).params.protocolVersion).toBe('2026-07-28');
    expect(c.getNegotiatedProtocolVersion()).toBe('2026-07-28');
  });

  it('does not fall back when -32022 advertises no compatible modern version', async () => {
    const { fetchImpl, calls } = stubFetch((_url, init) => {
      const sent = JSON.parse(init?.body ?? '{}') as { id: number };
      return {
        status: 400,
        statusText: 'Bad Request',
        body: jsonRpcError(sent.id, -32022, 'Unsupported protocol version', {
          supported: ['2025-06-18'],
        }),
      };
    });
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });

    await expect(c.initialize()).rejects.toThrow(/compatible modern protocol version/);
    expect(calls).toHaveLength(1);
  });

  it('does not fall back on transport or HTTP 5xx failures', async () => {
    const network = stubFetch(() => {
      throw new TypeError('network unavailable');
    });
    await expect(
      new McpClient({ url: 'https://mcp.example/rpc', fetchImpl: network.fetchImpl }).initialize()
    ).rejects.toThrow('network unavailable');
    expect(network.calls).toHaveLength(1);

    const unavailable = stubFetch(() => ({
      status: 503,
      statusText: 'Service Unavailable',
      body: 'temporarily unavailable',
    }));
    await expect(
      new McpClient({
        url: 'https://mcp.example/rpc',
        fetchImpl: unavailable.fetchImpl,
      }).initialize()
    ).rejects.toThrow(/MCP HTTP 503/);
    expect(unavailable.calls).toHaveLength(1);
  });

  it('does not fall back on a malformed successful discovery response', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: 'not-json' }));
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });

    await expect(c.initialize()).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['unparseable', 'not-json'],
    [
      'invalid JSON-RPC envelope',
      JSON.stringify({ error: { code: -32601, message: 'Method not found' } }),
    ],
  ])('does not fall back on an %s HTTP 400 response', async (_label, body) => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 400,
      statusText: 'Bad Request',
      body,
    }));
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });

    await expect(c.initialize()).rejects.toThrow(/MCP HTTP 400/);
    expect(calls).toHaveLength(1);
  });

  it.each([-32020, -32021, -32602])('does not fall back on JSON-RPC error %i', async (code) => {
    const { fetchImpl, calls } = stubFetch((_url, init) => {
      const sent = JSON.parse(init?.body ?? '{}') as { id: number };
      return {
        status: 400,
        statusText: 'Bad Request',
        body: jsonRpcError(sent.id, code, 'Not a legacy-era signal'),
      };
    });
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });

    await expect(c.initialize()).rejects.toThrow(/MCP HTTP 400/);
    expect(calls).toHaveLength(1);
  });

  it('does not fall back when discovery times out', async () => {
    vi.useFakeTimers();
    try {
      let callCount = 0;
      const fetchImpl: McpFetchLike = (_url, init) => {
        callCount++;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      };
      const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl, timeoutMs: 50 });
      const pending = c.initialize();
      const assertion = expect(pending).rejects.toBeInstanceOf(McpTimeoutError);

      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(callCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── McpClient — SSE response path ───────────────────────────────────

describe('McpClient: SSE response path', () => {
  it('parses an SSE response and resolves on the matching frame', async () => {
    const { fetchImpl } = stubFetch(() => ({
      headers: { 'content-type': 'text/event-stream' },
      body: sseFrames([
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/log', params: { msg: 'noise' } }),
        jsonRpc(1, { tools: [{ name: 'echo' }] }),
      ]),
    }));
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });
    const tools = await c.toolsList();
    expect(tools).toEqual([{ name: 'echo' }]);
  });
});

// ── Mcp-Session-Id round-trip ───────────────────────────────────────

describe('McpClient: Mcp-Session-Id round-trip', () => {
  it('captures session id on first response and echoes it on subsequent requests', async () => {
    let callCount = 0;
    const { fetchImpl, calls } = stubFetch(() => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 400,
          statusText: 'Bad Request',
          body: jsonRpcError(1, -32601, 'Method not found'),
        };
      }
      if (callCount === 2) {
        return {
          headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'sess-1' },
          body: jsonRpc(2, {}),
        };
      }
      return { body: jsonRpc(3, { tools: [] }) };
    });
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });
    await c.initialize();
    expect(c.getSessionId()).toBe('sess-1');
    await c.toolsList();
    expect(calls[2].init!.headers!['Mcp-Session-Id']).toBe('sess-1');
  });

  it('does NOT attach Mcp-Session-Id on the initialize request even when constructor was given a stale id', async () => {
    const { fetchImpl, calls } = stubFetch((_url, init) => {
      const sent = JSON.parse(init?.body ?? '{}') as { id: number; method: string };
      return sent.method === 'server/discover'
        ? {
            status: 400,
            statusText: 'Bad Request',
            body: jsonRpcError(sent.id, -32601, 'Method not found'),
          }
        : {
            headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'srv-fresh' },
            body: jsonRpc(sent.id, {}),
          };
    });
    const c = new McpClient({
      url: 'https://mcp.example/rpc',
      fetchImpl,
      sessionId: 'stale-123',
    });
    await c.initialize();
    expect(calls).toHaveLength(2);
    expect(calls[1].init!.headers!['Mcp-Session-Id']).toBeUndefined();
    // The response-provided session id wins over the stale constructor value.
    expect(c.getSessionId()).toBe('srv-fresh');
  });

  it('attaches the freshly issued Mcp-Session-Id on a tools/call after initialize', async () => {
    let callCount = 0;
    const { fetchImpl, calls } = stubFetch(() => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 400,
          statusText: 'Bad Request',
          body: jsonRpcError(1, -32601, 'Method not found'),
        };
      }
      if (callCount === 2) {
        return {
          headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'srv-abc' },
          body: jsonRpc(2, {}),
        };
      }
      return {
        body: jsonRpc(3, { content: [{ type: 'text', text: 'ok' }] }),
      };
    });
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });
    await c.initialize();
    await c.toolsCall('echo', { msg: 'hi' });
    expect(calls).toHaveLength(3);
    expect(calls[0].init!.headers!['Mcp-Session-Id']).toBeUndefined();
    expect(calls[2].init!.headers!['Mcp-Session-Id']).toBe('srv-abc');
  });
});

// ── Timeout / abort ────────────────────────────────────────────────

describe('McpClient: timeout/abort', () => {
  it('exports DEFAULT_TIMEOUT_MS = 60_000 (bumped from 30s for slow streamable-http servers)', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000);
  });

  it('rejects when the per-request timeout elapses', async () => {
    vi.useFakeTimers();
    const fetchImpl: McpFetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
      });
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl, timeoutMs: 50 });
    const p = c.toolsList();
    // Attach the assertion handler BEFORE advancing the fake timers so the
    // rejection isn't briefly unhandled while the timer callback runs.
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });

  it('throws McpTimeoutError carrying method, timeoutMs, name, and the legacy message format', async () => {
    vi.useFakeTimers();
    const fetchImpl: McpFetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
      });
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl, timeoutMs: 50 });
    const p = c.toolsList();
    // Capture the rejection eagerly so it isn't briefly unhandled while the
    // timer callback fires.
    const captured = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60);
    const e = (await captured) as McpTimeoutError;
    expect(e).toBeInstanceOf(McpTimeoutError);
    expect(e.name).toBe('McpTimeoutError');
    expect(e.method).toBe('tools/list');
    expect(e.timeoutMs).toBe(50);
    // Regression on log scraping: keep the original message format intact.
    expect(e.message).toBe('MCP request timed out after 50ms (tools/list)');
    vi.useRealTimers();
  });
});

// ── 401 → McpAuthRequiredError ─────────────────────────────────────

describe('McpClient: 401 handling', () => {
  it('throws McpAuthRequiredError with parsed resource_metadata URL', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 401,
      statusText: 'Unauthorized',
      headers: {
        'content-type': 'text/plain',
        'WWW-Authenticate':
          'Bearer realm="mcp", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
      },
      body: 'unauthorized',
    }));
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });
    await expect(c.toolsList()).rejects.toBeInstanceOf(McpAuthRequiredError);
    try {
      await c.toolsList();
    } catch (e) {
      const err = e as McpAuthRequiredError;
      expect(err.resourceMetadataUrl).toBe(
        'https://mcp.example/.well-known/oauth-protected-resource'
      );
      expect(err.status).toBe(401);
    }
  });
});

// ── tools/call + apps/list best-effort ─────────────────────────────

describe('McpClient: tools/call and apps/list', () => {
  it('passes name + arguments to tools/call and returns the result', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      body: jsonRpc(1, { content: [{ type: 'text', text: 'hi' }] }),
    }));
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });
    const out = await c.toolsCall('echo', { msg: 'hi' });
    expect(out).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    const sent = JSON.parse(calls[0].init!.body!);
    expect(sent.method).toBe('tools/call');
    expect(sent.params).toEqual({ name: 'echo', arguments: { msg: 'hi' } });
  });

  it('returns [] when apps/list fails (best-effort)', async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no' } }),
    }));
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });
    const apps = await c.appsList();
    expect(apps).toEqual([]);
  });
});
