import { describe, expect, it } from 'vitest';
import {
  base64UrlEncode,
  deriveCodeChallenge,
  generateCodeVerifier,
  randomState,
} from '../../src/providers/pkce.js';

describe('PKCE primitives', () => {
  it('encodes bytes with the unpadded base64url alphabet', () => {
    expect(base64UrlEncode(new Uint8Array([251, 255]))).toBe('-_8');
  });

  it('generates base64url-safe verifier and state values', () => {
    expect(generateCodeVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('derives the RFC 7636 S256 challenge for a fixed verifier', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    await expect(deriveCodeChallenge(verifier)).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });
});
