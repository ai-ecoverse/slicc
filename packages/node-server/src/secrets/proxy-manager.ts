/**
 * SecretProxyManager — bridges EnvSecretStore with the masking engine
 * for the fetch-proxy handler.
 *
 * On init: loads all secrets, generates session-scoped masked values,
 * and builds lookup tables for fast replacement.
 */

import { randomUUID } from 'node:crypto';
import { mask, buildScrubber, type SecretPair } from '../../../webapp/src/core/secret-masking.js';
import { EnvSecretStore } from './env-secret-store.js';
import { matchesDomains } from './domain-match.js';
import type { Secret } from './types.js';

export interface MaskedSecret {
  name: string;
  maskedValue: string;
  realValue: string;
  domains: string[];
}

export class SecretProxyManager {
  private readonly store: EnvSecretStore;
  private readonly sessionId: string;

  /** maskedValue → MaskedSecret */
  private maskedToSecret = new Map<string, MaskedSecret>();

  /** Scrubber that replaces real→masked in response content */
  private scrubber: (text: string) => string = (t) => t;

  constructor(store?: EnvSecretStore, sessionId?: string) {
    this.store = store ?? new EnvSecretStore();
    this.sessionId = sessionId ?? randomUUID();
  }

  /**
   * Load secrets from the store and generate masked values.
   * Call once on startup and again whenever secrets change.
   */
  async reload(): Promise<void> {
    const entries = this.store.list();
    const newMap = new Map<string, MaskedSecret>();
    const pairs: SecretPair[] = [];

    for (const entry of entries) {
      const secret = this.store.get(entry.name);
      if (!secret) continue;

      const maskedValue = await mask(this.sessionId, secret.name, secret.value);
      const ms: MaskedSecret = {
        name: secret.name,
        maskedValue,
        realValue: secret.value,
        domains: secret.domains,
      };
      newMap.set(maskedValue, ms);
      pairs.push({ realValue: secret.value, maskedValue });
    }

    this.maskedToSecret = newMap;
    this.scrubber = buildScrubber(pairs);
  }

  /**
   * Check if any secrets are loaded.
   */
  hasSecrets(): boolean {
    return this.maskedToSecret.size > 0;
  }

  /**
   * Get all masked entries (name + maskedValue + domains) for env population.
   */
  getMaskedEntries(): Array<{ name: string; maskedValue: string; domains: string[] }> {
    return Array.from(this.maskedToSecret.values()).map((ms) => ({
      name: ms.name,
      maskedValue: ms.maskedValue,
      domains: ms.domains,
    }));
  }

  /**
   * Unmask a text blob: replace masked values with real values.
   * Validates each secret against the target hostname.
   *
   * @returns { text, forbidden } — forbidden is set if a secret was blocked.
   */
  unmask(
    text: string,
    targetHostname: string
  ): { text: string; forbidden?: { secretName: string; hostname: string } } {
    let result = text;

    for (const [maskedValue, ms] of this.maskedToSecret) {
      if (!result.includes(maskedValue)) continue;

      if (!matchesDomains(targetHostname, ms.domains)) {
        return {
          text: result,
          forbidden: { secretName: ms.name, hostname: targetHostname },
        };
      }

      // Replace all occurrences
      result = result.split(maskedValue).join(ms.realValue);
    }

    return { text: result };
  }

  /**
   * Unmask headers in-place. Returns forbidden info if blocked.
   */
  unmaskHeaders(
    headers: Record<string, string>,
    targetHostname: string
  ): { forbidden?: { secretName: string; hostname: string } } {
    for (const key of Object.keys(headers)) {
      const val = headers[key];
      const { text, forbidden } = this.unmask(val, targetHostname);
      if (forbidden) return { forbidden };
      headers[key] = text;
    }
    return {};
  }

  /**
   * Scrub real secret values from response text → masked values.
   */
  scrubResponse(text: string): string {
    return this.scrubber(text);
  }

  /**
   * Scrub headers: replace real values with masked in header values.
   */
  scrubHeaders(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((v, k) => {
      result[k] = this.scrubber(v);
    });
    return result;
  }

  /**
   * Look up a secret by its masked value.
   */
  getByMaskedValue(maskedValue: string): MaskedSecret | undefined {
    return this.maskedToSecret.get(maskedValue);
  }
}
