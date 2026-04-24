import {
  isProxyError,
  parseProxyErrorBody,
  readProxyErrorMessage,
} from '../../src/core/proxy-error.js';

function makeResponse(body: string, init: ResponseInit & { headers?: HeadersInit } = {}): Response {
  return new Response(body, init);
}

describe('isProxyError', () => {
  it('returns true when X-Proxy-Error: 1 is set', () => {
    const resp = makeResponse('{}', {
      status: 400,
      headers: { 'X-Proxy-Error': '1' },
    });
    expect(isProxyError(resp)).toBe(true);
  });

  it('returns false when the marker is absent', () => {
    const resp = makeResponse('{"error":"invalid_client"}', { status: 400 });
    expect(isProxyError(resp)).toBe(false);
  });

  it('returns false when the marker is some other value', () => {
    const resp = makeResponse('{}', { status: 400, headers: { 'X-Proxy-Error': 'maybe' } });
    expect(isProxyError(resp)).toBe(false);
  });
});

describe('parseProxyErrorBody', () => {
  it('returns the string error field verbatim', () => {
    expect(parseProxyErrorBody('{"error":"Missing X-Target-URL header"}', 'fallback')).toBe(
      'Missing X-Target-URL header'
    );
  });

  it('returns the message of an object-shaped error (no more [object Object])', () => {
    const body = JSON.stringify({ error: { code: 400, message: 'Some upstream complaint' } });
    expect(parseProxyErrorBody(body, 'fallback')).toBe('Some upstream complaint');
  });

  it('falls back to JSON.stringify when the object error has no message', () => {
    const body = JSON.stringify({ error: { code: 400, status: 'NOPE' } });
    expect(parseProxyErrorBody(body, 'fallback')).toBe(
      JSON.stringify({ code: 400, status: 'NOPE' })
    );
  });

  it('returns the fallback when the body is not JSON', () => {
    expect(parseProxyErrorBody('not json', 'Proxy error 502')).toBe('Proxy error 502');
  });

  it('returns the fallback when JSON has no error field', () => {
    expect(parseProxyErrorBody('{"foo":1}', 'Proxy error 400')).toBe('Proxy error 400');
  });

  it('returns the fallback when the error is an empty string', () => {
    expect(parseProxyErrorBody('{"error":""}', 'Proxy error 502')).toBe('Proxy error 502');
  });
});

describe('readProxyErrorMessage', () => {
  it('reads the response body once and parses it', async () => {
    const resp = makeResponse('{"error":"invalid_client"}', {
      status: 400,
      headers: { 'X-Proxy-Error': '1' },
    });
    expect(await readProxyErrorMessage(resp)).toBe('invalid_client');
  });

  it('uses the status fallback when the body is malformed', async () => {
    const resp = makeResponse('<html>nope</html>', {
      status: 502,
      headers: { 'X-Proxy-Error': '1' },
    });
    expect(await readProxyErrorMessage(resp)).toBe('Proxy error 502');
  });

  it('handles object-shaped error fields', async () => {
    const body = JSON.stringify({
      error: { code: 400, message: 'The OAuth client was not found.' },
    });
    const resp = makeResponse(body, { status: 400, headers: { 'X-Proxy-Error': '1' } });
    expect(await readProxyErrorMessage(resp)).toBe('The OAuth client was not found.');
  });
});
