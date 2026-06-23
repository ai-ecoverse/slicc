/**
 * Bridge client for the `mount.sign-and-forward` Port (EXT8, thin-extension
 * topology).
 *
 * In the hosted-leader tab / kernel worker the agent realm cannot use the
 * same-extension `chrome.runtime.sendMessage` path (no `chrome.runtime.id`), so
 * S3 / DA mount sign-and-forward envelopes are routed to the extension over an
 * externally-connectable `chrome.runtime.connect(<delegateId>, { name:
 * 'mount.sign-and-forward' })` Port — the SW side mirrors the `secrets.crud` and
 * `fetch-proxy.fetch` handlers.
 *
 * The Port is opened lazily and cached for the session; replies are correlated
 * by a monotonically increasing `id`. Unlike the best-effort secrets bridge, a
 * failed mount call must surface (a mount that silently degrades is a bug), so
 * transport faults reject with `FsError` — `envelopeToResponse` in
 * `signed-fetch.ts` already maps envelope-level errors uniformly.
 *
 * Realm-aware, mirroring `callSecretsBridge` / `createProxiedFetch`'s transport:
 *
 *   a. PAGE realm (`chrome.runtime.connect` present, no `chrome.runtime.id`):
 *      the direct `mount.sign-and-forward` Port path.
 *   b. WORKER realm (no `chrome`, but a delegate id was forwarded at boot):
 *      bridge to the page over panel-RPC (the page takes branch (a) for us via
 *      the `mount-sign-and-forward` handler), then return the handler's reply.
 *
 * S3 credentials never cross this bridge (the SW reads `s3.<profile>.*` from
 * chrome.storage); DA envelopes carry only a transient IMS bearer the SW
 * forwards. Only the control `type` is ever logged.
 */

import type { SignAndForwardReply } from '@slicc/shared-ts';
import { createLogger } from '../../core/logger.js';
import { getExtensionDelegateId } from '../../shell/proxied-fetch.js';
import { FsError } from '../types.js';

const log = createLogger('mount-bridge');

export type MountSignAndForwardType = 'mount.s3-sign-and-forward' | 'mount.da-sign-and-forward';

/**
 * Per-call timeout. Mount sign-and-forward fetches whole objects, so align
 * with the proxied-fetch worker leg (120s) rather than the secrets bridge's
 * 10s — a slow-but-valid transfer must not be converted into a hard failure.
 */
const CALL_TIMEOUT_MS = 120_000;

/** Minimal structural view of the explicit-id `chrome.runtime` Port. */
interface MountBridgePort {
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
}

interface ChromeRuntimeConnect {
  connect: (extensionId: string, info: { name: string }) => MountBridgePort;
}

interface PendingCall {
  resolve: (value: SignAndForwardReply) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

let cachedPort: MountBridgePort | null = null;
let nextId = 1;
const pending = new Map<number, PendingCall>();

function handleMessage(raw: unknown): void {
  const msg = raw as { id?: number; response?: SignAndForwardReply };
  if (typeof msg?.id !== 'number') return;
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  clearTimeout(entry.timer);
  entry.resolve(msg.response as SignAndForwardReply);
}

function handleDisconnect(): void {
  cachedPort = null;
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new FsError('EIO', 'mount.sign-and-forward port disconnected'));
  }
  pending.clear();
  log.debug('mount.sign-and-forward port disconnected; pending cleared, will reconnect');
}

/** Open (or reuse) the cached `mount.sign-and-forward` Port; `null` if unavailable. */
function openPort(): MountBridgePort | null {
  if (cachedPort) return cachedPort;
  const id = getExtensionDelegateId();
  if (!id) {
    log.warn('cannot open mount.sign-and-forward port: no extension delegate id');
    return null;
  }
  if (typeof chrome === 'undefined' || typeof chrome?.runtime?.connect !== 'function') {
    log.warn('cannot open mount.sign-and-forward port: chrome.runtime.connect unavailable');
    return null;
  }
  const connect = (chrome.runtime as unknown as ChromeRuntimeConnect).connect;
  const port = connect(id, { name: 'mount.sign-and-forward' });
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(handleDisconnect);
  cachedPort = port;
  return port;
}

/**
 * Dispatch a `mount.sign-and-forward` envelope and await the correlated reply.
 * See the module header for the realm-aware routing. Rejects with `FsError`
 * when the bridge is unavailable, the call times out, or the Port disconnects
 * mid-flight — never resolves a degraded result.
 */
export function callMountBridge(
  type: MountSignAndForwardType,
  envelope: unknown
): Promise<SignAndForwardReply> {
  // (b) Kernel-worker realm: no `chrome`, but a delegate id is set. Bridge to
  // the page over panel-RPC instead of failing. Mirrors `callSecretsBridge`.
  if (typeof chrome === 'undefined' && getExtensionDelegateId()) {
    return callViaPanelRpc(type, envelope);
  }
  // (a) Page realm direct Port (or unavailable → FsError).
  return callViaPort(type, envelope);
}

/** Branch (a): open (or reuse) the direct `mount.sign-and-forward` Port. */
function callViaPort(
  type: MountSignAndForwardType,
  envelope: unknown
): Promise<SignAndForwardReply> {
  return new Promise<SignAndForwardReply>((resolve, reject) => {
    const port = openPort();
    if (!port) {
      reject(
        new FsError('EIO', `mount transport failed: extension delegate unavailable (${type})`)
      );
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(new FsError('EIO', `mount transport: ${type} timed out`));
      }
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      port.postMessage({ id, type, envelope });
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      cachedPort = null;
      reject(
        new FsError(
          'EIO',
          `mount transport failed: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }
  });
}

/**
 * Branch (b): bridge over panel-RPC to the page realm. Lazy-imports the client
 * so panel-RPC isn't pulled into non-worker bundles.
 */
async function callViaPanelRpc(
  type: MountSignAndForwardType,
  envelope: unknown
): Promise<SignAndForwardReply> {
  const { getPanelRpcClient } = await import('../../kernel/panel-rpc.js');
  const client = getPanelRpcClient();
  if (!client) {
    throw new FsError(
      'EIO',
      `mount transport failed: panel-RPC client unavailable in worker realm (${type})`
    );
  }
  const { reply } = await client.call(
    'mount-sign-and-forward',
    { type, envelope },
    { timeoutMs: CALL_TIMEOUT_MS }
  );
  return reply;
}
