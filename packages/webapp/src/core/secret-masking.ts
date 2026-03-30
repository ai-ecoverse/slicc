/**
 * Secret masking engine — HMAC-SHA256 based, format-preserving.
 *
 * Used on both agent side (env population, output scrubbing) and
 * server side (fetch proxy response scrubbing).
 */

// ---------- Known token prefixes ----------

const KNOWN_PREFIXES: string[] = [
  'ghp_', // GitHub PAT
  'gho_', // GitHub OAuth
  'ghu_', // GitHub user-to-server
  'ghs_', // GitHub server-to-server
  'ghr_', // GitHub refresh
  'github_pat_', // GitHub fine-grained PAT
  'sk-', // OpenAI / Stripe secret key
  'pk-', // Stripe publishable key
  'xoxb-', // Slack bot token
  'xoxp-', // Slack user token
  'xoxa-', // Slack app token
  'xoxs-', // Slack session token
  'AKIA', // AWS access key ID
  'ABIA', // AWS STS
  'ACCA', // AWS alternate
  'ASIA', // AWS temporary
  'sk-ant-', // Anthropic
  'Bearer ', // generic bearer (keep space)
];

// Sort longest-first so we match the most specific prefix
const SORTED_PREFIXES = [...KNOWN_PREFIXES].sort((a, b) => b.length - a.length);

/**
 * Detect a known prefix from the value. Returns the prefix string or empty.
 */
function detectPrefix(value: string): string {
  for (const p of SORTED_PREFIXES) {
    if (value.startsWith(p)) return p;
  }
  return '';
}

// ---------- HMAC-SHA256 ----------

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

// ---------- Public API ----------

/**
 * Produce a deterministic, format-preserving masked value.
 *
 * `masked = prefix + hex(HMAC-SHA256(sessionId+secretName, realValue))`
 * truncated/repeated to match `realValue.length - prefix.length`.
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

  // Repeat hex if remainder is longer than 64 hex chars
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
 *
 * For a small number of secrets a simple sequential replace is fine.
 * Secrets are sorted longest-first to avoid partial-match issues.
 */
export function buildScrubber(secrets: SecretPair[]): (text: string) => string {
  if (secrets.length === 0) return (t) => t;

  // Sort longest real values first to avoid sub-string clobbering
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

/**
 * Domain glob matching.
 *
 * - `api.github.com` matches exactly `api.github.com`
 * - `*.github.com`   matches `api.github.com`, `uploads.github.com`,
 *                     but NOT `github.com` itself
 */
export function domainMatches(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase();
  const h = hostname.toLowerCase();

  if (!p.startsWith('*.')) {
    return p === h;
  }

  // Wildcard: `*.example.com`
  const suffix = p.slice(1); // `.example.com`
  // hostname must end with `.example.com` AND have at least one char before
  return h.length > suffix.length && h.endsWith(suffix);
}

/**
 * Check if hostname is allowed by any of the domain patterns.
 */
export function isAllowedDomain(patterns: string[], hostname: string): boolean {
  return patterns.some((p) => domainMatches(p, hostname));
}
