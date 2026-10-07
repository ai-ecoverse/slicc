import { describe, expect, it } from 'vitest';
import { tryHandleMcpHost } from '../src/mcp-serve-host.js';
import type { DurableObjectStubLike } from '../src/shared.js';

function stubReturning(payload: unknown, status = 200): DurableObjectStubLike {
  return {
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      ),
  };
}

const url = new URL('https://7f3a9c.sliccy.now/mcp');

describe('tryHandleMcpHost', () => {
  it('builds a 204 preflight with a null body', async () => {
    const response = await tryHandleMcpHost(
      new Request(url, { method: 'OPTIONS' }),
      stubReturning({
        status: 204,
        headers: { 'access-control-allow-origin': 'https://client.example' },
        body: '',
      }),
      'token',
      url
    );
    expect(response?.status).toBe(204);
    expect(response?.headers.get('access-control-allow-origin')).toBe('https://client.example');
    expect(await response?.text()).toBe('');
  });

  it('keeps a JSON body on a normal response and ignores a non-publication', async () => {
    const ok = await tryHandleMcpHost(
      new Request(url, { method: 'POST' }),
      stubReturning({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      }),
      'token',
      url
    );
    expect(ok?.status).toBe(200);
    expect(await ok?.text()).toBe('{"ok":true}');

    const missing = await tryHandleMcpHost(
      new Request(url, { method: 'POST' }),
      stubReturning({ code: 'NOT_MCP' }, 404),
      'token',
      url
    );
    expect(missing).toBeNull();
  });
});
