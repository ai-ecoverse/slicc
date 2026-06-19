import { describe, expect, it } from 'vitest';

import {
  BRIDGE_ALLOWED_ORIGINS,
  BRIDGE_SUBPROTOCOL_PREFIX,
  buildCorsHeaders,
  buildPnaPreflightHeaders,
  isAllowedBridgeOrigin,
  mintBridgeToken,
  parseSubprotocolHeader,
  selectBridgeSubprotocol,
  validateBridgeUpgrade,
} from '../src/bridge-security.js';

const PROD_ORIGIN = 'https://www.sliccy.ai';
const TOKEN = 'aabbccdd-1122-3344-5566-778899aabbcc';

describe('isAllowedBridgeOrigin', () => {
  it('accepts every entry in BRIDGE_ALLOWED_ORIGINS', () => {
    for (const origin of BRIDGE_ALLOWED_ORIGINS) {
      expect(isAllowedBridgeOrigin(origin)).toBe(true);
    }
  });

  it('rejects unrelated, partial, and empty origins', () => {
    expect(isAllowedBridgeOrigin(undefined)).toBe(false);
    expect(isAllowedBridgeOrigin(null)).toBe(false);
    expect(isAllowedBridgeOrigin('')).toBe(false);
    expect(isAllowedBridgeOrigin('https://evil.example.com')).toBe(false);
    // Subdomain spoof: only the exact origin is allowed.
    expect(isAllowedBridgeOrigin('https://www.sliccy.ai.evil.com')).toBe(false);
    // Scheme mismatch.
    expect(isAllowedBridgeOrigin('http://www.sliccy.ai')).toBe(false);
    // Trailing slash is not a valid Origin and must not match.
    expect(isAllowedBridgeOrigin('https://www.sliccy.ai/')).toBe(false);
  });
});

describe('mintBridgeToken', () => {
  it('returns a UUID-shaped token that differs each call', () => {
    const a = mintBridgeToken();
    const b = mintBridgeToken();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});

describe('parseSubprotocolHeader', () => {
  it('handles comma-separated, whitespace, array, and empty inputs', () => {
    expect(parseSubprotocolHeader(undefined)).toEqual([]);
    expect(parseSubprotocolHeader('')).toEqual([]);
    expect(parseSubprotocolHeader('a, b,   c')).toEqual(['a', 'b', 'c']);
    expect(parseSubprotocolHeader(['a', 'b,c'])).toEqual(['a', 'b', 'c']);
    expect(parseSubprotocolHeader(', ,a, ,')).toEqual(['a']);
  });
});

describe('selectBridgeSubprotocol', () => {
  it('returns the matching subprotocol string', () => {
    const proto = `${BRIDGE_SUBPROTOCOL_PREFIX}${TOKEN}`;
    expect(selectBridgeSubprotocol([proto], TOKEN)).toBe(proto);
    expect(selectBridgeSubprotocol(['other', proto, 'extra'], TOKEN)).toBe(proto);
  });

  it('returns null on missing, mismatched, or empty token', () => {
    const proto = `${BRIDGE_SUBPROTOCOL_PREFIX}${TOKEN}`;
    expect(selectBridgeSubprotocol([], TOKEN)).toBeNull();
    expect(selectBridgeSubprotocol([proto], 'other-token')).toBeNull();
    expect(selectBridgeSubprotocol(['unrelated'], TOKEN)).toBeNull();
    expect(selectBridgeSubprotocol([proto], '')).toBeNull();
  });
});

describe('validateBridgeUpgrade', () => {
  const proto = `${BRIDGE_SUBPROTOCOL_PREFIX}${TOKEN}`;

  it('accepts allowlisted origin + matching subprotocol', () => {
    const res = validateBridgeUpgrade({
      origin: PROD_ORIGIN,
      subprotocolHeader: proto,
      expectedToken: TOKEN,
    });
    expect(res).toEqual({ ok: true, acceptedSubprotocol: proto });
  });

  it('rejects when origin is not allowlisted (even if subprotocol matches)', () => {
    const res = validateBridgeUpgrade({
      origin: 'https://evil.example.com',
      subprotocolHeader: proto,
      expectedToken: TOKEN,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('origin-not-allowed');
    expect(res.acceptedSubprotocol).toBeNull();
  });

  it('rejects when origin is missing entirely', () => {
    const res = validateBridgeUpgrade({
      origin: undefined,
      subprotocolHeader: proto,
      expectedToken: TOKEN,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('origin-not-allowed');
  });

  it('rejects allowlisted origin with no Sec-WebSocket-Protocol header', () => {
    const res = validateBridgeUpgrade({
      origin: PROD_ORIGIN,
      subprotocolHeader: undefined,
      expectedToken: TOKEN,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('subprotocol-missing-or-mismatched');
  });

  it('rejects allowlisted origin with wrong token in subprotocol', () => {
    const res = validateBridgeUpgrade({
      origin: PROD_ORIGIN,
      subprotocolHeader: `${BRIDGE_SUBPROTOCOL_PREFIX}wrong-token`,
      expectedToken: TOKEN,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('subprotocol-missing-or-mismatched');
  });
});

describe('buildCorsHeaders', () => {
  it('returns CORS headers echoing an allowlisted origin', () => {
    const headers = buildCorsHeaders(PROD_ORIGIN);
    expect(headers).not.toBeNull();
    expect(headers!['Access-Control-Allow-Origin']).toBe(PROD_ORIGIN);
    expect(headers!['Access-Control-Allow-Credentials']).toBe('true');
    expect(headers!['Access-Control-Allow-Methods']).toContain('OPTIONS');
    expect(headers!['Access-Control-Allow-Headers']).toContain('Content-Type');
    expect(headers!['Access-Control-Allow-Headers']).toContain('X-Target-URL');
    expect(headers!['Access-Control-Allow-Headers']).toContain('X-Proxy-Cookie');
    expect(headers!['Access-Control-Expose-Headers']).toContain('X-Proxy-Error');
    expect(headers!['Access-Control-Expose-Headers']).toContain('X-Proxy-Set-Cookie');
    expect(headers!.Vary).toBe('Origin, Access-Control-Request-Headers');
  });

  it('returns null for non-allowlisted origins', () => {
    expect(buildCorsHeaders('https://evil.example.com')).toBeNull();
    expect(buildCorsHeaders(undefined)).toBeNull();
  });

  it('reflects unknown headers from Access-Control-Request-Headers', () => {
    const headers = buildCorsHeaders(PROD_ORIGIN, 'X-Custom-Upstream, Anthropic-Version');
    expect(headers).not.toBeNull();
    const allow = headers!['Access-Control-Allow-Headers'];
    expect(allow).toContain('X-Custom-Upstream');
    expect(allow).toContain('Anthropic-Version');
    // Base headers are still present.
    expect(allow).toContain('Content-Type');
  });

  it('skips reflected headers that are already in the base set', () => {
    const headers = buildCorsHeaders(PROD_ORIGIN, 'content-type, X-Target-URL, X-Other');
    const allow = headers!['Access-Control-Allow-Headers'];
    // The base canonical casing wins; no duplicate of Content-Type or X-Target-URL.
    expect(allow.match(/Content-Type/gi)?.length ?? 0).toBe(1);
    expect(allow.match(/X-Target-URL/gi)?.length ?? 0).toBe(1);
    expect(allow).toContain('X-Other');
  });

  it('accepts string[] Access-Control-Request-Headers (Node header shape)', () => {
    const headers = buildCorsHeaders(PROD_ORIGIN, ['X-One', 'X-Two']);
    const allow = headers!['Access-Control-Allow-Headers'];
    expect(allow).toContain('X-One');
    expect(allow).toContain('X-Two');
  });
});

describe('buildPnaPreflightHeaders', () => {
  it('advertises Private Network Access opt-in', () => {
    expect(buildPnaPreflightHeaders()).toEqual({
      'Access-Control-Allow-Private-Network': 'true',
    });
  });
});
