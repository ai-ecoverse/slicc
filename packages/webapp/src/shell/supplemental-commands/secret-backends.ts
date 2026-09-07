/**
 * Production backends for the `secret` command.
 *
 * The command runs in the agent realm; the secret stores (session + persisted)
 * and the masking pipeline live in the trusted realm (node-server in CLI mode,
 * the service worker in extension mode). These backends bridge the two via the
 * existing transports — HTTP `/api/secrets*` in CLI, `chrome.runtime` messages
 * in the extension. Session secrets never touch disk/storage; only the
 * in-memory session store in the trusted realm holds their values.
 *
 * The CLI backend routes through `resolveApiUrl` / `apiHeaders` so thin-bridge
 * mode (UI on sliccy.ai, node-server cross-origin on localhost) reaches the
 * bridge with `X-Bridge-Token`; same-origin callers keep the relative URL and
 * no extra headers.
 */

import type { FloatTopology } from '../float-topology.js';
import { apiHeaders, resolveApiUrl } from '../proxied-fetch.js';
import { callSecretsBridge } from '../secrets-bridge-client.js';

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

/** Result of {@link SecretBackend.delete}. */
export interface DeleteResult {
  /** Whether the secret existed before the call. */
  removed: boolean;
  /** When set, the secret was in the session store; otherwise the persisted store. */
  fromSession?: boolean;
}

/**
 * Outcome of {@link SecretBackend.list}, which reads two independent stores
 * (saved + session) and can lose one of them.
 *
 * The reason travels with the entries because dropping it made a broken store
 * indistinguishable from an empty one: when the Keychain read behind
 * `GET /api/secrets` stalled on an unanswered ACL dialog, `secret list` showed
 * no saved secrets at all — or, before that call was bounded, never returned.
 */
export interface SecretListResult {
  entries: SecretRecord[];
  /** One line per store that could not be read; empty on a complete answer. */
  warnings: string[];
}

/** The trusted-realm operations the `secret` command depends on. */
export interface SecretBackend {
  list(): Promise<SecretListResult>;
  getInfo(name: string): Promise<SecretRecord | null>;
  getMasked(name: string): Promise<MaskedRecord | null>;
  peek(name: string): Promise<PeekRecord | null>;
  setSession(name: string, value: string, domains: string[]): Promise<void>;
  setPersisted(name: string, value: string, domains: string[]): Promise<void>;
  setScope(name: string, domains: string[]): Promise<void>;
  /**
   * Remove a secret from the active backend, including its `_DOMAINS` companion.
   * Triggers a masking-pipeline reload so the change takes effect without a
   * restart. Returns `{ removed: false }` when no secret with that name existed.
   */
  delete(name: string): Promise<DeleteResult>;
}

/** Control messages routed to SECRETS_HANDLERS in the service worker. */
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

/**
 * Ceiling for one `/api/secrets*` call.
 *
 * Sits above the swift bridge's own 5 s persisted-store deadline so its
 * specific diagnosis wins the race and reaches the user, and at the
 * control-plane budget (`REST_CONTROL_CALL_TIMEOUT_MS`) so a broker waiting on
 * us never gives up first. Without it a stalled bridge hung the shell forever.
 */
const SECRET_API_TIMEOUT_MS = 10_000;

/** Status used for a call that never produced an HTTP response. */
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
    // Shaped like a failed response rather than rethrown, so every caller
    // reports a transport stall through the same path it already uses for a
    // server-side error instead of surfacing a raw DOMException.
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

/** Diagnosis for one half of a {@link SecretBackend.list} that came back empty-handed. */
function storeWarning(store: 'saved' | 'session', reason: string | undefined): string {
  return `could not read ${store} secrets — ${reason ?? 'the bridge gave no reason'}`;
}

/**
 * Resolve one name against a list result, failing closed on a partial answer.
 *
 * Absence is only trustworthy when every store answered. Reporting "no such
 * secret" from an incomplete list would tell `secret set` the name is new, which
 * skips the approval gate that stops an agent from overwriting an existing
 * credential — so an unread store raises here rather than resolving to `null`.
 */
function resolveInfo(result: SecretListResult, name: string): SecretRecord | null {
  const found = result.entries.find((e) => e.name === name) ?? null;
  if (found) return found;
  if (result.warnings.length > 0) throw new Error(result.warnings.join('; '));
  return null;
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

/**
 * Message-passing backend shared by the extension-direct and bridge transports.
 * The two differ only in how a control message reaches the SW's
 * `SECRETS_HANDLERS`: `swSendMessage` (same-extension) vs `callSecretsBridge`
 * (externally-connectable Port / panel-RPC). The message shapes and
 * optional-chaining/error handling below are identical across both.
 */
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
      // The handlers report a failed store as `error` with no `entries`; that
      // used to be swallowed, leaving a partial list looking complete.
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
      // Older SWs return `{ ok: true }` with no `removed` field. Treat that as
      // best-effort "removed" so the shell still reports success — same end
      // state as the request requested.
      const removed = resp.removed ?? true;
      return { removed, fromSession: resp.fromSession };
    },
  };
}

/** Extension backend — relays through the service worker (has chrome.storage). */
export function createExtensionSecretBackend(): SecretBackend {
  return createMessageSecretBackend((msg) => swSendMessage(msg));
}

/**
 * Thin-bridge backend — relays SECRETS_HANDLERS control messages over the
 * `secrets.crud` Port (page realm) / panel-RPC (kernel worker) instead of the
 * same-extension `chrome.runtime.sendMessage` path that's unavailable when
 * `chrome.runtime.id` is undefined. The SW dispatches the same handler set, so
 * every message `type` resolves identically.
 */
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

/**
 * Pick the production backend for the resolved secret topology. The thin-ext
 * hosted-leader tab / kernel worker (`extension-delegate`) routes over the
 * bridge; a real extension page/offscreen doc (`extension-direct`) uses the
 * same-extension SW path; everything else (CLI / Electron / swift / connect)
 * talks to the node-server REST surface.
 */
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
