import type { FloatTopology } from '../float-topology.js';
import { apiHeaders, resolveApiUrl } from '../proxied-fetch.js';
import { callSecretsBridge } from '../secrets-bridge-client.js';

export interface SecretRecord {
  name: string;
  domains: string[];

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

export interface DeleteResult {
  removed: boolean;

  fromSession?: boolean;
}

export interface SecretListResult {
  entries: SecretRecord[];

  warnings: string[];
}

export interface SecretBackend {
  list(): Promise<SecretListResult>;
  getInfo(name: string): Promise<SecretRecord | null>;
  getMasked(name: string): Promise<MaskedRecord | null>;
  peek(name: string): Promise<PeekRecord | null>;
  setSession(name: string, value: string, domains: string[]): Promise<void>;
  setPersisted(name: string, value: string, domains: string[]): Promise<void>;
  setScope(name: string, domains: string[]): Promise<void>;

  delete(name: string): Promise<DeleteResult>;
}

type SecretsControlMessage =
  | { type: 'secrets.list' }
  | { type: 'secrets.session.list' }
  | { type: 'secrets.list-masked-entries' }
  | { type: 'secrets.peek'; name: string }
  | { type: 'secrets.session.set'; name: string; value: string; domains: string[] }
  | { type: 'secrets.set'; name: string; value: string; domains: string[] }
  | { type: 'secrets.set-domains'; name: string; domains: string[] }
  | { type: 'secrets.delete'; name: string };

function swSendMessage<T>(msg: SecretsControlMessage): Promise<T> {
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

const SECRET_API_TIMEOUT_MS = 10_000;

const NO_RESPONSE_STATUS = 0;

async function apiCall(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const init: RequestInit = {
    method,
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    signal: AbortSignal.timeout(SECRET_API_TIMEOUT_MS),
  };
  if (body) init.body = JSON.stringify(body);
  try {
    const resp = await fetch(resolveApiUrl(`/api/secrets${path}`), init);
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    return { ok: false, status: NO_RESPONSE_STATUS, data: { error: transportErrorMessage(err) } };
  }
}

function transportErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `no response from the secret store within ${SECRET_API_TIMEOUT_MS / 1000}s`;
  }
  return `secret store unreachable: ${err instanceof Error ? err.message : String(err)}`;
}

function storeWarning(store: 'saved' | 'session', reason: string | undefined): string {
  return `could not read ${store} secrets — ${reason ?? 'the bridge gave no reason'}`;
}

function resolveInfo(result: SecretListResult, name: string): SecretRecord | null {
  const found = result.entries.find((e) => e.name === name) ?? null;
  if (found) return found;
  if (result.warnings.length > 0) throw new Error(result.warnings.join('; '));
  return null;
}

type NamedDomains = { name: string; domains: string[] };

export function createCliSecretBackend(): SecretBackend {
  return {
    async list() {
      const [persisted, session] = await Promise.all([
        apiCall('GET', ''),
        apiCall('GET', '/session'),
      ]);
      const entries: SecretRecord[] = [];
      const warnings: string[] = [];
      if (persisted.ok) {
        for (const e of persisted.data as NamedDomains[])
          entries.push({ name: e.name, domains: e.domains, persisted: true });
      } else {
        warnings.push(storeWarning('saved', errOf(persisted.data)));
      }
      if (session.ok) {
        for (const e of session.data as NamedDomains[])
          entries.push({ name: e.name, domains: e.domains, persisted: false });
      } else {
        warnings.push(storeWarning('session', errOf(session.data)));
      }
      return { entries, warnings };
    },
    async getInfo(name) {
      return resolveInfo(await this.list(), name);
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
    async delete(name) {
      const { ok, status, data } = await apiCall('DELETE', `/${encodeURIComponent(name)}`);
      if (status === 404) return { removed: false };
      if (!ok) throw new Error(errOf(data) ?? 'failed to delete secret');
      const fromSession =
        data && typeof data === 'object' && 'fromSession' in data
          ? Boolean((data as { fromSession?: unknown }).fromSession)
          : undefined;
      return { removed: true, fromSession };
    },
  };
}

function createMessageSecretBackend(
  send: (msg: SecretsControlMessage) => Promise<unknown>
): SecretBackend {
  const call = <T>(msg: SecretsControlMessage): Promise<T> => send(msg) as Promise<T>;
  return {
    async list() {
      const [persisted, session] = await Promise.all([
        call<{ entries?: NamedDomains[]; error?: string }>({ type: 'secrets.list' }),
        call<{ entries?: NamedDomains[]; error?: string }>({
          type: 'secrets.session.list',
        }),
      ]);
      const entries: SecretRecord[] = [];
      const warnings: string[] = [];
      for (const e of persisted?.entries ?? [])
        entries.push({ name: e.name, domains: e.domains, persisted: true });
      for (const e of session?.entries ?? [])
        entries.push({ name: e.name, domains: e.domains, persisted: false });

      if (!persisted?.entries) warnings.push(storeWarning('saved', persisted?.error));
      if (!session?.entries) warnings.push(storeWarning('session', session?.error));
      return { entries, warnings };
    },
    async getInfo(name) {
      return resolveInfo(await this.list(), name);
    },
    async getMasked(name) {
      const resp = await call<{ entries?: MaskedRecord[] }>({
        type: 'secrets.list-masked-entries',
      });
      return (resp?.entries ?? []).find((e) => e.name === name) ?? null;
    },
    async peek(name) {
      const resp = await call<{ record?: PeekRecord; error?: string }>({
        type: 'secrets.peek',
        name,
      });
      if (resp?.error) throw new Error(resp.error);
      return resp?.record ?? null;
    },
    async setSession(name, value, domains) {
      const resp = await call<{ ok?: boolean; error?: string }>({
        type: 'secrets.session.set',
        name,
        value,
        domains,
      });
      if (!resp?.ok) throw new Error(resp?.error ?? 'secrets.session.set failed');
    },
    async setPersisted(name, value, domains) {
      const resp = await call<{ ok?: boolean; error?: string }>({
        type: 'secrets.set',
        name,
        value,
        domains,
      });
      if (!resp?.ok) throw new Error(resp?.error ?? 'secrets.set failed');
    },
    async setScope(name, domains) {
      const resp = await call<{ ok?: boolean; error?: string }>({
        type: 'secrets.set-domains',
        name,
        domains,
      });
      if (!resp?.ok) throw new Error(resp?.error ?? 'secrets.set-domains failed');
    },
    async delete(name) {
      const resp = await call<{
        ok?: boolean;
        removed?: boolean;
        fromSession?: boolean;
        error?: string;
      }>({ type: 'secrets.delete', name });
      if (!resp?.ok) throw new Error(resp?.error ?? 'secrets.delete failed');

      const removed = resp.removed ?? true;
      return { removed, fromSession: resp.fromSession };
    },
  };
}

export function createExtensionSecretBackend(): SecretBackend {
  return createMessageSecretBackend((msg) => swSendMessage(msg));
}

export function createBridgeSecretBackend(): SecretBackend {
  return createMessageSecretBackend((msg) => {
    const { type, ...rest } = msg as { type: string };
    return callSecretsBridge(type, rest);
  });
}

function errOf(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'error' in data) {
    const e = (data as { error?: unknown }).error;
    if (typeof e === 'string') return e;
  }
  return undefined;
}

export function createDefaultSecretBackend(topology: FloatTopology): SecretBackend {
  switch (topology) {
    case 'extension-direct':
      return createExtensionSecretBackend();
    case 'extension-delegate':
      return createBridgeSecretBackend();
    default:
      return createCliSecretBackend();
  }
}
