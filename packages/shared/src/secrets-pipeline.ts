import {
  mask as cryptoMask,
  buildScrubber,
  matchesDomains,
  type SecretPair,
} from './secret-masking.js';

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function replaceAllBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  replacement: Uint8Array
): Uint8Array {
  if (indexOfBytes(haystack, needle) < 0) return haystack;
  const out: number[] = [];
  let i = 0;
  while (i < haystack.length) {
    const idx = indexOfBytes(haystack, needle, i);
    if (idx < 0) {
      for (let k = i; k < haystack.length; k++) out.push(haystack[k]);
      break;
    }
    for (let k = i; k < idx; k++) out.push(haystack[k]);
    for (let k = 0; k < replacement.length; k++) out.push(replacement[k]);
    i = idx + needle.length;
  }
  return new Uint8Array(out);
}

export interface FetchProxySecretSource {
  get(name: string): Promise<string | undefined>;
  listAll(): Promise<{ name: string; value: string; domains: string[] }[]>;
}

export interface MaskedSecret {
  name: string;
  realValue: string;
  maskedValue: string;
  domains: string[];
}

export interface ForbiddenInfo {
  secretName: string;
  hostname: string;
}

export interface UnmaskResult {
  text: string;
  forbidden?: ForbiddenInfo;
}

export interface UnmaskHeadersResult {
  forbidden?: ForbiddenInfo;
}

export interface BasicResult {
  value: string;
  forbidden?: ForbiddenInfo;
}

export interface ExtractedUrlCreds {
  url: string;
  syntheticAuthorization?: string;
  forbidden?: ForbiddenInfo;
}

export interface SecretsPipelineOpts {
  sessionId: string;
  source: FetchProxySecretSource;
}

/**
 * Stateful unmask/scrub pipeline shared between node-server's /api/fetch-proxy
 * and the chrome-extension SW's fetch-proxy.fetch Port handler.
 *
 * Public surface has four method families:
 *
 *   ┌────────────┬────────────────────────────────┬─────────────────────────┐
 *   │            │ Text-safe (string in / out)    │ Byte-safe (Uint8Array)  │
 *   ├────────────┼────────────────────────────────┼─────────────────────────┤
 *   │ Unmask     │ unmask, unmaskBody,            │ unmaskBodyBytes         │
 *   │ (mask→real)│ unmaskHeaders, …Basic, …Url    │                         │
 *   ├────────────┼────────────────────────────────┼─────────────────────────┤
 *   │ Scrub      │ scrubResponse, scrubHeaders    │ scrubResponseBytes      │
 *   │ (real→mask)│                                │                         │
 *   └────────────┴────────────────────────────────┴─────────────────────────┘
 *
 * Use the byte-safe variants for request/response bodies that may be binary
 * (git packfiles, ZIPs, images, application/octet-stream). The text variants
 * UTF-8-decode their input, which corrupts non-UTF-8 byte sequences
 * (`Buffer.toString('utf-8')` replaces invalid bytes with U+FFFD).
 *
 * Note: unmaskHeaders MUTATES its input in place (matching SecretProxyManager's
 * legacy semantics). The other methods return new strings/byte arrays.
 */
export class SecretsPipeline {
  public readonly sessionId: string;
  private readonly source: FetchProxySecretSource;
  private maskedToSecret = new Map<string, MaskedSecret>();
  private scrubber: (text: string) => string = (t) => t;

  constructor(opts: SecretsPipelineOpts) {
    this.sessionId = opts.sessionId;
    this.source = opts.source;
  }

  async reload(): Promise<void> {
    const all = await this.source.listAll();
    const next = new Map<string, MaskedSecret>();
    for (const s of all) {
      const maskedValue = await cryptoMask(this.sessionId, s.name, s.value);
      next.set(maskedValue, {
        name: s.name,
        realValue: s.value,
        maskedValue,
        domains: s.domains,
      });
    }
    this.maskedToSecret = next;
    const pairs: SecretPair[] = Array.from(next.values()).map((ms) => ({
      realValue: ms.realValue,
      maskedValue: ms.maskedValue,
    }));
    this.scrubber = buildScrubber(pairs);
  }

  async maskOne(name: string, value: string): Promise<string> {
    return cryptoMask(this.sessionId, name, value);
  }

  hasSecrets(): boolean {
    return this.maskedToSecret.size > 0;
  }

  getMaskedEntries(): Array<{ name: string; maskedValue: string; domains: string[] }> {
    return Array.from(this.maskedToSecret.values()).map((ms) => ({
      name: ms.name,
      maskedValue: ms.maskedValue,
      domains: ms.domains,
    }));
  }

  /**
   * Unmask a single string. Domain mismatch on a matched secret → forbidden.
   * Returns { text } on success, { text: original, forbidden } on block.
   */
  unmask(text: string, hostname: string): UnmaskResult {
    let result = text;
    for (const [maskedValue, ms] of this.maskedToSecret) {
      if (!result.includes(maskedValue)) continue;
      if (!matchesDomains(hostname, ms.domains)) {
        return { text, forbidden: { secretName: ms.name, hostname } };
      }
      result = result.split(maskedValue).join(ms.realValue);
    }
    return { text: result };
  }

  /**
   * Unmask body text. Domain mismatch on a matched secret leaves it untouched
   * (NO forbidden — masked values in conversation context are harmless).
   */
  unmaskBody(text: string, hostname: string): { text: string } {
    let result = text;
    for (const [maskedValue, ms] of this.maskedToSecret) {
      if (!result.includes(maskedValue)) continue;
      if (!matchesDomains(hostname, ms.domains)) continue;
      result = result.split(maskedValue).join(ms.realValue);
    }
    return { text: result };
  }

  unmaskAuthorizationBasic(headerValue: string, hostname: string): BasicResult {
    const pattern = /^Basic\s+(.+)$/;
    const match = pattern.exec(headerValue);
    if (!match) return { value: headerValue };
    let decoded: string;
    try {
      decoded = atob(match[1].trim());
    } catch {
      return { value: headerValue };
    }
    const colon = decoded.indexOf(':');
    if (colon < 0) return { value: headerValue };
    let user = decoded.slice(0, colon);
    let pass = decoded.slice(colon + 1);
    let touched = false;
    for (const [maskedValue, ms] of this.maskedToSecret) {
      if (user.includes(maskedValue) || pass.includes(maskedValue)) {
        if (!matchesDomains(hostname, ms.domains)) {
          return { value: headerValue, forbidden: { secretName: ms.name, hostname } };
        }
        if (user.includes(maskedValue)) user = user.split(maskedValue).join(ms.realValue);
        if (pass.includes(maskedValue)) pass = pass.split(maskedValue).join(ms.realValue);
        touched = true;
      }
    }
    if (!touched) return { value: headerValue };
    return { value: `Basic ${btoa(`${user}:${pass}`)}` };
  }

  extractAndUnmaskUrlCredentials(rawUrl: string): ExtractedUrlCreds {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { url: rawUrl };
    }
    if (!parsed.username && !parsed.password) return { url: rawUrl };

    let user = decodeURIComponent(parsed.username);
    let pass = decodeURIComponent(parsed.password);
    const host = parsed.host;
    let touched = false;
    for (const [maskedValue, ms] of this.maskedToSecret) {
      if (user.includes(maskedValue) || pass.includes(maskedValue)) {
        if (!matchesDomains(host, ms.domains)) {
          return { url: rawUrl, forbidden: { secretName: ms.name, hostname: host } };
        }
        if (user.includes(maskedValue)) {
          user = user.split(maskedValue).join(ms.realValue);
          touched = true;
        }
        if (pass.includes(maskedValue)) {
          pass = pass.split(maskedValue).join(ms.realValue);
          touched = true;
        }
      }
    }
    const synthetic = touched && (user || pass) ? `Basic ${btoa(`${user}:${pass}`)}` : undefined;
    parsed.username = '';
    parsed.password = '';
    return { url: parsed.toString(), syntheticAuthorization: synthetic };
  }

  /**
   * Unmask headers IN PLACE. Mutates the headers parameter; returns only { forbidden? }.
   * Match SecretProxyManager's existing semantics so call sites compile unchanged.
   */
  unmaskHeaders(headers: Record<string, string>, hostname: string): UnmaskHeadersResult {
    for (const [key, val] of Object.entries(headers)) {
      if (key.toLowerCase() === 'authorization' && /^Basic\s/i.test(val)) {
        const basic = this.unmaskAuthorizationBasic(val, hostname);
        if (basic.forbidden) return { forbidden: basic.forbidden };
        headers[key] = basic.value;
        continue;
      }
      const { text, forbidden } = this.unmask(val, hostname);
      if (forbidden) return { forbidden };
      headers[key] = text;
    }
    return {};
  }

  unmaskBodyBytes(body: Uint8Array, hostname: string): { bytes: Uint8Array } {
    let out = body;
    const enc = new TextEncoder();
    for (const [maskedValue, ms] of this.maskedToSecret) {
      if (!matchesDomains(hostname, ms.domains)) continue;
      const needle = enc.encode(maskedValue);
      const replacement = enc.encode(ms.realValue);
      out = replaceAllBytes(out, needle, replacement);
    }
    return { bytes: out };
  }

  scrubResponse(text: string): string {
    return this.scrubber(text);
  }

  scrubResponseBytes(bytes: Uint8Array): Uint8Array {
    let out = bytes;
    const enc = new TextEncoder();
    for (const [maskedValue, ms] of this.maskedToSecret) {
      const needle = enc.encode(ms.realValue);
      const replacement = enc.encode(maskedValue);
      out = replaceAllBytes(out, needle, replacement);
    }
    return out;
  }

  scrubHeaders(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((v, k) => {
      out[k] = this.scrubber(v);
    });
    return out;
  }
}
