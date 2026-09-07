/**
 * Secrets backend — the SW-owned `SecretsPipeline` plus every `secrets.*`
 * request handler and the `secrets.crud` Port.
 *
 * The SW owns the credential channel: the agent's tools never reach
 * `chrome.storage` (their `bash` runs in a WASM context with no chrome APIs;
 * `node -e` runs in a CSP-locked sandbox iframe with an opaque origin), and the
 * offscreen document has `chrome.runtime` but NOT `chrome.storage` (MV3 quirk).
 * So both RPC into this module.
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

import {
  type FetchProxySecretSource,
  previewSecret,
  SecretsPipeline,
  SessionSecretStore,
} from '@slicc/shared-ts';
import {
  deleteSecret,
  listSecrets,
  listSecretsWithValues,
  type StorageArea,
  setSecret,
} from './secrets-storage.js';
import { getMsgType, type SwMessageOutcome } from './sw-message-router.js';
import { beginPortPin, type PortPinDeps } from './sw-pinned-port.js';
import { readOrCreateSwSessionId } from './sw-session-id.js';

// Session-only secrets: in-memory, never written to chrome.storage. Lives for
// the service worker's lifetime (MV3 may evict it — that matches the
// "vanish on session end" semantics). Layered into every pipeline build so the
// fetch proxy unmasks session secrets like persisted ones.
const sessionSecretStore = new SessionSecretStore();
const storageLocal: StorageArea = chrome.storage.local;

export async function buildSecretsPipeline(): Promise<SecretsPipeline> {
  const sessionId = await readOrCreateSwSessionId();
  const source: FetchProxySecretSource = {
    get: async (name) => {
      const fromSession = sessionSecretStore.get(name);
      if (fromSession !== undefined) return fromSession;
      const got = (await chrome.storage.local.get(name)) as Record<string, string | undefined>;
      return got[name];
    },
    listAll: () => listSecretsWithValues(storageLocal),
  };
  return new SecretsPipeline({ sessionId, source, sessionStore: sessionSecretStore });
}

/** `buildSecretsPipeline()` + an initial `reload()`, the shape every caller wants. */
async function reloadedPipeline(): Promise<SecretsPipeline> {
  const pipeline = await buildSecretsPipeline();
  await pipeline.reload();
  return pipeline;
}

/**
 * Build + reload the secrets pipeline for a fetch-proxy Port. Shared by the
 * own-origin `onConnect` path and the external (leader-tab) `onConnectExternal`
 * path so both produce the SAME masked values. The returned promise is handed
 * to `handleFetchProxyConnectionAsync`, which attaches the Port `onMessage`
 * listener SYNCHRONOUSLY and awaits this promise INSIDE the handler — Chrome
 * drops Port messages that arrive before any listener exists, and the page
 * posts its `request` immediately after connect (before the async build).
 */
export function buildReloadedPipelinePromise(): Promise<SecretsPipeline> {
  return reloadedPipeline();
}

// ---------------------------------------------------------------------------
// Secrets message handlers
// ---------------------------------------------------------------------------

type SendResponse = (response?: unknown) => void;
type SecretsHandler = (msg: unknown, sendResponse: SendResponse) => boolean;
type SecretStringField = 'accessToken' | 'domains' | 'name' | 'providerId' | 'text' | 'value';
type SecretStringArrayField = 'domains' | 'texts';
type SecretsMessageType =
  | 'secrets.delete'
  | 'secrets.list'
  | 'secrets.list-masked-entries'
  | 'secrets.list-with-values-for-pipeline'
  | 'secrets.mask-oauth-token'
  | 'secrets.peek'
  | 'secrets.redact-export'
  | 'secrets.scrub-tool-result'
  | 'secrets.session.list'
  | 'secrets.session.set'
  | 'secrets.set'
  | 'secrets.set-domains';

function getStringField(msg: unknown, field: SecretStringField): string | undefined {
  if (typeof msg !== 'object' || msg === null || !(field in msg)) return undefined;
  const v = Reflect.get(msg, field);
  return typeof v === 'string' ? v : undefined;
}

function getStringArrayField(msg: unknown, field: SecretStringArrayField): string[] | undefined {
  if (typeof msg !== 'object' || msg === null || !(field in msg)) return undefined;
  const v = Reflect.get(msg, field);
  if (!Array.isArray(v)) return undefined;
  return v.filter((d): d is string => typeof d === 'string');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runSecretsListMaskedEntries(_msg: unknown, sendResponse: SendResponse): boolean {
  void (async () => {
    try {
      const pipeline = await reloadedPipeline();
      sendResponse({ entries: pipeline.getMaskedEntries() });
    } catch (err) {
      // Without this catch, the unhandled rejection closes the
      // message port and the caller resolves with `undefined` —
      // indistinguishable from "no entries", which silently
      // populates the agent shell with an empty env.
      console.error('[sw] secrets.list-masked-entries failed', err);
      sendResponse({ entries: [], error: errMsg(err) });
    }
  })();
  return true;
}

// Tool-output real→masked scrub. The offscreen agent realm holds
// only masked entries (no real values), so the scrub runs here
// against the SW-owned `SecretsPipeline`. Direction is real→masked
// ONLY; idempotent for already-masked tokens and secret-free
// output. Errors fail closed so unsanitized tool output never crosses
// the extension boundary when the scrub pipeline is unavailable.
function runSecretsScrubToolResult(msg: unknown, sendResponse: SendResponse): boolean {
  const text = getStringField(msg, 'text');
  if (text === undefined) return false;
  void (async () => {
    try {
      const pipeline = await reloadedPipeline();
      sendResponse({ text: pipeline.scrubResponse(text) });
    } catch {
      console.error('[sw] secrets.scrub-tool-result failed');
      sendResponse({ error: 'secret scrub failed' });
    }
  })();
  return true;
}

// Offscreen-only: snapshot the secrets needed to seed the outbound-scrub
// pipeline (defense-in-depth real → masked scrub on the LLM-wire `fetch`
// leg). The offscreen has no `chrome.storage`, so it RPCs here for the
// sessionId + merged {persisted, session} entry list. Mirrors
// `buildSecretsPipeline()` above so the offscreen's pipeline produces the
// same masked values as the SW fetch-proxy pipeline.
function runSecretsListWithValuesForPipeline(_msg: unknown, sendResponse: SendResponse): boolean {
  void (async () => {
    try {
      const sessionId = await readOrCreateSwSessionId();
      const persisted = await listSecretsWithValues(storageLocal);
      const persistedNames = new Set(persisted.map((e) => e.name));
      const session = sessionSecretStore.listAll().filter((s) => !persistedNames.has(s.name));
      const entries = [...persisted, ...session];
      sendResponse({ sessionId, entries });
    } catch (err) {
      console.error('[sw] secrets.list-with-values-for-pipeline failed', err);
      sendResponse({ sessionId: undefined, entries: [], error: errMsg(err) });
    }
  })();
  return true;
}

// The panel-terminal `secret` command can't touch chrome.storage directly:
// it runs in the offscreen document, which lacks chrome.storage even when
// the manifest grants it (MV3 quirk). Route the management ops through
// the SW, which DOES have chrome.storage.
function runSecretsList(_msg: unknown, sendResponse: SendResponse): boolean {
  void (async () => {
    try {
      const entries = await listSecrets(storageLocal);
      sendResponse({ entries });
    } catch (err) {
      console.error('[sw] secrets.list failed', err);
      sendResponse({ entries: [], error: errMsg(err) });
    }
  })();
  return true;
}

function runSecretsSet(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  const value = getStringField(msg, 'value');
  const domains = getStringArrayField(msg, 'domains');
  if (name === undefined || value === undefined || domains === undefined) return false;
  void (async () => {
    try {
      await setSecret(storageLocal, name, value, domains);
      sendResponse({ ok: true });
    } catch (err) {
      console.error('[sw] secrets.set failed', err);
      sendResponse({ ok: false, error: errMsg(err) });
    }
  })();
  return true;
}

function runSecretsDelete(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  if (name === undefined) return false;
  void (async () => {
    try {
      // Session secrets win over persisted on name collision (mirrors the
      // node-server endpoint), so they are also checked first on delete.
      if (sessionSecretStore.has(name)) {
        sessionSecretStore.delete(name);
        sendResponse({ ok: true, removed: true, fromSession: true });
        return;
      }
      const existing = await listSecrets(storageLocal);
      if (!existing.some((e) => e.name === name)) {
        sendResponse({ ok: true, removed: false });
        return;
      }
      await deleteSecret(storageLocal, name);
      sendResponse({ ok: true, removed: true, fromSession: false });
    } catch (err) {
      console.error('[sw] secrets.delete failed', err);
      sendResponse({ ok: false, error: errMsg(err) });
    }
  })();
  return true;
}

// Session-secret set — in-memory only, never written to chrome.storage.
function runSecretsSessionSet(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  const value = getStringField(msg, 'value');
  const domains = getStringArrayField(msg, 'domains');
  if (name === undefined || value === undefined || domains === undefined) return false;
  sessionSecretStore.set(name, value, domains);
  sendResponse({ ok: true });
  return true;
}

function runSecretsSessionList(_msg: unknown, sendResponse: SendResponse): boolean {
  sendResponse({ entries: sessionSecretStore.list() });
  return true;
}

// Peek — returns an elided preview of the unmasked value (session or
// persisted). The full value never leaves the SW.
function runSecretsPeek(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  if (name === undefined) return false;
  void (async () => {
    try {
      const sessionRec = sessionSecretStore.getRecord(name);
      if (sessionRec) {
        sendResponse({
          record: {
            name,
            preview: previewSecret(sessionRec.value),
            domains: sessionRec.domains,
          },
        });
        return;
      }
      const all = await listSecretsWithValues(storageLocal);
      const found = all.find((e) => e.name === name);
      sendResponse({
        record: found
          ? { name, preview: previewSecret(found.value), domains: found.domains }
          : undefined,
      });
    } catch (err) {
      console.error('[sw] secrets.peek failed', err);
      sendResponse({ record: undefined, error: errMsg(err) });
    }
  })();
  return true;
}

// Scope edit — update the allowed domains of an existing secret (session or
// persisted), preserving the value.
function runSecretsSetDomains(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  const domains = getStringArrayField(msg, 'domains');
  if (name === undefined || domains === undefined) return false;
  void (async () => {
    try {
      if (sessionSecretStore.has(name)) {
        sessionSecretStore.setDomains(name, domains);
        sendResponse({ ok: true });
        return;
      }
      const all = await listSecretsWithValues(storageLocal);
      const found = all.find((e) => e.name === name);
      if (!found) {
        sendResponse({ ok: false, error: 'secret not found' });
        return;
      }
      await setSecret(storageLocal, name, found.value, domains);
      sendResponse({ ok: true });
    } catch {
      console.error('[sw] secrets.set-domains failed');
      sendResponse({ ok: false, error: 'secret scope update failed' });
    }
  })();
  return true;
}

async function runMaskOauthTokenWrite(
  providerId: string,
  accessToken: string | undefined,
  domains: string | undefined
): Promise<string | undefined> {
  // #847: the caller may be the offscreen document, which has
  // `chrome.runtime` but NOT `chrome.storage` (MV3 quirk — same reason
  // `secrets.set` proxies through the SW). Write the secret here, where
  // the SW owns `chrome.storage`, before building the pipeline that
  // masks it. `domains` is the comma-joined `_DOMAINS` companion.
  if (accessToken && domains) {
    await chrome.storage.local.set({
      [`oauth.${providerId}.token`]: accessToken,
      [`oauth.${providerId}.token_DOMAINS`]: domains,
    });
  }
  const pipeline = await reloadedPipeline();
  const name = `oauth.${providerId}.token`;
  return pipeline.getMaskedEntries().find((e) => e.name === name)?.maskedValue;
}

function runSecretsMaskOauthToken(msg: unknown, sendResponse: SendResponse): boolean {
  const providerId = getStringField(msg, 'providerId');
  if (providerId === undefined) return false;
  const accessToken = getStringField(msg, 'accessToken');
  const domains = getStringField(msg, 'domains');
  void (async () => {
    try {
      const maskedValue = await runMaskOauthTokenWrite(providerId, accessToken, domains);
      // We just wrote the secret above, so a missing entry here is NOT a
      // cold-start miss — it's a real fault (write didn't land, or the
      // pipeline stopped emitting it). Surface it so the page side can
      // distinguish "not warm yet" from "wrote it and still missing".
      if (accessToken && domains && maskedValue === undefined) {
        // Real fault (not a cold miss): surface a reason so the page can
        // distinguish it and the give-up log isn't reason-less (#847).
        console.warn('[sw] secrets.mask-oauth-token: entry missing after write');
        sendResponse({ maskedValue: undefined, error: 'entry missing after write' });
        return;
      }
      sendResponse({ maskedValue });
    } catch {
      console.error('[sw] secrets.mask-oauth-token failed');
      sendResponse({ maskedValue: undefined, error: 'OAuth token masking failed' });
    }
  })();
  return true;
}

// Fail-closed export redaction. Batch-replaces all known secret values
// (both real and masked forms) with stable anonymous markers for transcript
// export. Unlike scrub-tool-result, this MUST NOT degrade to returning the
// input — any failure returns { error } with no request texts echoed.
function runSecretsRedactExport(msg: unknown, sendResponse: SendResponse): boolean {
  const texts = getStringArrayField(msg, 'texts');
  if (texts === undefined) return false;
  void (async () => {
    try {
      const pipeline = await reloadedPipeline();
      sendResponse(pipeline.redactForExport(texts));
    } catch (err) {
      console.error('[sw] secrets.redact-export failed', err);
      // Fail-closed: never echo input texts in error response.
      sendResponse({ error: errMsg(err) });
    }
  })();
  return true;
}

const SECRETS_HANDLERS = {
  'secrets.list-masked-entries': runSecretsListMaskedEntries,
  'secrets.scrub-tool-result': runSecretsScrubToolResult,
  'secrets.list-with-values-for-pipeline': runSecretsListWithValuesForPipeline,
  'secrets.list': runSecretsList,
  'secrets.set': runSecretsSet,
  'secrets.delete': runSecretsDelete,
  'secrets.session.set': runSecretsSessionSet,
  'secrets.session.list': runSecretsSessionList,
  'secrets.peek': runSecretsPeek,
  'secrets.set-domains': runSecretsSetDomains,
  'secrets.mask-oauth-token': runSecretsMaskOauthToken,
  'secrets.redact-export': runSecretsRedactExport,
} satisfies { [Type in SecretsMessageType]: SecretsHandler };

function isSecretsMessageType(type: string): type is SecretsMessageType {
  return Object.hasOwn(SECRETS_HANDLERS, type);
}

function resolveSecretsHandler(msg: unknown): SecretsHandler | undefined {
  const type = getMsgType(msg);
  return type !== undefined && isSecretsMessageType(type) ? SECRETS_HANDLERS[type] : undefined;
}

/** `chrome.runtime.onMessage` branch for every `secrets.*` request. */
export function handleSecretsMessage(
  message: unknown,
  _sender: ChromeMessageSender,
  sendResponse: (response?: unknown) => void
): SwMessageOutcome {
  const handler = resolveSecretsHandler(message);
  if (!handler) return 'not-handled';
  // A handler returning false means the payload failed its field guard; the
  // original three-listener wiring surfaced that as "nobody handled it", so
  // the caller still resolves with `undefined`.
  return handler(message, sendResponse) ? 'handled-async' : 'not-handled';
}

/**
 * `secrets.crud` Port handler. The hosted leader tab proxies secrets CRUD
 * through this Port because pages other than the extension's own origin can't
 * reach `chrome.storage`. Gated by the same three-factor pin as the bridge.
 */
export function handleSecretsCrudPort(port: ChromeRuntimePort, deps: PortPinDeps): void {
  const pinPromise = beginPortPin(port, deps, 'secrets.crud');
  port.onMessage.addListener(async (raw) => {
    const id = (raw as { id?: unknown } | null)?.id;
    let replied = false;
    const reply = (response: unknown): void => {
      if (replied) return;
      replied = true;
      port.postMessage({ id, response });
    };
    const pin = await pinPromise;
    if (!pin.ok) {
      reply({ error: pin.error });
      return;
    }
    const handler = resolveSecretsHandler(raw);
    if (!handler) {
      reply({ error: `unknown secrets type: ${getMsgType(raw) ?? 'undefined'}` });
      return;
    }
    if (!handler(raw, reply)) {
      reply({ error: `malformed secrets request: ${getMsgType(raw)}` });
    }
  });
}
