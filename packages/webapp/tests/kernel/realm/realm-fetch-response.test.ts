import { describe, expect, it } from 'vitest';
import { reconstructFetchResponse } from '../../../src/kernel/realm/realm-fetch-response.js';
import type { SerializedFetchResponse } from '../../../src/kernel/realm/realm-types.js';

function payload(
  overrides: Partial<SerializedFetchResponse> & { json?: unknown; text?: string } = {}
): SerializedFetchResponse {
  const text =
    overrides.text ??
    (overrides.json !== undefined ? JSON.stringify(overrides.json) : '{"ok":true}');
  return {
    status: overrides.status ?? 200,
    statusText: overrides.statusText ?? 'OK',
    headers: overrides.headers ?? { 'content-type': 'application/json' },
    body: overrides.body ?? new TextEncoder().encode(text),
    url: overrides.url ?? 'https://example.test/headers',
  };
}

describe('reconstructFetchResponse', () => {
  it('parses JSON from the already-buffered bytes', async () => {
    const res = reconstructFetchResponse(
      payload({ json: { headers: { Host: 'example.test' } } }),
      ''
    );
    await expect(res.json()).resolves.toEqual({ headers: { Host: 'example.test' } });
  });

  it('returns text from the already-buffered bytes', async () => {
    const res = reconstructFetchResponse(payload({ text: 'hello' }), '');
    await expect(res.text()).resolves.toBe('hello');
  });

  it('does not try to inflate an already-decoded gzip body', async () => {
    const json = '{"n":1}';
    const res = reconstructFetchResponse(
      payload({
        text: json,
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': '999',
        },
      }),
      ''
    );
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-type')).toBe('application/json');
    await expect(res.json()).resolves.toEqual({ n: 1 });
  });

  it('exposes the fallback URL when the payload has none', () => {
    const res = reconstructFetchResponse(payload({ url: '' }), 'https://fallback.test/x');
    expect(res.url).toBe('https://fallback.test/x');
  });

  it('uses a null body for 204 so the constructor does not throw', async () => {
    const res = reconstructFetchResponse(
      payload({ status: 204, statusText: 'No Content', text: '', headers: {} }),
      'https://example.test/empty'
    );
    expect(res.status).toBe(204);
    await expect(res.text()).resolves.toBe('');
  });

  it('rejects a second body read the way native Response does', async () => {
    const res = reconstructFetchResponse(payload({ json: { a: 1 } }), '');
    await expect(res.json()).resolves.toEqual({ a: 1 });
    await expect(res.text()).rejects.toThrow(/already used/);
  });
});
