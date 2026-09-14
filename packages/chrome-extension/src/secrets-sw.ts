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

async function reloadedPipeline(): Promise<SecretsPipeline> {
  const pipeline = await buildSecretsPipeline();
  await pipeline.reload();
  return pipeline;
}

export function buildReloadedPipelinePromise(): Promise<SecretsPipeline> {
  return reloadedPipeline();
}

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
      console.error('[sw] secrets.list-masked-entries failed', err);
      sendResponse({ entries: [], error: errMsg(err) });
    }
  })();
  return true;
}

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

      if (accessToken && domains && maskedValue === undefined) {
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

function runSecretsRedactExport(msg: unknown, sendResponse: SendResponse): boolean {
  const texts = getStringArrayField(msg, 'texts');
  if (texts === undefined) return false;
  void (async () => {
    try {
      const pipeline = await reloadedPipeline();
      sendResponse(pipeline.redactForExport(texts));
    } catch (err) {
      console.error('[sw] secrets.redact-export failed', err);

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

export function handleSecretsMessage(
  message: unknown,
  _sender: ChromeMessageSender,
  sendResponse: (response?: unknown) => void
): SwMessageOutcome {
  const handler = resolveSecretsHandler(message);
  if (!handler) return 'not-handled';

  return handler(message, sendResponse) ? 'handled-async' : 'not-handled';
}

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
