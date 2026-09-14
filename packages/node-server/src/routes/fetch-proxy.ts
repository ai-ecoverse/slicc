import { PassThrough, Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
  HMAC_SIGN_HEADER,
  isFormContentType,
  isLoopbackOrigin,
  isTextContentType,
  isTextRequestContentType,
  unmaskFormBody,
} from '@slicc/shared-ts';
import type { Express, Request, Response } from 'express';
import { createMaybeGunzipStream } from '../fetch-proxy-gzip.js';
import {
  buildFetchProxyExposeHeaders,
  FETCH_PROXY_CONTENT_LENGTH_HEADER,
  FETCH_PROXY_SKIP_HEADERS,
  FETCH_PROXY_SKIP_RESPONSE_HEADERS,
  FETCH_PROXY_SKIP_RESPONSE_PREFIXES,
} from '../fetch-proxy-headers.js';
import type { SecretProxyManager } from '../secrets/proxy-manager.js';
import { AgentActivityTracker, registerAgentActivityRoute } from './agent-activity.js';

export interface FetchProxyDeps {
  secretProxy: SecretProxyManager;
  activityTracker?: AgentActivityTracker;

  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

async function collectRawBody(req: Request): Promise<Buffer> {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    return Buffer.from(JSON.stringify(req.body), 'utf-8');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function buildForwardHeaders(req: Request, targetUrl: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!FETCH_PROXY_SKIP_HEADERS.has(key) && typeof value === 'string') {
      headers[key] = value;
    }
  }

  const proxyCookie = firstHeaderValue(req.headers['x-proxy-cookie']);
  if (proxyCookie) headers.cookie = proxyCookie;

  const proxyOrigin = firstHeaderValue(req.headers['x-proxy-origin']);
  if (proxyOrigin) {
    headers.origin = proxyOrigin;
  } else if (isLoopbackOrigin(headers.origin)) {
    delete headers.origin;
  }

  if (!headers.origin) {
    try {
      headers.origin = new URL(targetUrl).origin;
    } catch {}
  }

  const proxyReferer = firstHeaderValue(req.headers['x-proxy-referer']);
  if (proxyReferer) {
    headers.referer = proxyReferer;
  } else if (isLoopbackOrigin(headers.referer)) {
    delete headers.referer;
  }

  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith('x-proxy-proxy-') && typeof value === 'string') {
      headers[key.replace(/^x-proxy-/, '')] = value;
      delete headers[key];
    }
  }
  return headers;
}

interface ForbiddenSecret {
  secretName: string;
  hostname: string;
}

function injectRequestSecrets(
  secretProxy: SecretProxyManager,
  headers: Record<string, string>,
  targetUrl: string,
  targetHostname: string
): { forbidden: ForbiddenSecret } | { cleanedUrl: string } {
  if (!secretProxy.hasSecrets()) return { cleanedUrl: targetUrl };

  const headerResult = secretProxy.unmaskHeaders(headers, targetHostname);
  if (headerResult.forbidden) return { forbidden: headerResult.forbidden };

  const credsResult = secretProxy.extractAndUnmaskUrlCredentials(targetUrl);
  if (credsResult.forbidden) return { forbidden: credsResult.forbidden };

  if (credsResult.syntheticAuthorization && !('authorization' in headers)) {
    headers.authorization = credsResult.syntheticAuthorization;
  }
  return { cleanedUrl: credsResult.url };
}

async function applyHmacSigning(
  secretProxy: SecretProxyManager,
  headers: Record<string, string>,
  hmacSpec: string | undefined,
  body: Buffer | undefined,
  targetHostname: string
): Promise<{ forbidden: ForbiddenSecret } | undefined> {
  if (!hmacSpec) return undefined;
  const signResult = await secretProxy.signHmac(hmacSpec, body ?? Buffer.alloc(0), targetHostname);
  if (signResult.forbidden) return { forbidden: signResult.forbidden };
  if (signResult.headerName && signResult.signatureHex) {
    headers[signResult.headerName] = signResult.signatureHex;
  }
  if (signResult.timestampHeaderName && signResult.timestampValue) {
    headers[signResult.timestampHeaderName] = signResult.timestampValue;
  }
  return undefined;
}

function unmaskRequestBody(
  secretProxy: SecretProxyManager,
  headers: Record<string, string>,
  rawBody: Buffer,
  targetHostname: string
): Buffer {
  const contentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
  if (!isTextRequestContentType(contentType) || !secretProxy.hasSecrets()) return rawBody;
  const body = rawBody.toString('utf-8');
  const { text } = isFormContentType(contentType)
    ? unmaskFormBody(secretProxy, body, targetHostname)
    : secretProxy.unmaskBody(body, targetHostname);
  return text === body ? rawBody : Buffer.from(text, 'utf-8');
}

function forwardUpstreamHeaders(
  res: Response,
  upstream: globalThis.Response,
  secretProxy: SecretProxyManager
): void {
  res.status(upstream.status);
  res.setHeader('Cache-Control', 'no-store, no-cache');

  const forwardedNames: string[] = [];
  const setCookieValues = upstream.headers.getSetCookie();
  upstream.headers.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (FETCH_PROXY_SKIP_RESPONSE_HEADERS.has(lower)) return;
    if (FETCH_PROXY_SKIP_RESPONSE_PREFIXES.some((p) => lower.startsWith(p))) return;

    res.setHeader(k, secretProxy.scrubResponse(v));
    forwardedNames.push(k);
  });
  if (setCookieValues.length > 0) {
    res.setHeader('X-Proxy-Set-Cookie', secretProxy.scrubResponse(JSON.stringify(setCookieValues)));
  }

  const upstreamLength = upstream.headers.get('content-length');
  if (upstreamLength && !upstream.headers.get('content-encoding') && /^\d+$/.test(upstreamLength)) {
    res.setHeader(FETCH_PROXY_CONTENT_LENGTH_HEADER, upstreamLength);
  }

  res.setHeader('Access-Control-Expose-Headers', buildFetchProxyExposeHeaders(forwardedNames));
}

function createScrubStream(secretProxy: SecretProxyManager, isText: boolean): Transform {
  const utf8Decoder = new StringDecoder('utf8');
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!isText || !secretProxy.hasSecrets()) {
        cb(null, chunk);
        return;
      }
      try {
        const decoded = utf8Decoder.write(chunk);
        if (decoded.length === 0) {
          cb(null, Buffer.alloc(0));
          return;
        }
        cb(null, Buffer.from(secretProxy.scrubResponse(decoded), 'utf-8'));
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      if (!isText || !secretProxy.hasSecrets()) {
        cb();
        return;
      }
      try {
        const tail = utf8Decoder.end();
        if (tail.length === 0) {
          cb();
          return;
        }
        cb(null, Buffer.from(secretProxy.scrubResponse(tail), 'utf-8'));
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

function streamUpstreamBody(
  res: Response,
  upstream: globalThis.Response,
  secretProxy: SecretProxyManager,
  detachClientClose: () => void
): void {
  const isText = isTextContentType(upstream.headers.get('content-type') ?? '');
  const upstreamStream = Readable.fromWeb(
    upstream.body as unknown as import('stream/web').ReadableStream<Uint8Array>
  );

  const decoded = isText
    ? createMaybeGunzipStream({
        onDecided: (inflating) => {
          if (inflating) res.removeHeader(FETCH_PROXY_CONTENT_LENGTH_HEADER);
        },
      })
    : new PassThrough();
  const scrubChunk = createScrubStream(secretProxy, isText);
  const onStreamError = (err: Error) => {
    detachClientClose();
    if (!res.headersSent) {
      res.setHeader('X-Proxy-Error', '1');
      res.status(502).json({ error: `Proxy stream failed: ${err.message}` });
    } else {
      res.destroy(err);
    }
  };
  upstreamStream.on('error', onStreamError);
  decoded.on('error', onStreamError);

  res.on('finish', detachClientClose);
  res.on('close', detachClientClose);
  upstreamStream.pipe(decoded).pipe(scrubChunk).pipe(res);
}

export function registerFetchProxyRoute(app: Express, deps: FetchProxyDeps): void {
  const { secretProxy, activityTracker = new AgentActivityTracker(), logger = console } = deps;
  registerAgentActivityRoute(app, activityTracker);

  app.all('/api/fetch-proxy', async (req, res) => {
    if (req.method !== 'OPTIONS') activityTracker.recordActivity();
    const rawBody = await collectRawBody(req);
    const targetUrl = req.headers['x-target-url'] as string;
    if (!targetUrl) {
      logger.warn(`[fetch-proxy] ${req.method} → 400 (missing X-Target-URL)`);
      res.setHeader('X-Proxy-Error', '1');
      res.status(400).json({ error: 'Missing X-Target-URL header' });
      return;
    }
    logger.log(`[fetch-proxy] ${req.method} ${targetUrl}`);

    let onClientClose: (() => void) | null = null;
    const detachClientClose = () => {
      if (onClientClose) {
        res.off('close', onClientClose);
        onClientClose = null;
      }
    };
    try {
      const fetchInit: RequestInit = { method: req.method, redirect: 'follow' };
      const headers = buildForwardHeaders(req, targetUrl);

      let targetHostname: string;
      try {
        targetHostname = new URL(targetUrl).hostname;
      } catch {
        targetHostname = '';
      }

      const injection = injectRequestSecrets(secretProxy, headers, targetUrl, targetHostname);
      if ('forbidden' in injection) {
        logger.warn(
          `[fetch-proxy] ${req.method} ${targetUrl} → 403 (secret "${injection.forbidden.secretName}" not allowed for "${injection.forbidden.hostname}")`
        );
        res.setHeader('X-Proxy-Error', '1');
        res.status(403).json({
          error: `Secret "${injection.forbidden.secretName}" is not allowed for domain "${injection.forbidden.hostname}"`,
        });
        return;
      }

      let body: Buffer | undefined;
      if (rawBody.length > 0 && !['GET', 'HEAD'].includes(req.method)) {
        body = unmaskRequestBody(secretProxy, headers, rawBody, targetHostname);

        fetchInit.body = body as unknown as RequestInit['body'];
      }

      const hmacSpec = firstHeaderValue(req.headers[HMAC_SIGN_HEADER]);
      const signing = await applyHmacSigning(secretProxy, headers, hmacSpec, body, targetHostname);
      if (signing) {
        logger.warn(
          `[fetch-proxy] ${req.method} ${targetUrl} → 403 (secret "${signing.forbidden.secretName}" not allowed for "${signing.forbidden.hostname}")`
        );
        res.setHeader('X-Proxy-Error', '1');
        res.status(403).json({
          error: `Secret "${signing.forbidden.secretName}" is not allowed for domain "${signing.forbidden.hostname}"`,
        });
        return;
      }

      if (Object.keys(headers).length > 0) fetchInit.headers = headers;

      const abortController = new AbortController();
      onClientClose = () => {
        if (!res.writableEnded) abortController.abort();
      };
      res.on('close', onClientClose);
      fetchInit.signal = abortController.signal;

      const upstream = await fetch(injection.cleanedUrl, fetchInit);
      logger.log(`[fetch-proxy] ${req.method} ${targetUrl} ← ${upstream.status}`);
      forwardUpstreamHeaders(res, upstream, secretProxy);

      if (!upstream.body) {
        res.end();
        detachClientClose();
        return;
      }
      streamUpstreamBody(res, upstream, secretProxy, detachClientClose);
    } catch (err: unknown) {
      detachClientClose();
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[fetch-proxy] ${req.method} ${targetUrl} ← 502 (${message})`);
      res.setHeader('X-Proxy-Error', '1');
      res.status(502).json({ error: `Proxy fetch failed: ${message}` });
    }
  });
}
