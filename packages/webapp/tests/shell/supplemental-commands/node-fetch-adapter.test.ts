import type { SecureFetch } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { createNodeFetchAdapter } from '../../../src/shell/supplemental-commands/node-fetch-adapter.js';

const okResult = (
  overrides: Partial<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: Uint8Array;
    url: string;
  }> = {}
) => ({
  status: overrides.status ?? 200,
  statusText: overrides.statusText ?? 'OK',
  headers: overrides.headers ?? { 'content-type': 'application/json' },
  body: overrides.body ?? new TextEncoder().encode('{"ok":true}'),
  url: overrides.url ?? 'https://api.example.com/x',
});

describe('createNodeFetchAdapter', () => {
  it('routes through SecureFetch with the given URL string', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    const resp = await fetch('https://oauth2.googleapis.com/token');

    expect(secureFetch).toHaveBeenCalledTimes(1);
    expect((secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'https://oauth2.googleapis.com/token'
    );
    expect(resp.status).toBe(200);
    expect(resp.ok).toBe(true);
  });

  it('serializes URL objects to string', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    await fetch(new URL('https://api.example.com/path'));

    expect((secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'https://api.example.com/path'
    );
  });

  it('passes method and headers to SecureFetch', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    await fetch('https://api.example.com/x', {
      method: 'post',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
    });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      method: string;
      headers: Record<string, string>;
    };
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers['Authorization']).toBe('Bearer x');
  });

  it('converts Headers instance to a plain record', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    const h = new Headers();
    h.set('X-Custom', 'value');
    h.set('Accept', 'application/json');
    await fetch('https://api.example.com/x', { method: 'GET', headers: h });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(opts.headers['x-custom']).toBe('value');
    expect(opts.headers['accept']).toBe('application/json');
  });

  it('converts header tuples array to a record', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    await fetch('https://api.example.com/x', {
      method: 'POST',
      headers: [
        ['X-A', '1'],
        ['X-B', '2'],
      ],
    });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(opts.headers['X-A']).toBe('1');
    expect(opts.headers['X-B']).toBe('2');
  });

  it('passes string body through verbatim', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    await fetch('https://api.example.com/x', {
      method: 'POST',
      body: '{"a":1}',
    });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as { body: string };
    expect(opts.body).toBe('{"a":1}');
  });

  it('serializes URLSearchParams body to a urlencoded string', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('client_id', 'GWS_CLIENT_ID_MASKED');
    await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: params,
    });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as { body: string };
    expect(opts.body).toBe('grant_type=refresh_token&client_id=GWS_CLIENT_ID_MASKED');
  });

  it.each([
    ['Uint8Array', (bytes: Uint8Array) => bytes as BodyInit],
    ['ArrayBuffer', (bytes: Uint8Array) => bytes.buffer as BodyInit],
    [
      'ArrayBufferView',
      (bytes: Uint8Array) =>
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) as BodyInit,
    ],
  ])('encodes %s body as latin1 and defaults its Content-Type', async (_name, makeBody) => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff]);
    await fetch('https://api.example.com/x', { method: 'POST', body: makeBody(bytes) });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      body: string;
      headers: Record<string, string>;
    };
    expect(Array.from(opts.body, (char) => char.charCodeAt(0))).toEqual(Array.from(bytes));
    expect(opts.headers['Content-Type']).toBe('application/octet-stream');
  });

  it('strips bodies on GET / HEAD per fetch semantics', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    await fetch('https://api.example.com/x', { method: 'GET', body: 'should be dropped' });
    await fetch('https://api.example.com/x', { method: 'HEAD', body: 'should be dropped' });

    const calls = (secureFetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1].body).toBeUndefined();
    expect(calls[1][1].body).toBeUndefined();
  });

  it('returns a real Response with status, statusText, and JSON body', async () => {
    const body = new TextEncoder().encode('{"foo":"bar"}');
    const secureFetch: SecureFetch = vi.fn(async () =>
      okResult({ status: 201, statusText: 'Created', body })
    );
    const fetch = createNodeFetchAdapter(secureFetch);

    const resp = await fetch('https://api.example.com/x');

    expect(resp.status).toBe(201);
    expect(resp.statusText).toBe('Created');
    expect(resp.ok).toBe(true);
    expect(await resp.json()).toEqual({ foo: 'bar' });
  });

  it('exposes upstream response headers via Response.headers', async () => {
    const secureFetch: SecureFetch = vi.fn(async () =>
      okResult({
        headers: { 'content-type': 'text/plain', 'x-rate-limit': '99' },
      })
    );
    const fetch = createNodeFetchAdapter(secureFetch);

    const resp = await fetch('https://api.example.com/x');

    expect(resp.headers.get('content-type')).toBe('text/plain');
    expect(resp.headers.get('x-rate-limit')).toBe('99');
  });

  it('lets upstream 4xx flow through with ok=false (non-throwing)', async () => {
    const errBody = new TextEncoder().encode('{"error":"invalid_client"}');
    const secureFetch: SecureFetch = vi.fn(async () =>
      okResult({ status: 401, statusText: 'Unauthorized', body: errBody })
    );
    const fetch = createNodeFetchAdapter(secureFetch);

    const resp = await fetch('https://oauth2.googleapis.com/token', { method: 'POST' });

    expect(resp.status).toBe(401);
    expect(resp.ok).toBe(false);
    expect(await resp.text()).toBe('{"error":"invalid_client"}');
  });

  it('uses null body for 204 responses (Response constructor invariant)', async () => {
    const secureFetch: SecureFetch = vi.fn(async () =>
      okResult({ status: 204, statusText: 'No Content', body: new Uint8Array() })
    );
    const fetch = createNodeFetchAdapter(secureFetch);

    const resp = await fetch('https://api.example.com/x');

    expect(resp.status).toBe(204);
    // Reading body should resolve cleanly (empty).
    expect(await resp.text()).toBe('');
  });

  it.each([
    ['image/png', 'image/png'],
    ['', 'application/octet-stream'],
  ])('encodes a Blob with type %j as latin1 and defaults to %s', async (type, contentType) => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);
    const bytes = new Uint8Array([0x00, 0x80, 0xff]);

    await fetch('https://api.example.com/x', {
      method: 'POST',
      body: new Blob([bytes], { type }),
    });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      body: string;
      headers: Record<string, string>;
    };
    expect(Array.from(opts.body, (char) => char.charCodeAt(0))).toEqual(Array.from(bytes));
    expect(opts.headers['Content-Type']).toBe(contentType);
  });

  it('preserves a caller-provided Content-Type for a Blob case-insensitively', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    await fetch('https://api.example.com/x', {
      method: 'POST',
      headers: { 'CONTENT-TYPE': 'application/custom' },
      body: new Blob(['data'], { type: 'image/png' }),
    });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(opts.headers).toEqual({ 'CONTENT-TYPE': 'application/custom' });
  });

  it('rejects FormData bodies with a clear message', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    const fd = new FormData();
    fd.set('a', 'b');
    await expect(fetch('https://api.example.com/x', { method: 'POST', body: fd })).rejects.toThrow(
      /FormData request bodies are not supported/
    );
  });

  it('exposes the upstream URL on Response.url', async () => {
    const secureFetch: SecureFetch = vi.fn(async () =>
      okResult({ url: 'https://api.example.com/x' })
    );
    const fetch = createNodeFetchAdapter(secureFetch);

    const resp = await fetch('https://api.example.com/x');
    expect(resp.url).toBe('https://api.example.com/x');
  });

  it('uses URL, method, headers, and body from a Request input', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    const request = new Request('https://api.example.com/request', {
      method: 'patch',
      headers: {
        'Content-Type': 'text/plain',
        Authorization: 'Bearer from-request',
      },
      body: 'from-request-body',
    });

    await fetch(request);

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      method: string;
      headers: Record<string, string>;
      body?: string;
    };
    expect((secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'https://api.example.com/request'
    );
    expect(opts.method).toBe('PATCH');
    expect(opts.headers['content-type']).toBe('text/plain');
    expect(opts.headers['authorization']).toBe('Bearer from-request');
    expect(opts.body).toBe('from-request-body');
  });

  it('encodes a binary Request body as latin1 and defaults its Content-Type', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);
    const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff]);
    const request = new Request('https://api.example.com/request', {
      method: 'POST',
      body: bytes,
    });

    await fetch(request);

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      body: string;
      headers: Record<string, string>;
    };
    expect(Array.from(opts.body, (char) => char.charCodeAt(0))).toEqual(Array.from(bytes));
    expect(opts.headers['Content-Type']).toBe('application/octet-stream');
  });

  it('lets init override method, headers, and body from a Request input', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    const request = new Request('https://api.example.com/request', {
      method: 'patch',
      headers: {
        'Content-Type': 'text/plain',
        Authorization: 'Bearer from-request',
      },
      body: 'from-request-body',
    });

    await fetch(request, {
      method: 'post',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer from-init' },
      body: '{"from":"init"}',
    });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      method: string;
      headers: Record<string, string>;
      body?: string;
    };
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers['Authorization']).toBe('Bearer from-init');
    expect(opts.body).toBe('{"from":"init"}');
  });

  it('auto-sets Content-Type for URLSearchParams bodies (matches native fetch)', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: params });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded;charset=UTF-8');
  });

  it('does not override an explicit Content-Type when body is URLSearchParams', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token' }),
    });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(opts.headers['content-type']).toBe('application/x-www-form-urlencoded');
    // Should not also have a 'Content-Type' (different case) — the explicit
    // header is preserved as-is.
    expect(opts.headers['Content-Type']).toBeUndefined();
  });

  it('rejects ReadableStream request bodies with a clear message', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hi'));
        controller.close();
      },
    });

    await expect(
      // The native Request type for body when streaming requires an extra
      // option in some environments; we cast to BodyInit so the test
      // exercises the adapter's runtime check.
      fetch('https://api.example.com/x', {
        method: 'POST',
        body: stream as unknown as BodyInit,
      })
    ).rejects.toThrow(/ReadableStream request bodies are not supported/);
  });

  it('rejects unknown body shapes instead of stringifying them', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    await expect(
      fetch('https://api.example.com/x', {
        method: 'POST',
        body: { foo: 'bar' } as unknown as BodyInit,
      })
    ).rejects.toThrow(/unsupported request body type/);
  });

  it('propagates Origin from init.headers (Record) to SecureFetch', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    await fetch('https://api.example.com/x', {
      method: 'GET',
      headers: { Origin: 'https://my.app', Cookie: 'sid=abc' },
    });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(opts.headers['Origin']).toBe('https://my.app');
    expect(opts.headers['Cookie']).toBe('sid=abc');
  });

  it('propagates Origin from init.headers (Headers instance) to SecureFetch', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    const h = new Headers();
    h.set('Origin', 'https://my.app');
    await fetch('https://api.example.com/x', { method: 'GET', headers: h });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    // Headers normalizes keys to lowercase, but the value must survive.
    expect(opts.headers['origin']).toBe('https://my.app');
  });

  it('lets init.headers Origin override a Request.headers Origin', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    const request = new Request('https://api.example.com/x', {
      method: 'GET',
      headers: { Origin: 'https://from-request' },
    });
    await fetch(request, { headers: { Origin: 'https://from-init' } });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    // init wins on conflicts; case may differ depending on Headers
    // normalization, so check both candidate slots.
    const origin = opts.headers['Origin'] ?? opts.headers['origin'];
    expect(origin).toBe('https://from-init');
  });
});
