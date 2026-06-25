/**
 * Network request capture and retrieval subcommands.
 *
 * Subscribes to Network CDP events for a tab on first `requests` call,
 * accumulates entries in a ring buffer, and filters/returns them on demand.
 *
 * Commands: requests, request, request-headers, request-body,
 *           response-headers, response-body
 */

import type { CDPTransport } from '../../../../cdp/transport.js';
import { requireTab } from '../state.js';
import type { NetworkEntry, PlaywrightHandler, PlaywrightState } from '../types.js';

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

  const onRequest = (params: Record<string, unknown>) => {
    if ((params['sessionId'] as string | undefined) !== sessionId) return;
    const requestId = params['requestId'] as string;
    const request = params['request'] as Record<string, unknown> | undefined;
    if (!request) return;

    const entries = state.networkRequests.get(targetId);
    const index = state.networkRequestIndex.get(targetId);
    if (!entries || !index) return;

    const url = (request['url'] as string | undefined) ?? '';
    const entry: NetworkEntry = {
      index: nextIndex++,
      requestId,
      method: (request['method'] as string | undefined) ?? 'GET',
      url,
      requestHeaders: (request['headers'] as Record<string, string> | undefined) ?? {},
      requestBody:
        (request['postData'] as string | undefined) != null ? String(request['postData']) : null,
      status: null,
      responseHeaders: null,
      responseBody: null,
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

  const onResponse = (params: Record<string, unknown>) => {
    if ((params['sessionId'] as string | undefined) !== sessionId) return;
    const requestId = params['requestId'] as string;
    const response = params['response'] as Record<string, unknown> | undefined;
    if (!response) return;

    const entry = state.networkRequestIndex.get(targetId)?.get(requestId);
    if (!entry) return;

    entry.status = (response['status'] as number | undefined) ?? null;
    entry.responseHeaders = (response['headers'] as Record<string, string> | undefined) ?? null;
    entry.mimeType = (response['mimeType'] as string | undefined) ?? null;
    entry.isStatic = isStaticResource(entry.mimeType, entry.url);
  };

  const onLoadingFinished = (params: Record<string, unknown>) => {
    if ((params['sessionId'] as string | undefined) !== sessionId) return;
    const requestId = params['requestId'] as string;

    const entry = state.networkRequestIndex.get(targetId)?.get(requestId);
    if (!entry || entry.isStatic || entry.responseBody !== null) return;

    transport
      .send('Network.getResponseBody', { requestId }, sessionId)
      .then((result) => {
        const r = result as { body?: string; base64Encoded?: boolean } | undefined;
        if (!r) return;
        entry.responseBody = r.body ?? null;
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
    parts.push('', `Response Body:\n${preview}`);
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

  const isBinary =
    entry.mimeType !== null &&
    !entry.mimeType.startsWith('text/') &&
    !entry.mimeType.includes('json') &&
    !entry.mimeType.includes('javascript') &&
    !entry.mimeType.includes('xml');

  if (filename) {
    if (isBinary) {
      try {
        const binary = atob(entry.responseBody);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        await fs.writeFile(filename, bytes);
      } catch {
        await fs.writeFile(filename, entry.responseBody);
      }
    } else {
      await fs.writeFile(filename, entry.responseBody);
    }
    return { stdout: `Saved to ${filename}\n`, stderr: '', exitCode: 0 };
  }

  if (isBinary) {
    try {
      const byteLength = atob(entry.responseBody).length;
      return { stdout: `[binary body, ${byteLength} bytes]\n`, stderr: '', exitCode: 0 };
    } catch {
      // Fall through and show raw
    }
  }

  const body = entry.responseBody;
  const preview = body.length > 4096 ? body.slice(0, 4096) + '\n... (truncated)' : body;
  return { stdout: preview + '\n', stderr: '', exitCode: 0 };
};
