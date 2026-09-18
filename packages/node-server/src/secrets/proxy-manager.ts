import { randomUUID } from 'node:crypto';
import { type FetchProxySecretSource, SecretsPipeline, SessionSecretStore } from '@slicc/shared-ts';
import type { EnvSecretStore } from './env-secret-store.js';
import type { OauthSecretStore } from './oauth-secret-store.js';

export function buildFetchProxySecretSource(
  getEnvStore: () => EnvSecretStore | undefined,
  getOauthStore: () => OauthSecretStore | undefined
): FetchProxySecretSource {
  return {
    get: async (name) => {
      const fromOauth = getOauthStore()?.get(name);
      if (fromOauth !== undefined) return fromOauth;
      return getEnvStore()?.get(name)?.value ?? undefined;
    },
    listAll: async () => {
      const list: { name: string; value: string; domains: string[] }[] = [];

      const oauthList = getOauthStore()?.list() ?? [];
      const oauthNames = new Set(oauthList.map((e) => e.name));
      for (const e of oauthList) list.push({ name: e.name, value: e.value, domains: e.domains });
      const envEntries = getEnvStore()?.list() ?? [];
      for (const entry of envEntries) {
        const secret = getEnvStore()?.get(entry.name);
        if (!secret || oauthNames.has(entry.name)) continue;
        list.push({ name: secret.name, value: secret.value, domains: secret.domains });
      }
      return list;
    },
  };
}

export class SecretProxyManager {
  private readonly pipeline: SecretsPipeline;
  private readonly _sessionId: string;
  private _envStore?: EnvSecretStore;
  private _oauthStore?: OauthSecretStore;

  readonly sessionStore: SessionSecretStore;

  constructor(
    store?: EnvSecretStore,
    sessionId?: string,
    oauthStore?: OauthSecretStore,
    sessionStore?: SessionSecretStore
  ) {
    this._sessionId = sessionId ?? randomUUID();
    this._envStore = store;
    this._oauthStore = oauthStore;
    this.sessionStore = sessionStore ?? new SessionSecretStore();
    this.pipeline = new SecretsPipeline({
      sessionId: this._sessionId,
      source: this.buildSource(),
      sessionStore: this.sessionStore,
    });
  }

  private buildSource(): FetchProxySecretSource {
    return buildFetchProxySecretSource(
      () => this._envStore,
      () => this._oauthStore
    );
  }

  setOauthStore(store: OauthSecretStore): void {
    this._oauthStore = store;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get rawPipeline(): SecretsPipeline {
    return this.pipeline;
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

  signHmac(
    spec: string,
    body: Uint8Array,
    targetHostname: string
  ): Promise<{
    headerName?: string;
    signatureHex?: string;
    timestampHeaderName?: string;
    timestampValue?: string;
    forbidden?: { secretName: string; hostname: string };
  }> {
    return this.pipeline.signHmac(spec, body, targetHostname);
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
