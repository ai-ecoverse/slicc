/**
 * Constant-time string comparison for capability tokens.
 *
 * Prefers `crypto.subtle.timingSafeEqual` (Cloudflare Workers runtime),
 * falls back to a XOR-accumulate loop when unavailable (e.g. Vitest/Node
 * without the CF polyfill).
 */

const encoder = new TextEncoder();

/** SubtleCrypto with the CF-specific timingSafeEqual extension. */
type CfSubtleCrypto = SubtleCrypto & {
  timingSafeEqual?: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) => boolean;
};

/**
 * Compare two strings in constant time.
 * Returns `false` immediately for length mismatches (lengths are not secret).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;

  // Cloudflare Workers expose this as a synchronous method on SubtleCrypto.
  // It is non-standard and absent in Node's WebCrypto, so feature-detect.
  const subtle = crypto.subtle as CfSubtleCrypto | undefined;
  if (typeof subtle?.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(bufA, bufB);
  }

  // Fallback: constant-time XOR accumulator (never short-circuits).
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    diff |= bufA[i]! ^ bufB[i]!;
  }
  return diff === 0;
}
