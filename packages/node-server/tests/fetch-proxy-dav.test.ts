import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FETCH_PROXY_SKIP_HEADERS } from '../src/fetch-proxy-headers.js';

/**
 * Regression coverage for WebDAV / CalDAV verbs (PROPFIND, REPORT,
 * MKCALENDAR, LOCK) traversing the Node `/api/fetch-proxy` route.
 *
 * The production handler at `packages/node-server/src/index.ts`
 * (`app.all('/api/fetch-proxy', ...)`) is inline and tightly coupled
 * to `secretProxy`. Per the task scope, it is NOT extracted into a
 * separate module. Instead — following the pattern in
 * `fetch-proxy-raw-body.test.ts` — this test mirrors the slice of
 * the handler responsible for verb / body / header pass-through.
 * Keep this mirror in sync with `index.ts` if the proxy changes.
 */

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function buildUpstream(): {
  server: http.Server;
  baseUrl: () => string;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.statusCode = 207;
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
    });
  });
  return {
    server,
    baseUrl: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    captured,
  };
}

function buildProxyApp(): Express {
  const app = express();
  app.use(
    express.json({
      limit: '50mb',
      type: (req) =>
        req.headers['x-slicc-raw-body'] !== '1' &&
        (req.headers['content-type'] ?? '').includes('application/json'),
    })
  );
  app.all('/api/fetch-proxy', async (req, res) => {
    let rawBody: Buffer;
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      rawBody = Buffer.from(JSON.stringify(req.body), 'utf-8');
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      rawBody = Buffer.concat(chunks);
    }
    const targetUrl = req.headers['x-target-url'] as string;
    if (!targetUrl) {
      res.status(400).json({ error: 'Missing X-Target-URL header' });
      return;
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!FETCH_PROXY_SKIP_HEADERS.has(key) && typeof value === 'string') {
        headers[key] = value;
      }
    }
    const fetchInit: RequestInit = { method: req.method, redirect: 'follow' };
    if (Object.keys(headers).length > 0) fetchInit.headers = headers;
    if (rawBody.length > 0 && !['GET', 'HEAD'].includes(req.method)) {
      fetchInit.body = rawBody as unknown as RequestInit['body'];
    }
    const upstream = await fetch(targetUrl, fetchInit);
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (
        lower !== 'transfer-encoding' &&
        lower !== 'content-encoding' &&
        lower !== 'content-length'
      ) {
        res.setHeader(k, v);
      }
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  });
  return app;
}

describe('fetch-proxy WebDAV / CalDAV verb pass-through', () => {
  let proxyServer: http.Server;
  let proxyUrl: string;
  let upstream: ReturnType<typeof buildUpstream>;

  beforeEach(async () => {
    upstream = buildUpstream();
    await new Promise<void>((resolve) => upstream.server.listen(0, resolve));
    proxyServer = http.createServer(buildProxyApp());
    await new Promise<void>((resolve) => proxyServer.listen(0, resolve));
    proxyUrl = `http://127.0.0.1:${(proxyServer.address() as AddressInfo).port}/api/fetch-proxy`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  });

  it('forwards PROPFIND with XML body and Depth header (207 round-trip)', async () => {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>';
    const res = await fetch(proxyUrl, {
      method: 'PROPFIND',
      headers: {
        'X-Target-URL': `${upstream.baseUrl()}/calendars/user/`,
        'Content-Type': 'application/xml; charset=utf-8',
        Depth: '1',
      },
      body,
    });
    expect(res.status).toBe(207);
    expect(upstream.captured).toHaveLength(1);
    const cap = upstream.captured[0]!;
    expect(cap.method).toBe('PROPFIND');
    expect(cap.headers['depth']).toBe('1');
    expect(cap.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(cap.body.toString('utf-8')).toBe(body);
  });

  it('forwards REPORT with a CalDAV calendar-query XML body', async () => {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
      '<d:prop><d:getetag/><c:calendar-data/></d:prop>' +
      '<c:filter><c:comp-filter name="VCALENDAR"/></c:filter>' +
      '</c:calendar-query>';
    const res = await fetch(proxyUrl, {
      method: 'REPORT',
      headers: {
        'X-Target-URL': `${upstream.baseUrl()}/calendars/user/default/`,
        'Content-Type': 'application/xml; charset=utf-8',
        Depth: '1',
      },
      body,
    });
    expect(res.status).toBe(207);
    expect(upstream.captured).toHaveLength(1);
    const cap = upstream.captured[0]!;
    expect(cap.method).toBe('REPORT');
    expect(cap.headers['depth']).toBe('1');
    expect(cap.body.toString('utf-8')).toBe(body);
  });

  it('forwards MKCALENDAR with no body and preserves the verb', async () => {
    const res = await fetch(proxyUrl, {
      method: 'MKCALENDAR',
      headers: {
        'X-Target-URL': `${upstream.baseUrl()}/calendars/user/new/`,
      },
    });
    expect(res.status).toBe(207);
    expect(upstream.captured).toHaveLength(1);
    const cap = upstream.captured[0]!;
    expect(cap.method).toBe('MKCALENDAR');
    expect(cap.body.length).toBe(0);
  });

  it('forwards LOCK with a body and Timeout: Second-300 header', async () => {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:lockinfo xmlns:d="DAV:">' +
      '<d:lockscope><d:exclusive/></d:lockscope>' +
      '<d:locktype><d:write/></d:locktype>' +
      '<d:owner><d:href>mailto:user@example.com</d:href></d:owner>' +
      '</d:lockinfo>';
    const res = await fetch(proxyUrl, {
      method: 'LOCK',
      headers: {
        'X-Target-URL': `${upstream.baseUrl()}/files/doc.txt`,
        'Content-Type': 'application/xml; charset=utf-8',
        Timeout: 'Second-300',
      },
      body,
    });
    expect(res.status).toBe(207);
    expect(upstream.captured).toHaveLength(1);
    const cap = upstream.captured[0]!;
    expect(cap.method).toBe('LOCK');
    expect(cap.headers['timeout']).toBe('Second-300');
    expect(cap.body.toString('utf-8')).toBe(body);
  });
});

describe('FETCH_PROXY_SKIP_HEADERS does not strip DAV headers', () => {
  it('forwards Depth, Timeout, If, Lock-Token, Destination, Overwrite', () => {
    for (const header of ['depth', 'timeout', 'if', 'lock-token', 'destination', 'overwrite']) {
      expect(FETCH_PROXY_SKIP_HEADERS.has(header)).toBe(false);
    }
  });
});
