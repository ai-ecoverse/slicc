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
import { SecretsPipeline, type FetchProxySecretSource } from '@slicc/shared';
import { type EnvSecretStore } from './env-secret-store.js';
import { type OauthSecretStore } from './oauth-secret-store.js';

export class SecretProxyManager {
  private readonly pipeline: SecretsPipeline;
  private readonly _sessionId: string;
  private _envStore?: EnvSecretStore;
  private _oauthStore?: OauthSecretStore;

  constructor(store?: EnvSecretStore, sessionId?: string, oauthStore?: OauthSecretStore) {
    this._sessionId = sessionId ?? randomUUID();
    this._envStore = store;
    this._oauthStore = oauthStore;
    this.pipeline = new SecretsPipeline({
      sessionId: this._sessionId,
      source: this.buildSource(),
    });
  }

  private buildSource(): FetchProxySecretSource {
    const env = () => this._envStore;
    const oauth = () => this._oauthStore;
    return {
      get: async (name) => {
        const fromOauth = oauth()?.get(name);
        if (fromOauth !== undefined) return fromOauth;
        return env()?.get(name)?.value ?? undefined;
      },
      listAll: async () => {
        const list: { name: string; value: string; domains: string[] }[] = [];
        // OAuth wins on name collision (reserved namespace policy)
        const oauthList = oauth()?.list() ?? [];
        const oauthNames = new Set(oauthList.map((e) => e.name));
        for (const e of oauthList) list.push({ name: e.name, value: e.value, domains: e.domains });
        const envEntries = env()?.list() ?? [];
        for (const entry of envEntries) {
          const secret = env()?.get(entry.name);
          if (!secret || oauthNames.has(entry.name)) continue;
          list.push({ name: secret.name, value: secret.value, domains: secret.domains });
        }
        return list;
      },
    };
  }

  setOauthStore(store: OauthSecretStore): void {
    this._oauthStore = store;
    // No pipeline reconstruction needed — source closures pick up the new
    // store on the next reload() call.
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
}
