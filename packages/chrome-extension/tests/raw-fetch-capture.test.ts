import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRawFetchCapture, installRawFetchCapture } from '../src/raw-fetch-capture.js';

const url = (tag: string) => `https://example.com/a#${tag}`;

describe('raw fetch capture', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the status line and every header line of an expected tag, in order', async () => {
    const capture = createRawFetchCapture();
    capture.expect('slicc-raw-1');
    const waiting = capture.wait('slicc-raw-1', 1000);
    capture.onHeadersReceived({
      url: url('slicc-raw-1'),
      statusCode: 302,
      statusLine: 'HTTP/1.1 302 Found',
      responseHeaders: [
        { name: 'Location', value: '/next' },
        { name: 'Set-Cookie', value: 'a=1' },
        { name: 'Set-Cookie', value: 'b=2' },
        { name: 'X-Empty' },
      ],
    });
    expect(await waiting).toEqual({
      status: 302,
      statusText: 'Found',
      headers: [
        ['Location', '/next'],
        ['Set-Cookie', 'a=1'],
        ['Set-Cookie', 'b=2'],
        ['X-Empty', ''],
      ],
    });
    expect(await capture.wait('slicc-raw-1', 0)).toMatchObject({ status: 302 });
  });

  it('keeps concurrent requests to one URL apart by tag', async () => {
    const capture = createRawFetchCapture();
    capture.expect('slicc-raw-a');
    capture.expect('slicc-raw-b');
    capture.onHeadersReceived({ url: url('slicc-raw-b'), statusCode: 201 });
    capture.onHeadersReceived({ url: url('slicc-raw-a'), statusCode: 200 });
    expect((await capture.wait('slicc-raw-a', 0))?.status).toBe(200);
    expect((await capture.wait('slicc-raw-b', 0))?.status).toBe(201);
  });

  it('ignores untagged, unexpected and forgotten requests', async () => {
    const capture = createRawFetchCapture();
    capture.onHeadersReceived({ url: 'https://example.com/a', statusCode: 200 });
    capture.onHeadersReceived({ url: url('other-fragment'), statusCode: 200 });
    capture.onHeadersReceived({ url: url('slicc-raw-unknown'), statusCode: 200 });
    expect(await capture.wait('slicc-raw-unknown', 0)).toBeNull();
    capture.expect('slicc-raw-gone');
    capture.forget('slicc-raw-gone');
    capture.onHeadersReceived({ url: url('slicc-raw-gone'), statusCode: 200 });
    expect(await capture.wait('slicc-raw-gone', 0)).toBeNull();
  });

  it('gives up after the timeout and expires stale tags', async () => {
    vi.useFakeTimers();
    let now = 0;
    const capture = createRawFetchCapture(() => now);
    capture.expect('slicc-raw-slow');
    const waiting = capture.wait('slicc-raw-slow', 50);
    await vi.advanceTimersByTimeAsync(60);
    expect(await waiting).toBeNull();
    now = 11 * 60 * 1000;
    capture.expect('slicc-raw-new');
    capture.onHeadersReceived({ url: url('slicc-raw-slow'), statusCode: 200 });
    expect(await capture.wait('slicc-raw-slow', 0)).toBeNull();
  });

  it('listens for service-worker requests with extraHeaders', () => {
    const addListener = vi.fn();
    vi.stubGlobal('chrome', { webRequest: { onHeadersReceived: { addListener } } });
    const capture = createRawFetchCapture();
    installRawFetchCapture(capture);
    const [listener, filter, extra] = addListener.mock.calls[0]!;
    expect(filter).toMatchObject({ urls: ['<all_urls>'], tabId: -1 });
    expect(extra).toEqual(['responseHeaders', 'extraHeaders']);
    capture.expect('slicc-raw-x');
    listener({ url: url('slicc-raw-x'), statusCode: 204, statusLine: 'HTTP/2 204' });
    return expect(capture.wait('slicc-raw-x', 0)).resolves.toMatchObject({
      status: 204,
      statusText: '',
    });
  });
});
