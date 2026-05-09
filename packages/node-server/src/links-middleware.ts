/**
 * Express middleware: append SLICC's standard RFC 8288 `Link` header set to
 * every local `/api/*` response that describes a SLICC capability. Mirrors
 * `applySliccLinks` in the cloudflare-worker so any SLICC HTTP surface
 * advertises the same discoverable capabilities.
 *
 * Skipped for `/api/fetch-proxy`: that endpoint is a transparent CORS-bypass
 * relay, so injecting localhost discovery rels there would pollute downstream
 * `discover` consumers with bogus self-referential links. Also bails out if
 * an earlier middleware already flushed response headers.
 */

import type { NextFunction, Request, Response } from 'express';

const SLICC_BASE_REL = (origin: string): string[] => [
  `<${origin}/api>; rel="service-desc"; type="application/json"`,
  `<https://github.com/ai-ecoverse/slicc>; rel="service-doc"`,
  `<https://github.com/ai-ecoverse/slicc#readme>; rel="terms-of-service"`,
];

/**
 * Returns Express middleware that appends Link entries on every `/api/*`
 * response except `/api/fetch-proxy` (a transparent relay). Uses `res.append`
 * so existing Link headers survive intact.
 */
export function sliccLinksMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next();
      return;
    }
    if (!req.path.startsWith('/api/') && req.path !== '/api') {
      next();
      return;
    }
    // `/api/fetch-proxy` and anything mounted underneath it relays a third-
    // party response verbatim — adding our own rels would mislead clients
    // that parse Link headers (e.g. the `discover` shell command).
    if (req.path === '/api/fetch-proxy' || req.path.startsWith('/api/fetch-proxy/')) {
      next();
      return;
    }
    const host = req.headers.host;
    if (!host) {
      next();
      return;
    }
    // The CLI server is always plaintext on localhost.
    const origin = `http://${host}`;
    for (const value of SLICC_BASE_REL(origin)) {
      res.append('Link', value);
    }
    next();
  };
}

/**
 * Build the `GET /api` descriptor — a minimal JSON catalog of localhost
 * endpoints. Mirrors what the cloudflare-worker's `/.well-known/api-catalog`
 * does for the public surface, but scoped to the local CLI server.
 */
export function buildLocalApiDescriptor(host: string): unknown {
  const origin = `http://${host}`;
  return {
    service: 'slicc-node-server',
    description:
      'Localhost server for SLICC standalone (CLI/Electron). State lives in the browser; this surface relays webhooks, signs S3/DA mount requests, and handles cross-agent handoffs.',
    endpoints: [
      {
        anchor: `${origin}/api/runtime-config`,
        method: 'GET',
        description: 'Runtime config for the served webapp.',
      },
      {
        anchor: `${origin}/api/tray-status`,
        method: 'GET',
        description: 'Tray hub connection status.',
      },
      {
        anchor: `${origin}/api/webhooks`,
        method: 'GET|POST',
        description: 'List or create webhooks.',
      },
      {
        anchor: `${origin}/api/crontasks`,
        method: 'GET|POST',
        description: 'List or create crontasks.',
      },
      {
        anchor: `${origin}/api/handoff`,
        method: 'POST',
        description:
          'Profile-independent cross-agent handoff. POST `{ verb: "handoff" | "upskill", target, instruction? }`.',
      },
      {
        anchor: `${origin}/api/secrets`,
        method: 'GET',
        description: 'List secrets defined in the .env file.',
      },
      {
        anchor: `${origin}/api/s3-sign-and-forward`,
        method: 'POST',
        description: 'SigV4-sign and forward an S3 request.',
      },
      {
        anchor: `${origin}/api/da-sign-and-forward`,
        method: 'POST',
        description: 'IMS-token-sign and forward a DA request.',
      },
      {
        anchor: `${origin}/api/fetch-proxy`,
        method: 'ANY',
        description: 'CORS-bypass fetch proxy.',
      },
    ],
  };
}
