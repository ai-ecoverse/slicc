/**
 * OpenRouter OAuth PKCE helpers.
 *
 * Adapted from espennilsen/pi's pi-openrouter extension (MIT):
 * https://github.com/espennilsen/pi/blob/main/extensions/pi-openrouter/src/oauth.ts
 */

import type { InterceptingOAuthLauncher, OAuthLoginOptions } from '../src/providers/types.js';
import { saveOAuthAccount } from '../src/ui/provider-settings.js';

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
const OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';

export const OPENROUTER_CALLBACK_URL = 'http://127.0.0.1:3000/callback';
export const OPENROUTER_REDIRECT_URI_PATTERN = 'http://127.0.0.1:3000/*';

function base64UrlEncode(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export function buildAuthorizeUrl(callbackUrl: string, codeChallenge: string): string {
  const authorize = new URL(OPENROUTER_AUTH_URL);
  authorize.searchParams.set('callback_url', callbackUrl);
  authorize.searchParams.set('code_challenge', codeChallenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  return authorize.toString();
}

export function parseCallbackCode(callbackUrl: string | null): string {
  if (!callbackUrl) {
    throw new Error('OpenRouter OAuth login was cancelled or timed out');
  }

  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new Error('OpenRouter OAuth returned an invalid callback URL');
  }

  const code = parsed.searchParams.get('code');
  if (!code) {
    throw new Error('OpenRouter OAuth redirect did not include an authorization code');
  }
  return code;
}

export async function exchangeCodeForKey(
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl(OPENROUTER_KEYS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: 'S256',
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenRouter key exchange failed (${response.status}): ${body || '(empty response body)'}`
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('OpenRouter key exchange returned invalid JSON');
  }

  const key =
    payload && typeof payload === 'object' && typeof (payload as { key?: unknown }).key === 'string'
      ? (payload as { key: string }).key.trim()
      : '';
  if (!key) {
    throw new Error('OpenRouter key exchange returned an empty or invalid API key');
  }
  return key;
}

export async function loginIntercepted(
  launcher: InterceptingOAuthLauncher,
  onSuccess: () => void,
  options?: OAuthLoginOptions
): Promise<void> {
  void options;
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await deriveCodeChallenge(codeVerifier);
  const captured = await launcher({
    authorizeUrl: buildAuthorizeUrl(OPENROUTER_CALLBACK_URL, codeChallenge),
    redirectUriPattern: OPENROUTER_REDIRECT_URI_PATTERN,
    onCapture: 'close',
  });
  const code = parseCallbackCode(captured);
  const key = await exchangeCodeForKey(code, codeVerifier);

  await saveOAuthAccount({
    providerId: 'openrouter',
    accessToken: key,
    tokenExpiresAt: Number.MAX_SAFE_INTEGER,
    baseUrl: OPENROUTER_API_BASE_URL,
  });
  onSuccess();
}
