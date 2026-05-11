import {
  mask as cryptoMask,
  buildScrubber,
  matchesDomains,
  type SecretPair,
} from './secret-masking.js';

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

export interface SecretsPipelineOpts {
  sessionId: string;
  source: FetchProxySecretSource;
}

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

  getByMaskedValue(maskedValue: string): MaskedSecret | undefined {
    return this.maskedToSecret.get(maskedValue);
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

  /**
   * Unmask headers IN PLACE. Mutates the headers parameter; returns only { forbidden? }.
   * Match SecretProxyManager's existing semantics so call sites compile unchanged.
   */
  unmaskHeaders(headers: Record<string, string>, hostname: string): UnmaskHeadersResult {
    for (const [key, val] of Object.entries(headers)) {
      const { text, forbidden } = this.unmask(val, hostname);
      if (forbidden) return { forbidden };
      headers[key] = text;
    }
    return {};
  }

  scrubResponse(text: string): string {
    return this.scrubber(text);
  }

  scrubHeaders(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((v, k) => {
      out[k] = this.scrubber(v);
    });
    return out;
  }
}
