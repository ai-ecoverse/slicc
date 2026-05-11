import { type SecretsPipeline } from '@slicc/shared';

export const REQUEST_BODY_CAP = 32 * 1024 * 1024;

export interface PortLike {
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
}

interface RequestMsg {
  type: 'request';
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64?: string;
  requestBodyTooLarge?: boolean;
}

function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Variant that accepts a Promise for the pipeline so the caller can attach
 * the onMessage listener SYNCHRONOUSLY in the onConnect callback — Chrome
 * drops port messages that arrive before any listener exists, and the
 * page-side caller posts its request immediately after connect (before
 * the async pipeline build completes). The listener awaits the pipeline
 * before processing.
 */
export function handleFetchProxyConnectionAsync(
  port: PortLike,
  pipelinePromise: Promise<SecretsPipeline>
): void {
  const ac = new AbortController();
  let started = false;

  port.onDisconnect.addListener(() => ac.abort());

  port.onMessage.addListener(async (raw) => {
    if (started) return;
    started = true;
    const msg = raw as RequestMsg;
    if (msg.type !== 'request') return;

    if (msg.requestBodyTooLarge) {
      port.postMessage({
        type: 'response-head',
        status: 413,
        statusText: 'Payload Too Large',
        headers: {},
      });
      port.postMessage({ type: 'response-end' });
      return;
    }

    let pipeline: SecretsPipeline;
    try {
      pipeline = await pipelinePromise;
    } catch (err) {
      port.postMessage({
        type: 'response-error',
        error: `fetch-proxy init failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    try {
      const credsResult = pipeline.extractAndUnmaskUrlCredentials(msg.url);
      if (credsResult.forbidden) {
        port.postMessage({
          type: 'response-error',
          error: `forbidden: ${credsResult.forbidden.secretName} on ${credsResult.forbidden.hostname}`,
        });
        return;
      }
      const cleanedUrl = credsResult.url;
      const host = new URL(cleanedUrl).host;

      const headers: Record<string, string> = { ...msg.headers };
      const headersResult = pipeline.unmaskHeaders(headers, host);
      if (headersResult.forbidden) {
        port.postMessage({
          type: 'response-error',
          error: `forbidden: ${headersResult.forbidden.secretName} on ${headersResult.forbidden.hostname}`,
        });
        return;
      }
      if (credsResult.syntheticAuthorization && !('authorization' in headers)) {
        headers.authorization = credsResult.syntheticAuthorization;
      }

      let body: Uint8Array | undefined;
      if (msg.bodyBase64) {
        const raw = decodeBase64Bytes(msg.bodyBase64);
        body = pipeline.unmaskBodyBytes(raw, host).bytes;
      }

      const upstream = await fetch(cleanedUrl, {
        method: msg.method,
        headers,
        body: body as BodyInit | undefined,
        signal: ac.signal,
      });
      const respHeaders = pipeline.scrubHeaders(upstream.headers);
      port.postMessage({
        type: 'response-head',
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });

      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const scrubbed = pipeline.scrubResponseBytes(value);
          port.postMessage({ type: 'response-chunk', dataBase64: encodeBase64Bytes(scrubbed) });
        }
      }
      port.postMessage({ type: 'response-end' });
    } catch (err) {
      port.postMessage({
        type: 'response-error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export function handleFetchProxyConnection(port: PortLike, pipeline: SecretsPipeline): void {
  const ac = new AbortController();
  let started = false;

  port.onDisconnect.addListener(() => ac.abort());

  port.onMessage.addListener(async (raw) => {
    if (started) return;
    started = true;
    const msg = raw as RequestMsg;
    if (msg.type !== 'request') return;

    if (msg.requestBodyTooLarge) {
      port.postMessage({
        type: 'response-head',
        status: 413,
        statusText: 'Payload Too Large',
        headers: {},
      });
      port.postMessage({ type: 'response-end' });
      return;
    }

    try {
      const credsResult = pipeline.extractAndUnmaskUrlCredentials(msg.url);
      if (credsResult.forbidden) {
        port.postMessage({
          type: 'response-error',
          error: `forbidden: ${credsResult.forbidden.secretName} on ${credsResult.forbidden.hostname}`,
        });
        return;
      }
      const cleanedUrl = credsResult.url;
      const host = new URL(cleanedUrl).host;

      const headers: Record<string, string> = { ...msg.headers };
      const headersResult = pipeline.unmaskHeaders(headers, host);
      if (headersResult.forbidden) {
        port.postMessage({
          type: 'response-error',
          error: `forbidden: ${headersResult.forbidden.secretName} on ${headersResult.forbidden.hostname}`,
        });
        return;
      }
      if (credsResult.syntheticAuthorization && !('authorization' in headers)) {
        headers.authorization = credsResult.syntheticAuthorization;
      }

      let body: Uint8Array | undefined;
      if (msg.bodyBase64) {
        const raw = decodeBase64Bytes(msg.bodyBase64);
        body = pipeline.unmaskBodyBytes(raw, host).bytes;
      }

      const upstream = await fetch(cleanedUrl, {
        method: msg.method,
        headers,
        body: body as BodyInit | undefined,
        signal: ac.signal,
      });
      const respHeaders = pipeline.scrubHeaders(upstream.headers);
      port.postMessage({
        type: 'response-head',
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });

      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          // Byte-safe scrub — no TextDecoder round-trip, so binary chunks
          // (git packfiles, ZIPs, images) survive intact. Chunk-boundary
          // scrub limitation matches CLI behavior: a coincidental real-value
          // straddling a chunk boundary leaks through. v2: carry-over window.
          const scrubbed = pipeline.scrubResponseBytes(value);
          port.postMessage({ type: 'response-chunk', dataBase64: encodeBase64Bytes(scrubbed) });
        }
      }
      port.postMessage({ type: 'response-end' });
    } catch (err) {
      port.postMessage({
        type: 'response-error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
