/**
 * SW-side helper for extension-delegate fetch mode (see
 * `llm-proxy-sw-config.ts` for the architecture note).
 *
 * The LLM-proxy SW cannot reach `chrome.runtime`, so it hands a delegated
 * request to a window client (the pinned leader tab) over a transferred
 * `MessagePort` and consumes the response back over that same port. This
 * module owns the consumer half: it turns the inbound `ResponseMsg` stream
 * (`response-head` → 0..N `response-chunk` → `response-end`, or a terminal
 * `response-error`) into a streamed `Response`, so SSE token-by-token UX is
 * preserved end-to-end (no buffering of the whole body).
 *
 * Extracted from `llm-proxy-sw.ts` so it can be unit-tested without a
 * `ServiceWorkerGlobalScope` — `buildDelegatedResponseStream` only needs a
 * structural port (`onmessage` + optional `start`/`close`).
 */

import type { ResponseMsg } from '../../../chrome-extension/src/fetch-proxy-shared.js';
import { decodeForbiddenResponseHeaders } from '../shell/proxy-headers.js';

/**
 * Minimal structural view of the SW-retained `MessageChannel.port1`. A real
 * `MessagePort` satisfies it; tests pass a stub and drive `onmessage` by hand.
 */
export interface DelegateResponsePort {
  onmessage: ((event: MessageEvent) => void) | null;
  start?: () => void;
  close?: () => void;
}

/** Statuses that forbid a body argument on the `Response` constructor. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Consume the delegated `ResponseMsg` stream off `port` and resolve a streamed
 * `Response`. The returned promise resolves as soon as `response-head` arrives
 * (body bytes then flow into the stream as `response-chunk`s land); it rejects
 * only when `response-error` arrives BEFORE any `response-head` — a mid-stream
 * error after the head errors the body stream instead, matching how a real
 * network failure surfaces on an already-returned `Response`.
 */
export function buildDelegatedResponseStream(port: DelegateResponsePort): {
  responsePromise: Promise<Response>;
} {
  let resolveResp!: (r: Response) => void;
  let rejectResp!: (e: Error) => void;
  const responsePromise = new Promise<Response>((res, rej) => {
    resolveResp = res;
    rejectResp = rej;
  });

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  let headReceived = false;
  let terminated = false;

  const closeStream = (): void => {
    try {
      controller?.close();
    } catch {
      /* already closed */
    }
  };
  const errorStream = (err: Error): void => {
    try {
      controller?.error(err);
    } catch {
      /* already errored */
    }
  };

  const onHead = (msg: Extract<ResponseMsg, { type: 'response-head' }>): void => {
    if (headReceived) return;
    headReceived = true;
    const headers = new Headers();
    for (const [k, v] of Object.entries(decodeForbiddenResponseHeaders(msg.headers))) {
      headers.set(k, v);
    }
    // Null-body statuses (101/103/204/205/304) forbid a body argument on the
    // Response constructor — see `ui/llm-proxy-response.ts` for the full
    // rationale. No chunks are expected to follow for these statuses.
    const body = NULL_BODY_STATUSES.has(msg.status) ? null : stream;
    resolveResp(new Response(body, { status: msg.status, statusText: msg.statusText, headers }));
  };

  const onError = (msg: Extract<ResponseMsg, { type: 'response-error' }>): void => {
    terminated = true;
    const err = new Error(msg.error);
    if (headReceived) errorStream(err);
    else rejectResp(err);
    port.close?.();
  };

  port.onmessage = (event: MessageEvent) => {
    const msg = event.data as ResponseMsg;
    if (!msg || typeof (msg as { type?: unknown }).type !== 'string' || terminated) return;
    if (msg.type === 'response-head') onHead(msg);
    else if (msg.type === 'response-chunk') controller?.enqueue(decodeBase64Bytes(msg.dataBase64));
    else if (msg.type === 'response-end') {
      terminated = true;
      closeStream();
      port.close?.();
    } else if (msg.type === 'response-error') onError(msg);
  };

  port.start?.();
  return { responsePromise };
}
