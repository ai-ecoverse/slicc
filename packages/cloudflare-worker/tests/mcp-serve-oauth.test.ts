import { describe, expect, it } from 'vitest';
import {
  beginAuthorization,
  decideAuthorization,
  exchangeToken,
  redirectUriAllowed,
  registerClient,
} from '../src/mcp-serve-oauth.js';
import type { McpServeRecord } from '../src/shared.js';

function serve(generation = 1): McpServeRecord {
  return {
    token: 'token',
    url: 'https://7f3a9c.sliccy.now/mcp',
    trayId: 'tray',
    grantGeneration: generation,
    createdAt: '2026-10-07T00:00:00.000Z',
    clients: [],
    pending: [],
    codes: [],
    tokens: [],
  };
}

const REDIRECT = 'https://client.example/callback';

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  );
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

describe('redirectUriAllowed', () => {
  it('allows https, loopback http, and private-use schemes', () => {
    expect(redirectUriAllowed('https://client.example/callback')).toBe(true);
    expect(redirectUriAllowed('http://127.0.0.1:9/callback')).toBe(true);
    expect(redirectUriAllowed('http://localhost/callback')).toBe(true);
    expect(redirectUriAllowed('http://[::1]/callback')).toBe(true);
    expect(redirectUriAllowed('cursor://anysphere.cursor-mcp/callback')).toBe(true);
  });

  it('rejects public http and scriptable schemes', () => {
    expect(redirectUriAllowed('http://client.example/callback')).toBe(false);
    expect(redirectUriAllowed('javascript:alert(1)')).toBe(false);
    expect(redirectUriAllowed('data:text/html,hi')).toBe(false);
    expect(redirectUriAllowed('file:///tmp/x')).toBe(false);
  });
});

describe('mcp oauth grant generation', () => {
  it('rejects a consent form edited up to a newer generation', async () => {
    const record = serve(1);
    registerClient(
      record,
      JSON.stringify({
        client_name: 'Claude',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
      '2026-10-07T00:00:00.000Z'
    );
    const clientId = record.clients[0]?.clientId ?? '';
    const verifier = 'a'.repeat(43);
    const begun = beginAuthorization(
      record,
      `?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${await s256(verifier)}&code_challenge_method=S256&state=xyz`,
      1_000
    );
    expect('challenge' in begun).toBe(true);
    if (!('challenge' in begun)) return;
    record.grantGeneration = 2;
    const raised = await decideAuthorization(
      record,
      `pending=${begun.challenge.pendingId}&generation=2&decision=accept`,
      'application/x-www-form-urlencoded',
      1_000
    );
    expect(raised.status).toBe(400);
    expect(raised.body).toContain('consent is stale');
    expect(record.codes).toHaveLength(0);
    expect(record.pending).toHaveLength(1);
  });

  it('redirects a PKCE method other than S256 and does not redirect an unknown client', async () => {
    const record = serve();
    registerClient(
      record,
      JSON.stringify({ redirect_uris: [REDIRECT] }),
      '2026-10-07T00:00:00.000Z'
    );
    const clientId = record.clients[0]?.clientId ?? '';
    const plain = beginAuthorization(
      record,
      `?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=abc&code_challenge_method=plain&state=xyz`,
      1_000
    );
    expect('error' in plain && plain.error.status).toBe(302);
    if ('error' in plain) expect(plain.error.headers.location).toContain('invalid_request');
    const unknown = beginAuthorization(
      record,
      `?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent('https://evil.example/steal')}&code_challenge=abc&code_challenge_method=S256`,
      1_000
    );
    expect('error' in unknown && unknown.error.status).toBe(400);
    if ('error' in unknown) expect(unknown.error.headers.location).toBeUndefined();
  });

  it('exchanges a matching code and refuses a stale refresh', async () => {
    const record = serve(1);
    registerClient(
      record,
      JSON.stringify({ redirect_uris: [REDIRECT] }),
      '2026-10-07T00:00:00.000Z'
    );
    const clientId = record.clients[0]?.clientId ?? '';
    const verifier = `b${'c'.repeat(42)}`;
    const begun = beginAuthorization(
      record,
      `?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${await s256(verifier)}&code_challenge_method=S256&state=xyz`,
      5_000
    );
    if (!('challenge' in begun)) throw new Error('expected a challenge');
    const decision = await decideAuthorization(
      record,
      JSON.stringify({ pending: begun.challenge.pendingId, generation: '1', decision: 'accept' }),
      'application/json',
      5_000
    );
    expect(decision.status).toBe(302);
    const code = new URL(decision.headers.location ?? '').searchParams.get('code') ?? '';
    const token = await exchangeToken(
      record,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
      'application/x-www-form-urlencoded',
      5_000
    );
    const issued = JSON.parse(token.body) as { access_token: string; refresh_token: string };
    expect(token.status).toBe(200);
    expect(issued.access_token).toBeTruthy();
    record.grantGeneration = 2;
    const refreshed = await exchangeToken(
      record,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: issued.refresh_token,
      }).toString(),
      'application/x-www-form-urlencoded',
      5_000
    );
    expect(refreshed.status).toBe(401);
    expect(JSON.parse(refreshed.body).error).toBe('invalid_grant');
  });
});
