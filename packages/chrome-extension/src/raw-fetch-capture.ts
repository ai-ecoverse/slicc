/**
 * Response-head capture for raw-mode fetches (#3571). A service-worker
 * `fetch` hides exactly what a raw HTTP client needs: `redirect: 'manual'`
 * yields an `opaqueredirect` with status 0 and no headers, `Set-Cookie` is
 * filtered from every response, and repeated headers arrive folded.
 * `webRequest.onHeadersReceived` with `extraHeaders` sees the real status
 * line and every header line, in order.
 *
 * Correlation: each raw request carries a unique `#slicc-raw-<uuid>`
 * fragment. Fragments never go on the wire, but `details.url` keeps them
 * (verified on Chrome for Testing 146 with concurrent fetches of one URL), so
 * two in-flight requests to the same URL cannot be confused. Only tags a
 * session registered with {@link RawFetchCapture.expect} are stored, and
 * each entry expires, so unrelated traffic costs one string check.
 */

import { RAW_FETCH_TAG_PREFIX, type RawHeaderList, reasonFromStatusLine } from '@slicc/shared-ts';

export interface CapturedHead {
  status: number;
  statusText: string;
  headers: RawHeaderList;
}

export interface HeadersReceivedDetails {
  url: string;
  statusCode: number;
  statusLine?: string;
  responseHeaders?: Array<{ name: string; value?: string }>;
}

export interface RawFetchCapture {
  /** Start recording heads for `tag`. */
  expect(tag: string): void;
  /**
   * The latest head recorded for `tag`, waiting up to `timeoutMs` for one to
   * arrive (the event and the `fetch` settle in no fixed order).
   */
  wait(tag: string, timeoutMs: number): Promise<CapturedHead | null>;
  /** Stop recording `tag` and drop what was kept. */
  forget(tag: string): void;
  /** Feed one `onHeadersReceived` event. */
  onHeadersReceived(details: HeadersReceivedDetails): void;
}

interface Entry {
  head: CapturedHead | null;
  waiters: Array<(head: CapturedHead) => void>;
  expires: number;
}

/** How long an unclaimed tag is kept. */
const ENTRY_TTL_MS = 10 * 60 * 1000;

function tagOf(url: string): string | null {
  const hash = url.indexOf('#');
  if (hash < 0) return null;
  const fragment = url.slice(hash + 1);
  return fragment.startsWith(RAW_FETCH_TAG_PREFIX) ? fragment : null;
}

export function createRawFetchCapture(now: () => number = Date.now): RawFetchCapture {
  const entries = new Map<string, Entry>();
  const sweep = () => {
    const t = now();
    for (const [tag, entry] of entries) if (entry.expires < t) entries.delete(tag);
  };
  return {
    expect(tag) {
      sweep();
      entries.set(tag, { head: null, waiters: [], expires: now() + ENTRY_TTL_MS });
    },
    wait(tag, timeoutMs) {
      const entry = entries.get(tag);
      if (!entry) return Promise.resolve(null);
      if (entry.head) return Promise.resolve(entry.head);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(entry.head), timeoutMs);
        entry.waiters.push((head) => {
          clearTimeout(timer);
          resolve(head);
        });
      });
    },
    forget(tag) {
      entries.delete(tag);
    },
    onHeadersReceived(details) {
      const tag = tagOf(details.url);
      const entry = tag ? entries.get(tag) : undefined;
      if (!entry) return;
      entry.head = {
        status: details.statusCode,
        statusText: reasonFromStatusLine(details.statusLine),
        headers: (details.responseHeaders ?? []).map((h): [string, string] => [
          h.name,
          h.value ?? '',
        ]),
      };
      for (const waiter of entry.waiters.splice(0)) waiter(entry.head);
    },
  };
}

/**
 * Wire a capture to `chrome.webRequest`. Service-worker fetches have
 * `tabId: -1`; `extraHeaders` is what exposes `Set-Cookie`.
 */
export function installRawFetchCapture(capture: RawFetchCapture): void {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => capture.onHeadersReceived(details),
    { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other'], tabId: -1 },
    ['responseHeaders', 'extraHeaders']
  );
}
