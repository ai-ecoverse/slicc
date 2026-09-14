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

async function hmacSha256(key: string, message: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

type SubtleData = ArrayBufferView<ArrayBuffer>;

export async function hmacSha256Hex(key: string, message: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, message as SubtleData);
  return toHex(new Uint8Array(sig));
}

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

export const MIN_MASKABLE_SECRET_LENGTH = 9;

export function buildScrubber(secrets: SecretPair[]): (text: string) => string {
  const eligible = secrets.filter((s) => s.realValue.length >= MIN_MASKABLE_SECRET_LENGTH);
  if (eligible.length === 0) return (t) => t;

  const sorted = [...eligible].sort((a, b) => b.realValue.length - a.realValue.length);

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

export function domainMatches(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase();
  const h = hostname.toLowerCase();

  if (p === '*') return true;

  if (!p.startsWith('*.')) {
    return p === h;
  }

  const suffix = p.slice(1);

  return h.length > suffix.length && h.endsWith(suffix);
}

export function isAllowedDomain(patterns: string[], hostname: string): boolean {
  return patterns.some((p) => domainMatches(p, hostname));
}

export function matchesDomains(hostname: string, patterns: string[]): boolean {
  return isAllowedDomain(patterns, hostname);
}
