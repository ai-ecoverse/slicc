/**
 * Network request capture and retrieval subcommands.
 *
 * Subscribes to Network CDP events for a tab on first `requests` call,
 * accumulates entries in a ring buffer, and filters/returns them on demand.
 *
 * Commands: requests, request, request-headers, request-body,
 *           response-headers, response-body
 */

import { requireTab } from '../state.js';
import type {
  NetworkEntry,
  PlaywrightHandler,
  PlaywrightHandlerCtx,
  PlaywrightState,
} from '../types.js';

// Derived from the handler context rather than imported from `cdp/` so this
// module stays inside the shell layer (see layer-stack import direction).
type CDPTransport = ReturnType<PlaywrightHandlerCtx['browser']['getTransport']>;

/** Fields read off a `Network.requestWillBeSent` CDP event. */
interface NetworkRequestWillBeSentEvent {
  sessionId?: string;
  requestId?: string;
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    postData?: string;
  };
}

/** Fields read off a `Network.responseReceived` CDP event. */
interface NetworkResponseReceivedEvent {
  sessionId?: string;
  requestId?: string;
  response?: {
    status?: number;
    headers?: Record<string, string>;
    mimeType?: string;
  };
}

/** Fields read off a `Network.loadingFinished` CDP event. */
interface NetworkLoadingFinishedEvent {
  sessionId?: string;
  requestId?: string;
}

/** Fields read off a `Network.getResponseBody` CDP result. */
interface NetworkGetResponseBodyResult {
  body?: string;
  base64Encoded?: boolean;
}

const RING_BUFFER_SIZE = 500;

const STATIC_MIMES = ['image/', 'font/', 'text/css', 'application/javascript', 'text/javascript'];

function isStaticResource(mimeType: string | null, url: string): boolean {
  if (mimeType && STATIC_MIMES.some((m) => mimeType.startsWith(m))) return true;
  try {
    const path = new URL(url).pathname;
    return /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|otf|css|js|mjs)$/i.test(path);
  } catch {
    return false;
  }
}

/** Start capturing network requests for a tab if not already subscribed. */
function ensureCapturing(
  state: PlaywrightState,
  transport: CDPTransport,
  targetId: string,
  sessionId: string
): void {
  if (state.networkCleanup.has(targetId)) return;

  state.networkRequests.set(targetId, []);
  state.networkRequestIndex.set(targetId, new Map());
  let nextIndex = 1;

  const onRequest = (rawParams: Parameters<Parameters<CDPTransport['on']>[1]>[0]) => {
    const params = rawParams as NetworkRequestWillBeSentEvent;
    if (params.sessionId !== sessionId) return;
    const requestId = params.requestId;
    const request = params.request;
    if (!requestId || !request) return;

    const entries = state.networkRequests.get(targetId);
    const index = state.networkRequestIndex.get(targetId);
    if (!entries || !index) return;

    const url = request.url ?? '';
    const entry: NetworkEntry = {
      index: nextIndex++,
      requestId,
      method: request.method ?? 'GET',
      url,
      requestHeaders: request.headers ?? {},
      requestBody: request.postData != null ? String(request.postData) : null,
      status: null,
      responseHeaders: null,
      responseBody: null,
      responseBodyBase64: false,
      mimeType: null,
      isStatic: isStaticResource(null, url),
      timestamp: Date.now(),
    };

    entries.push(entry);
    index.set(requestId, entry);
    if (entries.length > RING_BUFFER_SIZE) {
      const evicted = entries.splice(0, entries.length - RING_BUFFER_SIZE);
      for (const e of evicted) index.delete(e.requestId);
    }
  };

  const onResponse = (rawParams: Parameters<Parameters<CDPTransport['on']>[1]>[0]) => {
    const params = rawParams as NetworkResponseReceivedEvent;
    if (params.sessionId !== sessionId) return;
    const requestId = params.requestId;
    const response = params.response;
    if (!requestId || !response) return;

    const entry = state.networkRequestIndex.get(targetId)?.get(requestId);
    if (!entry) return;

    entry.status = response.status ?? null;
    entry.responseHeaders = response.headers ?? null;
    entry.mimeType = response.mimeType ?? null;
    entry.isStatic = isStaticResource(entry.mimeType, entry.url);
  };

  const onLoadingFinished = (rawParams: Parameters<Parameters<CDPTransport['on']>[1]>[0]) => {
    const params = rawParams as NetworkLoadingFinishedEvent;
    if (params.sessionId !== sessionId) return;
    const requestId = params.requestId;
    if (!requestId) return;

    const entry = state.networkRequestIndex.get(targetId)?.get(requestId);
    if (!entry || entry.isStatic || entry.responseBody !== null) return;

    transport
      .send('Network.getResponseBody', { requestId }, sessionId)
      .then((result) => {
        const r = result as NetworkGetResponseBodyResult | undefined;
        if (!r) return;
        entry.responseBody = r.body ?? null;
        // Chrome tells us how the body is encoded; keep the flag instead of
        // guessing from MIME later (matches `cdp/har-recorder.ts`).
        entry.responseBodyBase64 = r.base64Encoded === true;
      })
      .catch(() => {
        // Body may not be available for all resource types — ignore
      });
  };

  transport.on('Network.requestWillBeSent', onRequest);
  transport.on('Network.responseReceived', onResponse);
  transport.on('Network.loadingFinished', onLoadingFinished);

  state.networkCleanup.set(targetId, () => {
    transport.off('Network.requestWillBeSent', onRequest);
    transport.off('Network.responseReceived', onResponse);
    transport.off('Network.loadingFinished', onLoadingFinished);
  });
}

/** Decoded response-body bytes, or the reason the body cannot be decoded. */
type DecodedBody = { bytes: Uint8Array } | { error: string };

/**
 * Index of the first unpaired surrogate in `s`, or -1 when the string is
 * well-formed. `TextEncoder` silently turns those into U+FFFD, which is the
 * one substitution a saved file must never get.
 */
function findLoneSurrogate(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code >= 0xdc00) return i; // trailing surrogate with no lead
    const next = s.charCodeAt(i + 1);
    if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return i;
    i++; // well-formed pair — skip its low half
  }
  return -1;
}

/**
 * Turn a captured CDP body into the exact bytes Chrome received.
 *
 * `Network.getResponseBody` reports its own encoding via `base64Encoded`, so
 * that flag — never the MIME type — decides how the body is read. A base64
 * JPEG labelled `text/plain` is still base64; a UTF-8 JSON document labelled
 * `application/octet-stream` is still text. Anything that cannot be decoded
 * faithfully is an error, not a best-effort write.
 */
function decodeResponseBody(body: string, base64Encoded: boolean): DecodedBody {
  if (base64Encoded) {
    let binary: string;
    try {
      binary = atob(body);
    } catch {
      return { error: 'response body is flagged base64 but is not valid base64' };
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
    return { bytes };
  }
  const lone = findLoneSurrogate(body);
  if (lone >= 0) {
    return {
      error: `response body has an unpaired surrogate at index ${lone} and cannot be saved without substituting U+FFFD`,
    };
  }
  return { bytes: new TextEncoder().encode(body) };
}

/** Look up an entry by 1-based display index. */
function findEntry(
  state: PlaywrightState,
  targetId: string,
  indexStr: string
): NetworkEntry | null {
  const idx = parseInt(indexStr, 10);
  if (!Number.isFinite(idx) || idx < 1) return null;
  const entries = state.networkRequests.get(targetId) ?? [];
  return entries.find((e) => e.index === idx) ?? null;
}

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------

export const requestsHandler: PlaywrightHandler = async ({ browser, state, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  if (!state.networkCleanup.has(tab.targetId)) {
    await browser.withTab(tab.targetId, async (sessionId) => {
      const transport = browser.getTransport();
      await transport.send('Network.enable', {}, sessionId);
      ensureCapturing(state, transport, tab.targetId, sessionId);
    });
  }

  const showStatic = flags['static'] === 'true';
  const filterRegex = flags['filter'];
  const clear = flags['clear'] === 'true';

  let entries = state.networkRequests.get(tab.targetId) ?? [];

  if (!showStatic) entries = entries.filter((e) => !e.isStatic);
  if (filterRegex) {
    let re: RegExp;
    try {
      re = new RegExp(filterRegex);
    } catch {
      return { stdout: '', stderr: `Invalid filter regex: ${filterRegex}\n`, exitCode: 1 };
    }
    entries = entries.filter((e) => re.test(e.url));
  }

  if (clear) {
    state.networkRequests.set(tab.targetId, []);
    state.networkRequestIndex.set(tab.targetId, new Map());
  }

  if (entries.length === 0) {
    return { stdout: 'No requests\n', stderr: '', exitCode: 0 };
  }

  const lines = entries.map((e) => `${e.index} ${e.method} ${e.url} → ${e.status ?? 'pending'}`);
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
};

// ---------------------------------------------------------------------------
// request <index>
// ---------------------------------------------------------------------------

export const requestHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  fs,
}) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  if (!state.networkCleanup.has(tab.targetId)) {
    await browser.withTab(tab.targetId, async (sessionId) => {
      const transport = browser.getTransport();
      await transport.send('Network.enable', {}, sessionId);
      ensureCapturing(state, transport, tab.targetId, sessionId);
    });
  }

  const indexStr = positional[0] ?? '';
  const entry = findEntry(state, tab.targetId, indexStr);
  if (!entry) {
    return { stdout: '', stderr: `No request at index ${indexStr}\n`, exitCode: 1 };
  }

  const parts: string[] = [
    `Method: ${entry.method}`,
    `URL: ${entry.url}`,
    `Status: ${entry.status ?? 'pending'}`,
    '',
    'Request Headers:',
    ...Object.entries(entry.requestHeaders).map(([k, v]) => `  ${k}: ${v}`),
  ];

  if (entry.requestBody !== null) {
    parts.push('', `Request Body: ${entry.requestBody}`);
  }

  if (entry.responseHeaders !== null) {
    parts.push('', 'Response Headers:');
    parts.push(...Object.entries(entry.responseHeaders).map(([k, v]) => `  ${k}: ${v}`));
  }

  if (entry.responseBody !== null) {
    const body = entry.responseBody;
    const preview = body.length > 4096 ? body.slice(0, 4096) + '\n... (truncated)' : body;
    // Say so when the preview is base64 — `response-body --filename` is what
    // turns it back into bytes.
    const label = entry.responseBodyBase64 ? 'Response Body (base64)' : 'Response Body';
    parts.push('', `${label}:\n${preview}`);
  }

  const output = parts.join('\n') + '\n';

  const filename = flags['filename'];
  if (filename) {
    await fs.writeFile(filename, output);
    return { stdout: `Saved to ${filename}\n`, stderr: '', exitCode: 0 };
  }

  return { stdout: output, stderr: '', exitCode: 0 };
};

// ---------------------------------------------------------------------------
// request-headers <index>
// ---------------------------------------------------------------------------

export const requestHeadersHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  fs,
}) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  if (!state.networkCleanup.has(tab.targetId)) {
    await browser.withTab(tab.targetId, async (sessionId) => {
      const transport = browser.getTransport();
      await transport.send('Network.enable', {}, sessionId);
      ensureCapturing(state, transport, tab.targetId, sessionId);
    });
  }

  const indexStr = positional[0] ?? '';
  const entry = findEntry(state, tab.targetId, indexStr);
  if (!entry) {
    return { stdout: '', stderr: `No request at index ${indexStr}\n`, exitCode: 1 };
  }

  const lines = Object.entries(entry.requestHeaders).map(([k, v]) => `${k}: ${v}`);
  const output = lines.join('\n') + '\n';

  const filename = flags['filename'];
  if (filename) {
    await fs.writeFile(filename, output);
    return { stdout: `Saved to ${filename}\n`, stderr: '', exitCode: 0 };
  }

  return { stdout: output, stderr: '', exitCode: 0 };
};

// ---------------------------------------------------------------------------
// request-body <index>
// ---------------------------------------------------------------------------

export const requestBodyHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  fs,
}) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  if (!state.networkCleanup.has(tab.targetId)) {
    await browser.withTab(tab.targetId, async (sessionId) => {
      const transport = browser.getTransport();
      await transport.send('Network.enable', {}, sessionId);
      ensureCapturing(state, transport, tab.targetId, sessionId);
    });
  }

  const indexStr = positional[0] ?? '';
  const entry = findEntry(state, tab.targetId, indexStr);
  if (!entry) {
    return { stdout: '', stderr: `No request at index ${indexStr}\n`, exitCode: 1 };
  }

  if (entry.requestBody === null) {
    return { stdout: '(no request body)\n', stderr: '', exitCode: 0 };
  }

  const filename = flags['filename'];
  if (filename) {
    await fs.writeFile(filename, entry.requestBody);
    return { stdout: `Saved to ${filename}\n`, stderr: '', exitCode: 0 };
  }

  return { stdout: entry.requestBody + '\n', stderr: '', exitCode: 0 };
};

// ---------------------------------------------------------------------------
// response-headers <index>
// ---------------------------------------------------------------------------

export const responseHeadersHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  fs,
}) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  if (!state.networkCleanup.has(tab.targetId)) {
    await browser.withTab(tab.targetId, async (sessionId) => {
      const transport = browser.getTransport();
      await transport.send('Network.enable', {}, sessionId);
      ensureCapturing(state, transport, tab.targetId, sessionId);
    });
  }

  const indexStr = positional[0] ?? '';
  const entry = findEntry(state, tab.targetId, indexStr);
  if (!entry) {
    return { stdout: '', stderr: `No request at index ${indexStr}\n`, exitCode: 1 };
  }

  if (entry.responseHeaders === null) {
    return { stdout: '(response not yet received)\n', stderr: '', exitCode: 0 };
  }

  const lines = Object.entries(entry.responseHeaders).map(([k, v]) => `${k}: ${v}`);
  const output = lines.join('\n') + '\n';

  const filename = flags['filename'];
  if (filename) {
    await fs.writeFile(filename, output);
    return { stdout: `Saved to ${filename}\n`, stderr: '', exitCode: 0 };
  }

  return { stdout: output, stderr: '', exitCode: 0 };
};

// ---------------------------------------------------------------------------
// response-body <index>
// ---------------------------------------------------------------------------

export const responseBodyHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  fs,
}) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  if (!state.networkCleanup.has(tab.targetId)) {
    await browser.withTab(tab.targetId, async (sessionId) => {
      const transport = browser.getTransport();
      await transport.send('Network.enable', {}, sessionId);
      ensureCapturing(state, transport, tab.targetId, sessionId);
    });
  }

  const indexStr = positional[0] ?? '';
  const entry = findEntry(state, tab.targetId, indexStr);
  if (!entry) {
    return { stdout: '', stderr: `No request at index ${indexStr}\n`, exitCode: 1 };
  }

  if (entry.responseBody === null) {
    return { stdout: '(response body not yet available)\n', stderr: '', exitCode: 0 };
  }

  const filename = flags['filename'];

  const decoded = decodeResponseBody(entry.responseBody, entry.responseBodyBase64);
  if ('error' in decoded) {
    return { stdout: '', stderr: `Request ${indexStr}: ${decoded.error}\n`, exitCode: 1 };
  }

  if (filename) {
    await fs.writeFile(filename, decoded.bytes);
    return { stdout: `Saved to ${filename}\n`, stderr: '', exitCode: 0 };
  }

  // MIME only picks the rendering on stdout — it never touched the bytes above.
  const isBinary =
    entry.mimeType !== null &&
    !entry.mimeType.startsWith('text/') &&
    !entry.mimeType.includes('json') &&
    !entry.mimeType.includes('javascript') &&
    !entry.mimeType.includes('xml');

  if (isBinary) {
    return { stdout: `[binary body, ${decoded.bytes.length} bytes]\n`, stderr: '', exitCode: 0 };
  }

  const body = entry.responseBodyBase64
    ? new TextDecoder().decode(decoded.bytes)
    : entry.responseBody;
  const preview = body.length > 4096 ? body.slice(0, 4096) + '\n... (truncated)' : body;
  return { stdout: preview + '\n', stderr: '', exitCode: 0 };
};
