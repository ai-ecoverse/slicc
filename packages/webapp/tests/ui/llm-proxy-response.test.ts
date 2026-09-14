import { describe, expect, it } from 'vitest';
import { synthesizeForwardResponse } from '../../src/ui/llm-proxy-response.js';

describe('synthesizeForwardResponse', () => {
  it('returns a Response distinct from the input so the SW does not surface response.url', () => {
    const proxyResponse = new Response('upstream-body', { status: 200 });
    const wrapped = synthesizeForwardResponse(proxyResponse);
    expect(wrapped).not.toBe(proxyResponse);
    expect(wrapped).toBeInstanceOf(Response);
  });

  it('preserves status code', async () => {
    const proxyResponse = new Response('forbidden', { status: 403 });
    const wrapped = synthesizeForwardResponse(proxyResponse);
    expect(wrapped.status).toBe(403);
  });

  it('preserves statusText', () => {
    const proxyResponse = new Response('teapot', { status: 418, statusText: "I'm a teapot" });
    const wrapped = synthesizeForwardResponse(proxyResponse);
    expect(wrapped.statusText).toBe("I'm a teapot");
  });

  it('preserves response headers verbatim', async () => {
    const proxyResponse = new Response('ok', {
      status: 200,
      headers: {
        'content-type': 'application/javascript',
        'x-proxy-set-cookie': 'session=abc',
        'cache-control': 'no-store',
      },
    });
    const wrapped = synthesizeForwardResponse(proxyResponse);
    expect(wrapped.headers.get('content-type')).toBe('application/javascript');
    expect(wrapped.headers.get('x-proxy-set-cookie')).toBe('session=abc');
    expect(wrapped.headers.get('cache-control')).toBe('no-store');
  });

  it('preserves the body as a ReadableStream so SSE chunking is not buffered', async () => {
    const chunks = ['data: hello\n\n', 'data: world\n\n'];
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const proxyResponse = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const wrapped = synthesizeForwardResponse(proxyResponse);
    expect(wrapped.body).toBeInstanceOf(ReadableStream);
    const text = await wrapped.text();
    expect(text).toBe(chunks.join(''));
  });

  it('round-trips a JSON body byte-for-byte', async () => {
    const proxyResponse = new Response(JSON.stringify({ ok: true, value: 42 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const wrapped = synthesizeForwardResponse(proxyResponse);
    expect(await wrapped.json()).toEqual({ ok: true, value: 42 });
  });

  it('handles an empty body (HEAD / 204) without throwing', async () => {
    const proxyResponse = new Response(null, { status: 204 });
    const wrapped = synthesizeForwardResponse(proxyResponse);
    expect(wrapped.status).toBe(204);
    expect(await wrapped.text()).toBe('');
  });

  it('does not throw when a fetched 204 response reports a non-null body stream', () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    const proxyResponse = new Response(null, { status: 204 });
    Object.defineProperty(proxyResponse, 'body', { value: stream });
    expect(() => synthesizeForwardResponse(proxyResponse)).not.toThrow();
    expect(synthesizeForwardResponse(proxyResponse).body).toBeNull();
  });
});
