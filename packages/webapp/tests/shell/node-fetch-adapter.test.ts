import { describe, it, expect, vi } from 'vitest';
import type { SecureFetch } from 'just-bash';
import { createNodeFetchAdapter } from '../../src/shell/supplemental-commands/node-fetch-adapter.js';

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

  it('decodes Uint8Array body as UTF-8 text', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    const bytes = new TextEncoder().encode('hello body');
    await fetch('https://api.example.com/x', { method: 'POST', body: bytes });

    const opts = (secureFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as { body: string };
    expect(opts.body).toBe('hello body');
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

  it('rejects Blob and FormData bodies with a clear message', async () => {
    const secureFetch: SecureFetch = vi.fn(async () => okResult());
    const fetch = createNodeFetchAdapter(secureFetch);

    await expect(
      fetch('https://api.example.com/x', { method: 'POST', body: new Blob(['x']) })
    ).rejects.toThrow(/Blob request bodies are not supported/);

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
});
