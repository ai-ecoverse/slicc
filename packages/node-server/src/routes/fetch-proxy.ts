import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { Express, Request, Response } from 'express';
import { FETCH_PROXY_SKIP_HEADERS } from '../fetch-proxy-headers.js';
import type { SecretProxyManager } from '../secrets/proxy-manager.js';

export interface FetchProxyDeps {
  secretProxy: SecretProxyManager;
  /**
   * Optional logger sink for per-request observability. Defaults to
   * `console`. Tests pass a silent sink so the route's logging doesn't
   * leak into test output. The bridge's silence on `Failed to fetch`
   * regressions was the original motivation — see issue tracker for
   * the thin-bridge curl diagnosis.
   */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/** Pick the first value of a possibly-multi-valued request header. */
function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** True when an origin/referer value points at localhost (any family). */
function isLocalhostOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1' ||
      url.hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/** Get the body — either from express.json()'s parsed body or raw chunks. */
async function collectRawBody(req: Request): Promise<Buffer> {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    // Body was already parsed by express.json() — re-serialize it.
    return Buffer.from(JSON.stringify(req.body), 'utf-8');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Build the forwarded header set: copy non-hop-by-hop headers, then restore
 * the forbidden-header transports (Cookie/Origin/Referer/Proxy-*) the browser
 * could not send via fetch(), and force an identity encoding.
 */
function buildForwardHeaders(req: Request, targetUrl: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!FETCH_PROXY_SKIP_HEADERS.has(key) && typeof value === 'string') {
      headers[key] = value;
    }
  }
  // Forbidden-header transport: browser cannot send Cookie via fetch(),
  // so the client encodes it as X-Proxy-Cookie. Restore it here.
  const proxyCookie = firstHeaderValue(req.headers['x-proxy-cookie']);
  if (proxyCookie) headers.cookie = proxyCookie;

  // Forbidden-header transport: restore X-Proxy-Origin → Origin
  const proxyOrigin = firstHeaderValue(req.headers['x-proxy-origin']);
  if (proxyOrigin) {
    headers.origin = proxyOrigin;
  } else if (isLocalhostOrigin(headers.origin)) {
    // Only strip the browser's auto-added localhost origin; preserve legitimate origins.
    delete headers.origin;
  }
  // Default-Origin fallback: synthesize one from the target URL so upstream
  // CORS-protected APIs see a real Origin instead of nothing.
  if (!headers.origin) {
    try {
      headers.origin = new URL(targetUrl).origin;
    } catch {
      // Malformed targetUrl — leave origin unset; the upstream fetch fails anyway.
    }
  }

  // Forbidden-header transport: restore X-Proxy-Referer → Referer
  const proxyReferer = firstHeaderValue(req.headers['x-proxy-referer']);
  if (proxyReferer) {
    headers.referer = proxyReferer;
  } else if (isLocalhostOrigin(headers.referer)) {
    delete headers.referer;
  }

  // Restore any X-Proxy-Proxy-* transport headers as Proxy-* headers
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith('x-proxy-proxy-') && typeof value === 'string') {
      headers[key.replace(/^x-proxy-/, '')] = value;
      delete headers[key];
    }
  }
  // Always request uncompressed responses — the proxy doesn't decompress and
  // the browser→proxy hop is localhost, so compression has no benefit and
  // would arrive as garbage once Content-Encoding is stripped below.
  headers['accept-encoding'] = 'identity';
  return headers;
}

interface ForbiddenSecret {
  secretName: string;
  hostname: string;
}

/**
 * Apply request-side secret injection: unmask headers and URL-embedded
 * credentials. Mutates `headers` to attach a synthetic Authorization when the
 * URL carried credentials. Returns the forbidden descriptor when a masked
 * secret is used against a domain it is not scoped to, else the cleaned URL.
 */
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
  // Attach synthetic Authorization if the URL had credentials and the header isn't already set.
  if (credsResult.syntheticAuthorization && !('authorization' in headers)) {
    headers.authorization = credsResult.syntheticAuthorization;
  }
  return { cleanedUrl: credsResult.url };
}

/**
 * Unmask masked secrets in a text request body. Non-text bodies (git
 * packfiles, octet-stream, images, …) are left untouched — `toString('utf-8')`
 * on arbitrary bytes corrupts them, and masked values never appear in binary.
 */
function unmaskRequestBody(
  secretProxy: SecretProxyManager,
  headers: Record<string, string>,
  rawBody: Buffer,
  targetHostname: string
): Buffer {
  const reqCt = (headers['content-type'] ?? headers['Content-Type'] ?? '').toLowerCase();
  const reqIsText =
    !reqCt ||
    reqCt.startsWith('text/') ||
    reqCt.includes('json') ||
    reqCt.includes('xml') ||
    reqCt.includes('javascript') ||
    reqCt.includes('ecmascript') ||
    reqCt.includes('html') ||
    reqCt.includes('css') ||
    reqCt.includes('svg');
  if (reqIsText && secretProxy.hasSecrets()) {
    const bodyResult = secretProxy.unmaskBody(rawBody.toString('utf-8'), targetHostname);
    return Buffer.from(bodyResult.text, 'utf-8');
  }
  return rawBody;
}

/**
 * Forward the upstream status + response headers, stripping hop-by-hop and
 * www-authenticate (so the browser shows no native Basic Auth dialog) and
 * relaying Set-Cookie out-of-band as X-Proxy-Set-Cookie. All header values are
 * secret-scrubbed.
 */
function forwardUpstreamHeaders(
  res: Response,
  upstream: globalThis.Response,
  secretProxy: SecretProxyManager
): void {
  res.status(upstream.status);
  res.setHeader('Cache-Control', 'no-store, no-cache');

  const setCookieValues = upstream.headers.getSetCookie();
  upstream.headers.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (
      lower !== 'transfer-encoding' &&
      lower !== 'content-encoding' &&
      lower !== 'content-length' &&
      lower !== 'www-authenticate' &&
      lower !== 'set-cookie' &&
      !lower.startsWith('x-proxy-')
    ) {
      // Headers are small — one-shot scrub, no per-chunk semantics.
      res.setHeader(k, secretProxy.scrubResponse(v));
    }
  });
  if (setCookieValues.length > 0) {
    res.setHeader('X-Proxy-Set-Cookie', secretProxy.scrubResponse(JSON.stringify(setCookieValues)));
  }
}

/**
 * Buffer-aware UTF-8 secret scrubber. A `StringDecoder` keeps trailing partial
 * multi-byte sequences out of the scrub so codepoints straddling a chunk
 * boundary aren't corrupted (fatal for CJK/emoji model output). Pass-through
 * when the body is non-text or no secrets are configured.
 */
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
          // All bytes buffered as a partial codepoint — no output yet.
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

/** Stream the upstream body to the client through the secret-scrub transform. */
function streamUpstreamBody(
  res: Response,
  upstream: globalThis.Response,
  secretProxy: SecretProxyManager,
  detachClientClose: () => void
): void {
  const ct = (upstream.headers.get('content-type') ?? '').toLowerCase();
  const isText =
    ct.startsWith('text/') ||
    ct.startsWith('application/json') ||
    ct.includes('charset=') ||
    ct.includes('event-stream');
  const upstreamStream = Readable.fromWeb(
    upstream.body as unknown as import('stream/web').ReadableStream<Uint8Array>
  );
  const scrubChunk = createScrubStream(secretProxy, isText);
  upstreamStream.on('error', (err) => {
    detachClientClose();
    if (!res.headersSent) {
      res.setHeader('X-Proxy-Error', '1');
      res
        .status(502)
        .json({ error: `Proxy stream failed: ${err instanceof Error ? err.message : err}` });
    } else {
      res.destroy(err);
    }
  });
  // Belt-and-braces cleanup: 'finish' fires once the response is fully flushed;
  // 'close' fires regardless of how the response ended. Either way the abort
  // listener should be gone.
  res.on('finish', detachClientClose);
  res.on('close', detachClientClose);
  upstreamStream.pipe(scrubChunk).pipe(res);
}

/**
 * Fetch proxy — forwards cross-origin requests from the browser to bypass
 * CORS (used by just-bash's curl, which calls the browser's fetch() API).
 * Note: express.json() may already have parsed the body, so collectRawBody
 * checks req.body first.
 */
export function registerFetchProxyRoute(app: Express, deps: FetchProxyDeps): void {
  const { secretProxy, logger = console } = deps;

  app.all('/api/fetch-proxy', async (req, res) => {
    const rawBody = await collectRawBody(req);
    const targetUrl = req.headers['x-target-url'] as string;
    if (!targetUrl) {
      logger.warn(`[fetch-proxy] ${req.method} → 400 (missing X-Target-URL)`);
      res.setHeader('X-Proxy-Error', '1');
      res.status(400).json({ error: 'Missing X-Target-URL header' });
      return;
    }
    logger.log(`[fetch-proxy] ${req.method} ${targetUrl}`);
    // Hoisted so the catch handler can detach it on early failures (e.g. fetch
    // threw before the success-path detach could run).
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

      if (Object.keys(headers).length > 0) fetchInit.headers = headers;
      if (rawBody.length > 0 && !['GET', 'HEAD'].includes(req.method)) {
        const body = unmaskRequestBody(secretProxy, headers, rawBody, targetHostname);
        // Buffer extends Uint8Array which is a valid fetch body at runtime.
        fetchInit.body = body as unknown as RequestInit['body'];
      }

      // Propagate client disconnect to the upstream request so long-lived
      // streams (LLM SSE completions) are torn down promptly. Listen on
      // `res.on('close')`, not `req.on('close')` — Node fires req close as soon
      // as the request body is consumed, which would abort before fetch starts.
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
      // Best-effort cleanup so an early failure doesn't leave the close
      // listener attached to the response object.
      detachClientClose();
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[fetch-proxy] ${req.method} ${targetUrl} ← 502 (${message})`);
      res.setHeader('X-Proxy-Error', '1');
      res.status(502).json({ error: `Proxy fetch failed: ${message}` });
    }
  });
}
