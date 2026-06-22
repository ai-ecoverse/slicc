/**
 * Thin-bridge CORS + PNA middleware extracted so it can be imported by both
 * index.ts (live wiring) and route tests (honest gate coverage without having
 * to replicate the logic by hand). The implementation is byte-identical to the
 * closure originally inlined in index.ts — see the comment there for the full
 * security rationale.
 *
 * Pure helper (no index.ts state captured) — it only depends on the public
 * bridge-security primitives.
 */
// tva
import type { RequestHandler } from 'express';
import {
  BRIDGE_TOKEN_HEADER,
  buildCorsHeaders,
  buildPnaPreflightHeaders,
  isLoopbackBridgeOrigin,
  validateBridgeToken,
} from '../bridge-security.js';

/**
 * Thin-bridge CORS + PNA middleware. The hosted leader at sliccy.ai is a
 * cross-origin caller, so headers go on every response for allowlisted
 * origins (so /cdp's pre-WS preflight and every /api/* call succeed);
 * OPTIONS from an allowlisted origin short-circuits to 204 with the PNA
 * opt-in. Non-allowlisted origins fall through with no CORS headers, which
 * preserves same-origin (localhost) behavior unchanged.
 *
 * Additionally enforces the per-process bridge token on cross-origin
 * `/api/*` requests from REMOTE allowlisted origins (sliccy.ai) — the
 * origin allowlist alone is insufficient because any script on
 * `https://www.sliccy.ai` could otherwise reach the local node-server's
 * /api surface (secrets, fetch-proxy, etc.). Loopback allowlisted
 * origins (e.g. the locally-served OAuth callback at
 * `http://localhost:5710/auth/callback` POSTing to `/api/oauth-result`)
 * are exempt — they originate from this same server. OPTIONS preflights
 * are exempt because browsers strip custom headers from preflights.
 */
export function createThinBridgeCorsMiddleware(bridgeToken: string | null): RequestHandler {
  return (req, res, next) => {
    // Reflect the requested headers so the agent's `bash curl -H …` (which
    // can carry arbitrary upstream headers through /api/fetch-proxy) is not
    // blocked by a hardcoded allowlist. Cross-origin preflights advertise
    // those headers via `Access-Control-Request-Headers`.
    const origin = req.headers.origin;
    const cors = buildCorsHeaders(origin, req.headers['access-control-request-headers']);
    if (cors) {
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    }
    if (req.method === 'OPTIONS' && cors) {
      for (const [k, v] of Object.entries(buildPnaPreflightHeaders())) res.setHeader(k, v);
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    // Token gate on /api/* from remote allowlisted origins. `cors` is only
    // truthy when the Origin is in the allowlist; loopback callers
    // (localhost/127.0.0.1) and no-Origin curl-style callers fall through
    // unchanged.
    if (
      cors &&
      req.path.startsWith('/api/') &&
      !isLoopbackBridgeOrigin(origin) &&
      !validateBridgeToken(req.headers[BRIDGE_TOKEN_HEADER.toLowerCase()], bridgeToken)
    ) {
      res.status(403).json({ error: 'bridge-token-required' });
      return;
    }
    next();
  };
}
