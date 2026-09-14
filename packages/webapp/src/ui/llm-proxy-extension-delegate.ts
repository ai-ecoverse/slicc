import type { FetchProxyResponseMsg } from '@slicc/shared-ts';
import { decodeForbiddenResponseHeaders } from '../shell/proxy-headers.js';

export interface DelegateResponsePort {
  onmessage: ((event: MessageEvent) => void) | null;
  start?: () => void;
  close?: () => void;
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

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
    } catch {}
  };
  const errorStream = (err: Error): void => {
    try {
      controller?.error(err);
    } catch {}
  };

  const onHead = (msg: Extract<FetchProxyResponseMsg, { type: 'response-head' }>): void => {
    if (headReceived) return;
    headReceived = true;
    const headers = new Headers();
    for (const [k, v] of Object.entries(decodeForbiddenResponseHeaders(msg.headers))) {
      headers.set(k, v);
    }

    const body = NULL_BODY_STATUSES.has(msg.status) ? null : stream;
    resolveResp(new Response(body, { status: msg.status, statusText: msg.statusText, headers }));
  };

  const onError = (msg: Extract<FetchProxyResponseMsg, { type: 'response-error' }>): void => {
    terminated = true;
    const err = new Error(msg.error);
    if (headReceived) errorStream(err);
    else rejectResp(err);
    port.close?.();
  };

  port.onmessage = (event: MessageEvent) => {
    const msg = event.data as FetchProxyResponseMsg;
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
