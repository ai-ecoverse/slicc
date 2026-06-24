/**
 * Tests for the SW-side delegated-response stream builder. Pins the
 * `response-head` → `response-chunk`* → `response-end` happy path (streamed
 * Response body) and the two error timings: a pre-head `response-error`
 * rejects the response promise; a mid-stream one errors the body stream
 * after the Response has already resolved.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDelegatedResponseStream,
  type DelegateResponsePort,
} from '../../src/ui/llm-proxy-extension-delegate.js';

interface FakePort extends DelegateResponsePort {
  closed: boolean;
  started: boolean;
  emit: (data: unknown) => void;
}

function makePort(): FakePort {
  const port: FakePort = {
    onmessage: null,
    closed: false,
    started: false,
    start() {
      port.started = true;
    },
    close() {
      port.closed = true;
    },
    emit(data: unknown) {
      port.onmessage?.({ data } as MessageEvent);
    },
  };
  return port;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

describe('buildDelegatedResponseStream', () => {
  it('streams a Response from head + chunks + end', async () => {
    const port = makePort();
    const { responsePromise } = buildDelegatedResponseStream(port);
    expect(port.started).toBe(true);

    port.emit({
      type: 'response-head',
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/plain' },
    });
    const resp = await responsePromise;
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('text/plain');

    port.emit({ type: 'response-chunk', dataBase64: b64('hel') });
    port.emit({ type: 'response-chunk', dataBase64: b64('lo') });
    port.emit({ type: 'response-end' });

    expect(await resp.text()).toBe('hello');
    expect(port.closed).toBe(true);
  });

  it('rejects when response-error arrives before response-head', async () => {
    const port = makePort();
    const { responsePromise } = buildDelegatedResponseStream(port);
    port.emit({ type: 'response-error', error: 'boom' });
    await expect(responsePromise).rejects.toThrow('boom');
    expect(port.closed).toBe(true);
  });

  it('errors the body stream when response-error arrives after the head', async () => {
    const port = makePort();
    const { responsePromise } = buildDelegatedResponseStream(port);
    port.emit({ type: 'response-head', status: 200, statusText: 'OK', headers: {} });
    const resp = await responsePromise;
    port.emit({ type: 'response-chunk', dataBase64: b64('partial') });
    port.emit({ type: 'response-error', error: 'mid-stream' });
    await expect(resp.text()).rejects.toThrow('mid-stream');
  });

  it('ignores a second response-head and post-termination messages', async () => {
    const port = makePort();
    const { responsePromise } = buildDelegatedResponseStream(port);
    port.emit({ type: 'response-head', status: 201, statusText: 'Created', headers: {} });
    port.emit({ type: 'response-head', status: 500, statusText: 'Err', headers: {} });
    const resp = await responsePromise;
    expect(resp.status).toBe(201);
    port.emit({ type: 'response-end' });
    port.emit({ type: 'response-chunk', dataBase64: b64('late') });
    expect(await resp.text()).toBe('');
  });
});
