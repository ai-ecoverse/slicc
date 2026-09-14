import {
  buildScrubber,
  mask as cryptoMask,
  hmacSha256Hex,
  MIN_MASKABLE_SECRET_LENGTH,
  matchesDomains,
  type SecretPair,
} from './secret-masking.js';
import type { SessionSecretStore } from './session-secret-store.js';

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

export const HMAC_SIGN_HEADER = 'x-slicc-hmac-sign';

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

export interface HmacSignResult {
  headerName?: string;
  signatureHex?: string;

  timestampHeaderName?: string;

  timestampValue?: string;
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

  sessionStore?: SessionSecretStore;
}

export class SecretsPipeline {
  public readonly sessionId: string;
  private readonly source: FetchProxySecretSource;
  private readonly sessionStore?: SessionSecretStore;
  private maskedToSecret = new Map<string, MaskedSecret>();

  private exportPairs: readonly MaskedSecret[] = [];

  private exportShortPairs: readonly MaskedSecret[] = [];

  private consumableShortSecrets = new Map<string, MaskedSecret>();

  private byName = new Map<string, MaskedSecret>();
  private scrubber: (text: string) => string = (t) => t;

  constructor(opts: SecretsPipelineOpts) {
    this.sessionId = opts.sessionId;
    this.source = opts.source;
    this.sessionStore = opts.sessionStore;
  }

  async reload(): Promise<void> {
    const all = await this.source.listAll();

    const persistedNames = new Set(all.map((s) => s.name));
    const session = (this.sessionStore?.listAll() ?? []).filter((s) => !persistedNames.has(s.name));
    const merged = [...all, ...session];
    const next = new Map<string, MaskedSecret>();
    const nextShort = new Map<string, MaskedSecret>();
    for (const s of merged) {
      if (s.value.length < MIN_MASKABLE_SECRET_LENGTH) {
        console.warn(
          `[slicc:secrets] secret "${s.name}" not masked: value shorter than ${MIN_MASKABLE_SECRET_LENGTH} chars`
        );
        nextShort.set(s.name, {
          name: s.name,
          realValue: s.value,
          maskedValue: s.value,
          domains: s.domains,
        });
        continue;
      }
      const maskedValue = await cryptoMask(this.sessionId, s.name, s.value);
      next.set(maskedValue, {
        name: s.name,
        realValue: s.value,
        maskedValue,
        domains: s.domains,
      });
    }
    this.maskedToSecret = next;
    this.exportPairs = Array.from(next.values());
    this.exportShortPairs = Array.from(nextShort.values());
    this.consumableShortSecrets = nextShort;

    const nextByName = new Map<string, MaskedSecret>();
    for (const ms of next.values()) nextByName.set(ms.name, ms);
    for (const ms of nextShort.values()) {
      if (nextByName.has(ms.name)) {
        console.warn(
          `[slicc:secrets] secret "${ms.name}" registered as both maskable and short-consumable`
        );
      }
      nextByName.set(ms.name, ms);
    }
    this.byName = nextByName;
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
    const entries: Array<{ name: string; maskedValue: string; domains: string[] }> = [];
    for (const ms of this.maskedToSecret.values()) {
      entries.push({ name: ms.name, maskedValue: ms.maskedValue, domains: ms.domains });
    }

    for (const ms of this.consumableShortSecrets.values()) {
      entries.push({ name: ms.name, maskedValue: ms.maskedValue, domains: ms.domains });
    }
    return entries;
  }

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

  async signHmac(
    spec: string,
    body: Uint8Array,
    hostname: string,
    now: () => number = Date.now
  ): Promise<HmacSignResult> {
    const sep = spec.indexOf(':');
    if (sep < 0) return {};
    const secretName = spec.slice(0, sep).trim();
    const rest = spec.slice(sep + 1);
    const sep2 = rest.indexOf(':');
    const headerName = (sep2 < 0 ? rest : rest.slice(0, sep2)).trim();
    const timestampHeader = sep2 < 0 ? undefined : rest.slice(sep2 + 1).trim();
    if (!secretName || !headerName) return {};
    if (timestampHeader === '') return {};

    const ms = this.byName.get(secretName);
    if (!ms) {
      console.warn(`[slicc:secrets] signHmac: no secret named "${secretName}"`);
      return {};
    }
    if (!matchesDomains(hostname, ms.domains)) {
      return { forbidden: { secretName: ms.name, hostname } };
    }

    if (timestampHeader) {
      const timestampValue = String(Math.floor(now() / 1000));
      const message = new Uint8Array(body.length + timestampValue.length + 1);
      message.set(new TextEncoder().encode(`${timestampValue}.`), 0);
      message.set(body, timestampValue.length + 1);
      const signatureHex = await hmacSha256Hex(ms.realValue, message);
      return { headerName, signatureHex, timestampHeaderName: timestampHeader, timestampValue };
    }

    const signatureHex = await hmacSha256Hex(ms.realValue, body);
    return { headerName, signatureHex };
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

  redactForExport(texts: readonly string[]): { texts: string[]; redactionCount: number } {
    const base = this.exportPairs.length;

    const markers = this.exportPairs.map((pair, index) => ({
      values: [pair.realValue, pair.maskedValue].filter(Boolean),
      marker: `⟦REDACTED:known-secret:k${index + 1}⟧`,
    }));

    const shortMarkers = this.exportShortPairs.map((pair, index) => ({
      values: [pair.realValue],
      marker: `⟦REDACTED:known-secret:k${base + index + 1}⟧`,
    }));
    const allMarkers = [...markers, ...shortMarkers];
    let redactionCount = 0;
    return {
      texts: texts.map((input) => {
        let output = input;
        for (const { values, marker } of allMarkers) {
          for (const value of values) {
            const occurrences = output.split(value).length - 1;
            redactionCount += occurrences;
            output = output.replaceAll(value, marker);
          }
        }
        return output;
      }),
      redactionCount,
    };
  }
}
