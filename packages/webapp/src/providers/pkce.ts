/** Encode bytes using the unpadded URL-safe Base64 alphabet. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Generate a 256-bit PKCE code verifier. */
export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

/** Derive the RFC 7636 S256 challenge for a code verifier. */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Generate a 128-bit OAuth state value. */
export function randomState(): string {
  return base64UrlEncode(randomBytes(16));
}
