import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_TIMEOUT_MS,
  McpClient,
  McpAuthRequiredError,
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
    const { fetchImpl, calls } = stubFetch(() => ({
      headers: { 'content-type': 'application/json' },
      body: jsonRpc(1, { protocolVersion: '2025-06-18' }),
    }));
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });
    const result = await c.initialize();
    expect(result).toEqual({ protocolVersion: '2025-06-18' });
    expect(calls).toHaveLength(1);
    const init = calls[0].init!;
    expect(init.method).toBe('POST');
    expect(init.headers!['Content-Type']).toBe('application/json');
    expect(init.headers!['Accept']).toContain('application/json');
    expect(init.headers!['Accept']).toContain('text/event-stream');
    const sent = JSON.parse(init.body!);
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.method).toBe('initialize');
    expect(sent.id).toBe(1);
  });

  it('threads getAuthHeader into the Authorization header', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: jsonRpc(1, {}) }));
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
          headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'sess-1' },
          body: jsonRpc(1, {}),
        };
      }
      return { body: jsonRpc(2, { tools: [] }) };
    });
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });
    await c.initialize();
    expect(c.getSessionId()).toBe('sess-1');
    await c.toolsList();
    expect(calls[1].init!.headers!['Mcp-Session-Id']).toBe('sess-1');
  });

  it('does NOT attach Mcp-Session-Id on the initialize request even when constructor was given a stale id', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'srv-fresh' },
      body: jsonRpc(1, {}),
    }));
    const c = new McpClient({
      url: 'https://mcp.example/rpc',
      fetchImpl,
      sessionId: 'stale-123',
    });
    await c.initialize();
    expect(calls).toHaveLength(1);
    expect(calls[0].init!.headers!['Mcp-Session-Id']).toBeUndefined();
    // The response-provided session id wins over the stale constructor value.
    expect(c.getSessionId()).toBe('srv-fresh');
  });

  it('attaches the freshly issued Mcp-Session-Id on a tools/call after initialize', async () => {
    let callCount = 0;
    const { fetchImpl, calls } = stubFetch(() => {
      callCount++;
      if (callCount === 1) {
        return {
          headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'srv-abc' },
          body: jsonRpc(1, {}),
        };
      }
      return {
        body: jsonRpc(2, { content: [{ type: 'text', text: 'ok' }] }),
      };
    });
    const c = new McpClient({ url: 'https://mcp.example/rpc', fetchImpl });
    await c.initialize();
    await c.toolsCall('echo', { msg: 'hi' });
    expect(calls).toHaveLength(2);
    expect(calls[0].init!.headers!['Mcp-Session-Id']).toBeUndefined();
    expect(calls[1].init!.headers!['Mcp-Session-Id']).toBe('srv-abc');
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
