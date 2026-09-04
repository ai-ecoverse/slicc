import { describe, expect, it, vi } from 'vitest';
import type { VirtualFS } from '../../../../../src/fs/index.js';
import {
  requestBodyHandler,
  requestHandler,
  requestHeadersHandler,
  requestsHandler,
  responseBodyHandler,
  responseHeadersHandler,
} from '../../../../../src/shell/supplemental-commands/playwright/handlers/network-requests.js';
import type {
  NetworkEntry,
  PlaywrightState,
} from '../../../../../src/shell/supplemental-commands/playwright/types.js';
import {
  createHandlerCtx,
  createMockBrowser,
  createMockTransport,
  createPlaywrightState,
} from '../../../helpers/playwright-harness.js';

const TAB = 'tab-1';

function makeEntry(over: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    index: 1,
    requestId: 'r1',
    method: 'GET',
    url: 'https://example.com/api',
    requestHeaders: { accept: 'application/json' },
    requestBody: null,
    status: 200,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: null,
    responseBodyBase64: false,
    mimeType: 'application/json',
    isStatic: false,
    timestamp: 0,
    ...over,
  };
}

/** A `writeFile` spy whose recorded arguments stay typed for byte assertions. */
function mockWriteFile() {
  return vi.fn(async (_path: string, _data: string | Uint8Array) => undefined);
}

/** Seed a state that already has captured entries (capture branch skipped). */
function seeded(entries: NetworkEntry[]): PlaywrightState {
  const state = createPlaywrightState();
  state.networkCleanup.set(TAB, () => {});
  state.networkRequests.set(TAB, entries);
  const index = new Map(entries.map((e) => [e.requestId, e]));
  state.networkRequestIndex.set(TAB, index);
  return state;
}

describe('network-requests handlers', () => {
  it('requires a --tab flag', async () => {
    const result = await requestsHandler(createHandlerCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--tab');
  });

  it('captures requests, responses, and bodies through the CDP event pipeline', async () => {
    const transport = createMockTransport((method) =>
      method === 'Network.getResponseBody' ? { body: 'PAYLOAD', base64Encoded: false } : {}
    );
    const { browser } = createMockBrowser({ transport, sessionId: 'session-1' });
    const state = createPlaywrightState();
    const ctx = createHandlerCtx({ browser, state, flags: { tab: TAB } });

    // First call subscribes and reports nothing yet.
    const empty = await requestsHandler(ctx);
    expect(empty.stdout).toBe('No requests\n');
    expect(transport.send).toHaveBeenCalledWith('Network.enable', {}, 'session-1');
    expect(transport.hasListener('Network.requestWillBeSent')).toBe(true);

    // Drive the captured CDP events.
    await transport.emit('Network.requestWillBeSent', {
      sessionId: 'session-1',
      requestId: 'r1',
      request: { url: 'https://example.com/data', method: 'POST', headers: {}, postData: 'q=1' },
    });
    await transport.emit('Network.responseReceived', {
      sessionId: 'session-1',
      requestId: 'r1',
      response: { status: 201, headers: { 'x-h': '1' }, mimeType: 'text/html' },
    });
    await transport.emit('Network.loadingFinished', { sessionId: 'session-1', requestId: 'r1' });

    const listed = await requestsHandler(ctx);
    expect(listed.stdout).toContain('1 POST https://example.com/data → 201');
    const entry = state.networkRequests.get(TAB)![0];
    expect(entry.responseBody).toBe('PAYLOAD');
    expect(entry.responseBodyBase64).toBe(false);
  });

  it('ignores events from a different session', async () => {
    const transport = createMockTransport();
    const { browser } = createMockBrowser({ transport, sessionId: 'session-1' });
    const state = createPlaywrightState();
    const ctx = createHandlerCtx({ browser, state, flags: { tab: TAB } });
    await requestsHandler(ctx);
    await transport.emit('Network.requestWillBeSent', {
      sessionId: 'other',
      requestId: 'r9',
      request: { url: 'x', method: 'GET', headers: {} },
    });
    expect(state.networkRequests.get(TAB)!.length).toBe(0);
  });

  it('filters out static resources unless --static is set', async () => {
    const state = seeded([
      makeEntry({ index: 1, requestId: 'a', url: 'https://x/app.js', isStatic: true }),
      makeEntry({ index: 2, requestId: 'b', url: 'https://x/api' }),
    ]);
    const hidden = await requestsHandler(createHandlerCtx({ state, flags: { tab: TAB } }));
    expect(hidden.stdout).not.toContain('app.js');
    expect(hidden.stdout).toContain('api');

    const shown = await requestsHandler(
      createHandlerCtx({ state, flags: { tab: TAB, static: 'true' } })
    );
    expect(shown.stdout).toContain('app.js');
  });

  it('applies a URL filter regex and rejects an invalid one', async () => {
    const state = seeded([
      makeEntry({ index: 1, requestId: 'a', url: 'https://x/keep' }),
      makeEntry({ index: 2, requestId: 'b', url: 'https://x/drop' }),
    ]);
    const filtered = await requestsHandler(
      createHandlerCtx({ state, flags: { tab: TAB, filter: 'keep' } })
    );
    expect(filtered.stdout).toContain('keep');
    expect(filtered.stdout).not.toContain('drop');

    const bad = await requestsHandler(
      createHandlerCtx({ state, flags: { tab: TAB, filter: '(' } })
    );
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('Invalid filter regex');
  });

  it('clears captured requests when --clear is set', async () => {
    const state = seeded([makeEntry()]);
    await requestsHandler(createHandlerCtx({ state, flags: { tab: TAB, clear: 'true' } }));
    expect(state.networkRequests.get(TAB)!.length).toBe(0);
  });

  it('request prints full detail and errors on a bad index', async () => {
    const state = seeded([makeEntry({ requestBody: 'q=1' })]);
    const detail = await requestHandler(
      createHandlerCtx({ state, positional: ['1'], flags: { tab: TAB } })
    );
    expect(detail.stdout).toContain('Method: GET');
    expect(detail.stdout).toContain('Request Body: q=1');
    expect(detail.stdout).toContain('Response Headers:');

    const missing = await requestHandler(
      createHandlerCtx({ state, positional: ['9'], flags: { tab: TAB } })
    );
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('No request at index 9');
  });

  it('request saves to a file when --filename is given', async () => {
    const writeFile = mockWriteFile();
    const state = seeded([makeEntry()]);
    const result = await requestHandler(
      createHandlerCtx({
        state,
        positional: ['1'],
        flags: { tab: TAB, filename: '/out.txt' },
        fs: { writeFile: writeFile as unknown as VirtualFS['writeFile'] },
      })
    );
    expect(result.stdout).toBe('Saved to /out.txt\n');
    expect(writeFile).toHaveBeenCalledWith('/out.txt', expect.any(String));
  });

  it('request-headers renders header lines', async () => {
    const state = seeded([makeEntry({ requestHeaders: { a: '1', b: '2' } })]);
    const result = await requestHeadersHandler(
      createHandlerCtx({ state, positional: ['1'], flags: { tab: TAB } })
    );
    expect(result.stdout).toContain('a: 1');
    expect(result.stdout).toContain('b: 2');
  });

  it('request-body reports absence and presence', async () => {
    const none = await requestBodyHandler(
      createHandlerCtx({ state: seeded([makeEntry()]), positional: ['1'], flags: { tab: TAB } })
    );
    expect(none.stdout).toBe('(no request body)\n');

    const some = await requestBodyHandler(
      createHandlerCtx({
        state: seeded([makeEntry({ requestBody: 'BODY' })]),
        positional: ['1'],
        flags: { tab: TAB },
      })
    );
    expect(some.stdout).toBe('BODY\n');
  });

  it('response-headers reports pending vs received', async () => {
    const pending = await responseHeadersHandler(
      createHandlerCtx({
        state: seeded([makeEntry({ responseHeaders: null })]),
        positional: ['1'],
        flags: { tab: TAB },
      })
    );
    expect(pending.stdout).toContain('response not yet received');

    const got = await responseHeadersHandler(
      createHandlerCtx({
        state: seeded([makeEntry({ responseHeaders: { 'x-y': 'z' } })]),
        positional: ['1'],
        flags: { tab: TAB },
      })
    );
    expect(got.stdout).toContain('x-y: z');
  });

  it('response-body reports text, binary summary, and unavailable', async () => {
    const none = await responseBodyHandler(
      createHandlerCtx({
        state: seeded([makeEntry({ responseBody: null })]),
        positional: ['1'],
        flags: { tab: TAB },
      })
    );
    expect(none.stdout).toContain('not yet available');

    const text = await responseBodyHandler(
      createHandlerCtx({
        state: seeded([makeEntry({ responseBody: 'hello', mimeType: 'text/plain' })]),
        positional: ['1'],
        flags: { tab: TAB },
      })
    );
    expect(text.stdout).toBe('hello\n');

    const binary = await responseBodyHandler(
      createHandlerCtx({
        state: seeded([
          makeEntry({
            responseBody: btoa('abc'),
            responseBodyBase64: true,
            mimeType: 'image/png',
          }),
        ]),
        positional: ['1'],
        flags: { tab: TAB },
      })
    );
    expect(binary.stdout).toBe('[binary body, 3 bytes]\n');
  });

  it('response-body decodes binary bytes when saving to a file', async () => {
    const writeFile = mockWriteFile();
    const state = seeded([
      makeEntry({ responseBody: btoa('abc'), responseBodyBase64: true, mimeType: 'image/png' }),
    ]);
    const result = await responseBodyHandler(
      createHandlerCtx({
        state,
        positional: ['1'],
        flags: { tab: TAB, filename: '/img.png' },
        fs: { writeFile: writeFile as unknown as VirtualFS['writeFile'] },
      })
    );
    expect(result.stdout).toBe('Saved to /img.png\n');
    expect(writeFile).toHaveBeenCalledWith('/img.png', expect.any(Uint8Array));
  });

  it('keeps the CDP base64Encoded flag on capture', async () => {
    const transport = createMockTransport((method) =>
      method === 'Network.getResponseBody' ? { body: btoa('abc'), base64Encoded: true } : {}
    );
    const { browser } = createMockBrowser({ transport, sessionId: 'session-1' });
    const state = createPlaywrightState();
    const ctx = createHandlerCtx({ browser, state, flags: { tab: TAB } });
    await requestsHandler(ctx);

    await transport.emit('Network.requestWillBeSent', {
      sessionId: 'session-1',
      requestId: 'r1',
      request: { url: 'https://example.com/blob', method: 'GET', headers: {} },
    });
    await transport.emit('Network.responseReceived', {
      sessionId: 'session-1',
      requestId: 'r1',
      response: { status: 200, headers: {}, mimeType: 'application/octet-stream' },
    });
    await transport.emit('Network.loadingFinished', { sessionId: 'session-1', requestId: 'r1' });

    const entry = state.networkRequests.get(TAB)![0];
    expect(entry.responseBodyBase64).toBe(true);
  });

  it('response-body --filename writes base64 bodies byte-for-byte', async () => {
    // Every byte value, the fixture a UTF-8 hop expands and `atob` cannot fake.
    const original = new Uint8Array(256).map((_, i) => i);
    const latin1 = String.fromCharCode(...original);
    const writeFile = mockWriteFile();
    const state = seeded([
      makeEntry({
        responseBody: btoa(latin1),
        responseBodyBase64: true,
        mimeType: 'image/jpeg',
      }),
    ]);
    const result = await responseBodyHandler(
      createHandlerCtx({
        state,
        positional: ['1'],
        flags: { tab: TAB, filename: '/out.bin' },
        fs: { writeFile: writeFile as unknown as VirtualFS['writeFile'] },
      })
    );
    expect(result.exitCode).toBe(0);
    const written = writeFile.mock.calls[0][1] as unknown as Uint8Array;
    expect(written).toBeInstanceOf(Uint8Array);
    expect(written.length).toBe(256);
    expect(Array.from(written)).toEqual(Array.from(original));
  });

  it('response-body --filename trusts the flag over the MIME type', async () => {
    // Chrome base64s bodies it cannot decode as text whatever the label says;
    // the old MIME heuristic wrote the base64 alphabet to the file instead.
    const writeFile = mockWriteFile();
    const state = seeded([
      makeEntry({
        responseBody: btoa('\x00\x01\x02binary'),
        responseBodyBase64: true,
        mimeType: 'text/plain',
      }),
    ]);
    await responseBodyHandler(
      createHandlerCtx({
        state,
        positional: ['1'],
        flags: { tab: TAB, filename: '/out.bin' },
        fs: { writeFile: writeFile as unknown as VirtualFS['writeFile'] },
      })
    );
    const written = writeFile.mock.calls[0][1] as unknown as Uint8Array;
    expect(Array.from(written)).toEqual([
      0,
      1,
      2,
      ...Array.from(new TextEncoder().encode('binary')),
    ]);
  });

  it('response-body --filename writes text bodies as UTF-8 text', async () => {
    const writeFile = mockWriteFile();
    const body = '{"hé":"ok 😀"}';
    const state = seeded([
      makeEntry({ responseBody: body, responseBodyBase64: false, mimeType: 'application/json' }),
    ]);
    await responseBodyHandler(
      createHandlerCtx({
        state,
        positional: ['1'],
        flags: { tab: TAB, filename: '/out.json' },
        fs: { writeFile: writeFile as unknown as VirtualFS['writeFile'] },
      })
    );
    const written = writeFile.mock.calls[0][1] as unknown as Uint8Array;
    expect(new TextDecoder().decode(written)).toBe(body);
  });

  it('response-body --filename does not base64-decode an unflagged binary-looking body', async () => {
    // `base64Encoded: false` means Chrome handed us text — the label is not a
    // licence to run `atob` over it (the old path wrote garbage or the string).
    const latin1 = String.fromCharCode(...new Uint8Array(256).map((_, i) => i));
    const writeFile = mockWriteFile();
    const state = seeded([
      makeEntry({ responseBody: latin1, responseBodyBase64: false, mimeType: 'image/jpeg' }),
    ]);
    const result = await responseBodyHandler(
      createHandlerCtx({
        state,
        positional: ['1'],
        flags: { tab: TAB, filename: '/out.bin' },
        fs: { writeFile: writeFile as unknown as VirtualFS['writeFile'] },
      })
    );
    expect(result.exitCode).toBe(0);
    const written = writeFile.mock.calls[0][1] as unknown as Uint8Array;
    expect(Array.from(written)).toEqual(Array.from(new TextEncoder().encode(latin1)));
  });

  it('response-body fails instead of writing U+FFFD for an unpaired surrogate', async () => {
    const writeFile = mockWriteFile();
    const state = seeded([
      makeEntry({
        responseBody: `head\uD800tail`,
        responseBodyBase64: false,
        mimeType: 'text/plain',
      }),
    ]);
    const result = await responseBodyHandler(
      createHandlerCtx({
        state,
        positional: ['1'],
        flags: { tab: TAB, filename: '/out.txt' },
        fs: { writeFile: writeFile as unknown as VirtualFS['writeFile'] },
      })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unpaired surrogate');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('response-body fails when a base64-flagged body is not valid base64', async () => {
    const writeFile = mockWriteFile();
    const state = seeded([
      makeEntry({ responseBody: 'not base64!!', responseBodyBase64: true, mimeType: 'image/png' }),
    ]);
    const result = await responseBodyHandler(
      createHandlerCtx({
        state,
        positional: ['1'],
        flags: { tab: TAB, filename: '/out.png' },
        fs: { writeFile: writeFile as unknown as VirtualFS['writeFile'] },
      })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not valid base64');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('response-body prints a base64 text body as text, not the base64 alphabet', async () => {
    const result = await responseBodyHandler(
      createHandlerCtx({
        state: seeded([
          makeEntry({
            responseBody: btoa('hello'),
            responseBodyBase64: true,
            mimeType: 'text/plain',
          }),
        ]),
        positional: ['1'],
        flags: { tab: TAB },
      })
    );
    expect(result.stdout).toBe('hello\n');
  });

  it('the header/body detail handlers all honor --filename', async () => {
    const cases: Array<[typeof requestHeadersHandler, NetworkEntry]> = [
      [requestHeadersHandler, makeEntry()],
      [requestBodyHandler, makeEntry({ requestBody: 'B' })],
      [responseHeadersHandler, makeEntry()],
      [responseBodyHandler, makeEntry({ responseBody: 'text', mimeType: 'text/plain' })],
    ];
    for (const [handler, entry] of cases) {
      const writeFile = mockWriteFile();
      const result = await handler(
        createHandlerCtx({
          state: seeded([entry]),
          positional: ['1'],
          flags: { tab: TAB, filename: '/o' },
          fs: { writeFile: writeFile as unknown as VirtualFS['writeFile'] },
        })
      );
      expect(result.stdout).toBe('Saved to /o\n');
      expect(writeFile).toHaveBeenCalledOnce();
    }
  });

  it('subscribes lazily when a detail handler runs before requests', async () => {
    const transport = createMockTransport();
    const { browser } = createMockBrowser({ transport, sessionId: 'session-1' });
    const state = createPlaywrightState();
    const result = await requestHandler(
      createHandlerCtx({ browser, state, positional: ['1'], flags: { tab: TAB } })
    );
    // No entries captured yet → index miss, but the capture branch ran.
    expect(result.exitCode).toBe(1);
    expect(transport.send).toHaveBeenCalledWith('Network.enable', {}, 'session-1');
    expect(state.networkCleanup.has(TAB)).toBe(true);
  });
});
