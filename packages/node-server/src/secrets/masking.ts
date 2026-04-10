/**
 * Secret masking engine for the node-server fetch proxy.
 *
 * This is a Node-specific copy of the core masking logic from
 * packages/webapp/src/core/secret-masking.ts. Both must stay in sync.
 *
 * Uses Node's crypto.subtle (available since Node 15).
 */

import { subtle } from 'node:crypto';

// ---------- Known token prefixes ----------

const KNOWN_PREFIXES: string[] = [
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'github_pat_',
  'sk-',
  'pk-',
  'xoxb-',
  'xoxp-',
  'xoxa-',
  'xoxs-',
  'AKIA',
  'ABIA',
  'ACCA',
  'ASIA',
  'sk-ant-',
  'Bearer ',
];

const SORTED_PREFIXES = [...KNOWN_PREFIXES].sort((a, b) => b.length - a.length);

function detectPrefix(value: string): string {
  for (const p of SORTED_PREFIXES) {
    if (value.startsWith(p)) return p;
  }
  return '';
}

// ---------- HMAC-SHA256 ----------

async function hmacSha256(key: string, message: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const cryptoKey = await subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------- Public API ----------

/**
 * Produce a deterministic, format-preserving masked value.
 */
export async function mask(
  sessionId: string,
  secretName: string,
  realValue: string
): Promise<string> {
  const prefix = detectPrefix(realValue);
  const remainder = realValue.slice(prefix.length);

  const hmac = await hmacSha256(sessionId + secretName, realValue);
  let hex = toHex(hmac);

  while (hex.length < remainder.length) hex += hex;
  const maskedRemainder = hex.slice(0, remainder.length);

  return prefix + maskedRemainder;
}

export interface SecretPair {
  realValue: string;
  maskedValue: string;
}

/**
 * Build a reusable scrubber function that replaces every occurrence
 * of any `realValue` with its `maskedValue`.
 */
export function buildScrubber(secrets: SecretPair[]): (text: string) => string {
  if (secrets.length === 0) return (t) => t;

  const sorted = [...secrets].sort((a, b) => b.realValue.length - a.realValue.length);

  return (text: string): string => {
    let result = text;
    for (const { realValue, maskedValue } of sorted) {
      if (result.includes(realValue)) {
        result = result.split(realValue).join(maskedValue);
      }
    }
    return result;
  };
}
