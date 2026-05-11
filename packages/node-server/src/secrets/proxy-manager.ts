/**
 * SecretProxyManager — bridges EnvSecretStore with the masking engine
 * for the fetch-proxy handler.
 *
 * On init: loads all secrets, generates session-scoped masked values,
 * and builds lookup tables for fast replacement.
 *
 * As of Task 1.4, this is a thin wrapper around SecretsPipeline from @slicc/shared.
 */

import { randomUUID } from 'node:crypto';
import { SecretsPipeline, type FetchProxySecretSource, type MaskedSecret } from '@slicc/shared';
import { type EnvSecretStore } from './env-secret-store.js';

/**
 * Adapter: convert EnvSecretStore to FetchProxySecretSource interface.
 */
function envStoreAsSource(store: EnvSecretStore | undefined): FetchProxySecretSource {
  return {
    get: async (name) => store?.get(name)?.value ?? undefined,
    listAll: async () => {
      if (!store) return [];
      const entries = store.list();
      return entries
        .map((entry) => {
          const secret = store.get(entry.name);
          if (!secret) return null;
          return { name: secret.name, value: secret.value, domains: secret.domains };
        })
        .filter((s): s is { name: string; value: string; domains: string[] } => s !== null);
    },
  };
}

export class SecretProxyManager {
  private readonly pipeline: SecretsPipeline;
  private readonly _sessionId: string;

  constructor(store?: EnvSecretStore, sessionId?: string) {
    this._sessionId = sessionId ?? randomUUID();
    this.pipeline = new SecretsPipeline({
      sessionId: this._sessionId,
      source: envStoreAsSource(store),
    });
  }

  get sessionId(): string {
    return this._sessionId;
  }

  async reload(): Promise<void> {
    await this.pipeline.reload();
  }

  hasSecrets(): boolean {
    return this.pipeline.hasSecrets();
  }

  getMaskedEntries(): Array<{ name: string; maskedValue: string; domains: string[] }> {
    return this.pipeline.getMaskedEntries();
  }

  unmask(
    text: string,
    targetHostname: string
  ): { text: string; forbidden?: { secretName: string; hostname: string } } {
    return this.pipeline.unmask(text, targetHostname);
  }

  unmaskBody(text: string, targetHostname: string): { text: string } {
    return this.pipeline.unmaskBody(text, targetHostname);
  }

  unmaskHeaders(
    headers: Record<string, string>,
    targetHostname: string
  ): { forbidden?: { secretName: string; hostname: string } } {
    return this.pipeline.unmaskHeaders(headers, targetHostname);
  }

  extractAndUnmaskUrlCredentials(rawUrl: string) {
    return this.pipeline.extractAndUnmaskUrlCredentials(rawUrl);
  }

  scrubResponse(text: string): string {
    return this.pipeline.scrubResponse(text);
  }

  scrubHeaders(headers: Headers): Record<string, string> {
    return this.pipeline.scrubHeaders(headers);
  }

  getByMaskedValue(maskedValue: string): MaskedSecret | undefined {
    return this.pipeline.getByMaskedValue(maskedValue);
  }
}
