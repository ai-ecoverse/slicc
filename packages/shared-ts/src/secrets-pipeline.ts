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

/**
 * Sentinel request header a client sets to ask the fetch proxy to sign the
 * request body: `x-slicc-hmac-sign: <secretName>:<targetHeader>`. The proxy
 * computes `HMAC-SHA256(body, secretName's real value)`, attaches the hex
 * result under `targetHeader`, and strips this header before forwarding —
 * see `SecretsPipeline.signHmac`.
 *
 * An optional third segment, `<secretName>:<targetHeader>:<timestampHeader>`,
 * switches to timestamp-bound signing: the MAC covers `<unixSeconds>.<body>`
 * instead of the raw body, and the proxy also attaches the unix-seconds
 * timestamp it signed with under `timestampHeader`. This is what a receiver
 * needs to enforce a replay window (reject requests whose timestamp is too
 * far from "now") — a bare body digest has no way to do that, since the same
 * signed request stays valid forever.
 */
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
  /** Header the computed signature should be attached under. Absent when `spec` was malformed or named an unknown secret — callers should leave the request unsigned in that case. */
  headerName?: string;
  signatureHex?: string;
  /** Header the signed timestamp should be attached under. Present only when `spec` used the 3-segment timestamp-bound form. */
  timestampHeaderName?: string;
  /** Unix-seconds timestamp folded into the signed message as `<timestampValue>.<body>`. Present only alongside `timestampHeaderName`. */
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
  /**
   * Optional in-memory session-secret store. Its entries are layered on top
   * of `source` at every `reload()` so the fetch proxy can unmask session
   * secrets like persisted ones. Persisted secrets win on a name collision
   * (the agent cannot shadow a real persisted secret's masking).
   */
  sessionStore?: SessionSecretStore;
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
  private readonly sessionStore?: SessionSecretStore;
  private maskedToSecret = new Map<string, MaskedSecret>();
  /** Ordered array of maskable secret pairs for export redaction. Order is stable within a reload cycle. */
  private exportPairs: readonly MaskedSecret[] = [];
  // Short secrets (length < MIN_MASKABLE_SECRET_LENGTH) are kept CONSUMABLE
  // here — env injection and `secret get` still see them — but they are
  // deliberately absent from `maskedToSecret`, so the scrubber and every
  // unmask/domain-match loop ignores them. Their "masked" value is the
  // literal real value (identity masking) so an env-injected $NAME delivers
  // the actual secret, while the scrubber's masking-pattern set stays
  // collision-free for short inputs. Keyed by name (one entry per secret).
  private consumableShortSecrets = new Map<string, MaskedSecret>();
  // Indexes every secret (maskable or short) by name, for lookups that start
  // from a secret name rather than a masked value found in text — currently
  // only `signHmac`, which needs the real value of a *named* secret to
  // compute a body signature the agent could never derive from a masked token.
  private byName = new Map<string, MaskedSecret>();
  private scrubber: (text: string) => string = (t) => t;

  constructor(opts: SecretsPipelineOpts) {
    this.sessionId = opts.sessionId;
    this.source = opts.source;
    this.sessionStore = opts.sessionStore;
  }

  async reload(): Promise<void> {
    const all = await this.source.listAll();
    // Layer session secrets on top of persisted ones; persisted wins on a
    // name collision so a free session-set can't shadow a real secret.
    const persistedNames = new Set(all.map((s) => s.name));
    const session = (this.sessionStore?.listAll() ?? []).filter((s) => !persistedNames.has(s.name));
    const merged = [...all, ...session];
    const next = new Map<string, MaskedSecret>();
    const nextShort = new Map<string, MaskedSecret>();
    for (const s of merged) {
      // Too-short values must NEVER enter the masked↔real map or the
      // scrubber `pairs`: a degenerate-length value (e.g. 1 byte) would
      // collide with arbitrary outbound bytes and produce spurious
      // cross-domain 403s. They remain CONSUMABLE via the separate
      // short-secret map so env injection (`secret get`, masked-entries
      // feed) still delivers the literal value. The warning names the
      // secret (never its value) so the operator knows it will not be
      // masked / scrubbed.
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
    this.consumableShortSecrets = nextShort;
    // Invariant: a secret name is unique across {next, nextShort} — reload()
    // partitions each source secret into exactly one of the two maps, so a
    // collision here can only mean a future storage change broke that
    // partitioning. Warn rather than silently letting the second write win,
    // since `signHmac` trusts this index to resolve to the right real value.
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
    // Reports the maskable set only — controls fetch-proxy scrub/unmask
    // short-circuits, which are irrelevant for consumable-only short
    // secrets (they never participate in scrub or domain matching).
    return this.maskedToSecret.size > 0;
  }

  getMaskedEntries(): Array<{ name: string; maskedValue: string; domains: string[] }> {
    const entries: Array<{ name: string; maskedValue: string; domains: string[] }> = [];
    for (const ms of this.maskedToSecret.values()) {
      entries.push({ name: ms.name, maskedValue: ms.maskedValue, domains: ms.domains });
    }
    // Short secrets carry their real value as the "masked" value (identity
    // masking) so env injection delivers the literal secret. They must not
    // collide with maskable names — `reload()` enforces single-source-of-
    // truth ordering by writing them in the same pass.
    for (const ms of this.consumableShortSecrets.values()) {
      entries.push({ name: ms.name, maskedValue: ms.maskedValue, domains: ms.domains });
    }
    return entries;
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

  /**
   * Resolve an `x-slicc-hmac-sign: <secretName>:<targetHeader>[:<timestampHeader>]`
   * directive against the (already-unmasked) request body. The real secret
   * value is looked up by name, domain-checked exactly like `unmaskHeaders`,
   * and used to compute the MAC — the caller attaches the hex result under
   * `targetHeader` and forwards. The real value never leaves this method.
   *
   * Two-segment specs (no `timestampHeader`) sign the raw body, unchanged
   * from the original behavior. Three-segment specs sign
   * `<unixSeconds>.<body>` instead and additionally return `timestampValue`
   * for the caller to attach under `timestampHeaderName`, so the receiver can
   * enforce a replay window. `now` is injectable for tests; defaults to the
   * real clock.
   *
   * Returns `{}` (no-op) for a malformed spec or an unknown secret name —
   * the fetch proxy is expected to treat that as "nothing to sign", not a
   * hard error, since the header may have been set for a different purpose.
   */
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
      // Log-only, never a hard error: a typo'd name would otherwise fail
      // silently (request goes out unsigned, upstream just 401s with no clue
      // why). Mirrors the too-short-secret warning above — never logs a value.
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

  /**
   * Batch-redact an array of strings for transcript export.
   *
   * Replaces every occurrence of each known secret's real value AND masked
   * value with a stable anonymous marker `⟦REDACTED:known-secret:k<n>⟧`.
   * The index `n` is 1-based and stable within a single reload cycle.
   *
   * Returns the transformed texts plus the total number of replacements made.
   * Secret names and real values never appear in the return value.
   */
  redactForExport(texts: readonly string[]): { texts: string[]; redactionCount: number } {
    const markers = this.exportPairs.map((pair, index) => ({
      values: [pair.realValue, pair.maskedValue].filter(Boolean),
      marker: `⟦REDACTED:known-secret:k${index + 1}⟧`,
    }));
    let redactionCount = 0;
    return {
      texts: texts.map((input) => {
        let output = input;
        for (const { values, marker } of markers) {
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
