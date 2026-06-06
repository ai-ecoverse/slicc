/**
 * Production backends for the `secret` command.
 *
 * The command runs in the agent realm; the secret stores (session + persisted)
 * and the masking pipeline live in the trusted realm (node-server in CLI mode,
 * the service worker in extension mode). These backends bridge the two via the
 * existing transports — HTTP `/api/secrets*` in CLI, `chrome.runtime` messages
 * in the extension. Session secrets never touch disk/storage; only the
 * in-memory session store in the trusted realm holds their values.
 */

/** A secret's identity + scope, without its value. */
export interface SecretRecord {
  name: string;
  domains: string[];
  /** false → session-only (in-memory, never persisted). */
  persisted: boolean;
}

export interface MaskedRecord {
  name: string;
  maskedValue: string;
  domains: string[];
}

export interface PeekRecord {
  name: string;
  preview: string;
  domains: string[];
}

/** The trusted-realm operations the `secret` command depends on. */
export interface SecretBackend {
  list(): Promise<SecretRecord[]>;
  getInfo(name: string): Promise<SecretRecord | null>;
  getMasked(name: string): Promise<MaskedRecord | null>;
  peek(name: string): Promise<PeekRecord | null>;
  setSession(name: string, value: string, domains: string[]): Promise<void>;
  setPersisted(name: string, value: string, domains: string[]): Promise<void>;
  setScope(name: string, domains: string[]): Promise<void>;
}

function swSendMessage<T>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response: unknown) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message ?? 'chrome.runtime.lastError'));
        return;
      }
      resolve(response as T);
    });
  });
}

async function apiCall(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) init.body = JSON.stringify(body);
  const resp = await fetch(`/api/secrets${path}`, init);
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

type NamedDomains = { name: string; domains: string[] };

/** CLI/standalone backend — talks to the node-server `/api/secrets*` routes. */
export function createCliSecretBackend(): SecretBackend {
  return {
    async list() {
      const [persisted, session] = await Promise.all([
        apiCall('GET', ''),
        apiCall('GET', '/session'),
      ]);
      const out: SecretRecord[] = [];
      if (persisted.ok)
        for (const e of persisted.data as NamedDomains[])
          out.push({ name: e.name, domains: e.domains, persisted: true });
      if (session.ok)
        for (const e of session.data as NamedDomains[])
          out.push({ name: e.name, domains: e.domains, persisted: false });
      return out;
    },
    async getInfo(name) {
      return (await this.list()).find((e) => e.name === name) ?? null;
    },
    async getMasked(name) {
      const { ok, data } = await apiCall('GET', '/masked');
      if (!ok) return null;
      return (data as MaskedRecord[]).find((e) => e.name === name) ?? null;
    },
    async peek(name) {
      const { ok, data } = await apiCall('GET', `/peek?name=${encodeURIComponent(name)}`);
      if (!ok) return null;
      return data as PeekRecord;
    },
    async setSession(name, value, domains) {
      const { ok, data } = await apiCall('POST', '/session', { name, value, domains });
      if (!ok) throw new Error(errOf(data) ?? 'failed to set session secret');
    },
    async setPersisted(name, value, domains) {
      const { ok, data } = await apiCall('POST', '', { name, value, domains });
      if (!ok) throw new Error(errOf(data) ?? 'failed to persist secret');
    },
    async setScope(name, domains) {
      const { ok, data } = await apiCall('POST', '/scope', { name, domains });
      if (!ok) throw new Error(errOf(data) ?? 'failed to update scope');
    },
  };
}

/** Extension backend — relays through the service worker (has chrome.storage). */
export function createExtensionSecretBackend(): SecretBackend {
  return {
    async list() {
      const [persisted, session] = await Promise.all([
        swSendMessage<{ entries?: NamedDomains[]; error?: string }>({ type: 'secrets.list' }),
        swSendMessage<{ entries?: NamedDomains[]; error?: string }>({
          type: 'secrets.session.list',
        }),
      ]);
      const out: SecretRecord[] = [];
      for (const e of persisted?.entries ?? [])
        out.push({ name: e.name, domains: e.domains, persisted: true });
      for (const e of session?.entries ?? [])
        out.push({ name: e.name, domains: e.domains, persisted: false });
      return out;
    },
    async getInfo(name) {
      return (await this.list()).find((e) => e.name === name) ?? null;
    },
    async getMasked(name) {
      const resp = await swSendMessage<{ entries?: MaskedRecord[] }>({
        type: 'secrets.list-masked-entries',
      });
      return (resp?.entries ?? []).find((e) => e.name === name) ?? null;
    },
    async peek(name) {
      const resp = await swSendMessage<{ record?: PeekRecord; error?: string }>({
        type: 'secrets.peek',
        name,
      });
      if (resp?.error) throw new Error(resp.error);
      return resp?.record ?? null;
    },
    async setSession(name, value, domains) {
      const resp = await swSendMessage<{ ok?: boolean; error?: string }>({
        type: 'secrets.session.set',
        name,
        value,
        domains,
      });
      if (!resp?.ok) throw new Error(resp?.error ?? 'secrets.session.set failed');
    },
    async setPersisted(name, value, domains) {
      const resp = await swSendMessage<{ ok?: boolean; error?: string }>({
        type: 'secrets.set',
        name,
        value,
        domains,
      });
      if (!resp?.ok) throw new Error(resp?.error ?? 'secrets.set failed');
    },
    async setScope(name, domains) {
      const resp = await swSendMessage<{ ok?: boolean; error?: string }>({
        type: 'secrets.set-domains',
        name,
        domains,
      });
      if (!resp?.ok) throw new Error(resp?.error ?? 'secrets.set-domains failed');
    },
  };
}

function errOf(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'error' in data) {
    const e = (data as { error?: unknown }).error;
    if (typeof e === 'string') return e;
  }
  return undefined;
}

export function createDefaultSecretBackend(isExtension: boolean): SecretBackend {
  return isExtension ? createExtensionSecretBackend() : createCliSecretBackend();
}
