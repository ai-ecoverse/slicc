/**
 * Panel-RPC: a typed BroadcastChannel bridge that lets DOM-bound shell
 * supplemental commands run from the kernel worker.
 *
 * ## Why
 *
 * In standalone mode the agent's bash tool runs inside a
 * `DedicatedWorker` (`kernel-worker.ts`). Worker globals expose neither
 * `window`/`document` nor the DOM-only halves of `navigator` —
 * `mediaDevices`, `clipboard`, `speechSynthesis`, `AudioContext`. Any
 * supplemental command that touches those APIs directly currently
 * fails with "browser APIs are unavailable" when invoked from the
 * agent.
 *
 * The fix is to keep the DOM operations on the page (which always has
 * a DOM in every float that hosts the webapp) and route requests from
 * the worker over a single channel. This module is the channel.
 *
 * ## Shape
 *
 * - Worker side calls `createPanelRpcClient({ instanceId })` and gets
 *   a thin `{ call(op, payload, opts?) }` surface. Each `call` posts a
 *   request on the BroadcastChannel and resolves with the page-side
 *   result (or rejects with the page-side error / timeout).
 *
 * - Page side calls `installPanelRpcHandler({ handlers, instanceId })`
 *   with a record of per-op handlers, and gets back a disposer. The
 *   handler dispatches incoming requests and posts responses on the
 *   same channel. Unknown ops resolve with a clear error rather than
 *   hanging the worker.
 *
 * Mirrors `sprinkle-bridge-channel.ts` (instance-scoped channel name,
 * UUID request ids). Default timeout is 15s — long enough that the
 * page handler has plenty of room to do real DOM work (capture
 * pipelines, audio decode) without spurious timeouts, but short enough
 * that a hung handler still surfaces. Extension mode does not use
 * this bridge — the offscreen document already has a DOM, so DOM-bound
 * commands run directly there.
 */

import type { OAuthExtraDomainsStore } from '@slicc/shared-ts';
import type { LeaderTrayRuntimeStatus } from '../scoops/tray-leader.js';
import type { TrayLeaveResult } from '../scoops/tray-leave.js';

const PANEL_RPC_CHANNEL = 'slicc-panel-rpc';
const DEFAULT_TIMEOUT_MS = 15_000;
/** Public alias of the panel-RPC default `call()` timeout (15s). */
export const PANEL_RPC_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

export function panelRpcChannelName(instanceId?: string): string {
  return instanceId ? `${PANEL_RPC_CHANNEL}:${instanceId}` : PANEL_RPC_CHANNEL;
}

// ── Op surface ──────────────────────────────────────────────────────

/**
 * The closed set of operations the worker can ask the page to perform.
 * Each branch documents the payload it takes and the result shape.
 */
export type PanelRpcRequest =
  | { op: 'page-info'; payload?: undefined }
  | {
      op: 'screencapture';
      payload: { mimeType: string; quality: number };
    }
  | {
      op: 'speak-text';
      payload: {
        text: string;
        lang?: string;
        voice?: string;
        rate?: number;
        pitch?: number;
        volume?: number;
      };
    }
  | {
      op: 'list-voices';
      payload?: undefined;
    }
  | {
      op: 'play-audio';
      payload: { bytes: ArrayBuffer; mimeType?: string; volume?: number };
    }
  | {
      op: 'play-chime';
      payload: { tone?: 'success' | 'error' | 'notify' };
    }
  | { op: 'clipboard-read-text'; payload?: undefined }
  | { op: 'clipboard-write-text'; payload: { text: string } }
  | {
      op: 'clipboard-write-image';
      payload: { bytes: ArrayBuffer; mimeType: string };
    }
  | {
      op: 'window-open';
      payload: { url: string; target?: string; features?: string };
    }
  | {
      op: 'oauth-popup';
      payload: { url: string };
    }
  | {
      op: 'capture-camera';
      payload: {
        mode: 'photo' | 'video';
        deviceId?: string;
        audioDeviceId?: string;
        captureAudio?: boolean;
        /**
         * Open a video track on the stream. Defaults to true for
         * photo / video mode; set to false for audio-only video
         * captures so `getUserMedia` doesn't request a camera.
         */
        captureVideo?: boolean;
        width?: number;
        height?: number;
        frameRate?: number;
        exactSize?: boolean;
        mimeType: string;
        quality?: number;
        durationMs?: number;
        /** Photo mode: ms to let the sensor's auto-exposure settle
         * before grabbing the frame. */
        warmupMs?: number;
      };
    }
  | { op: 'enumerate-media-devices'; payload?: undefined }
  | {
      // Reset the page-side multi-browser-sync leader tray. The
      // tray subsystem lives on the page (DOM, RTCPeerConnections,
      // sync-manager state), so the worker can't drive
      // `LeaderTrayManager.reset()` directly — it bridges through
      // here. Result is the new runtime status after the new session
      // is established (or an error from the leader's start flow).
      // Handler throws when no leader tray is active.
      op: 'tray-reset';
      payload?: undefined;
    }
  | {
      // Leave the multi-browser-sync tray (or switch from follower to
      // leader on the supplied worker base URL). Worker callers (the
      // `host leave` shell command) route through here; the
      // leader/follower tray handles live page-side and own
      // non-transferable WebRTC resources, so the page is the only
      // side that can stop them.
      //
      // `workerBaseUrl: null` leaves entirely; a string value switches
      // role to leader on that worker. `requestId` is forwarded into
      // failure log meta so log entries on the worker and the page can
      // be correlated across rapid retries.
      op: 'tray-leave';
      payload: { workerBaseUrl: string | null; requestId?: string };
    }
  | {
      // Write the user-configured extra-OAuth-domains store for a
      // single provider. Worker writes can't reach page localStorage
      // directly (the kernel-worker shim is page→worker only — see
      // `kernel-worker.ts:installLocalStorageShim`), so the
      // `oauth-domain` command routes writes through the page handler
      // which mutates real `localStorage`. Response carries the full
      // post-write store so the worker can mirror it into its shim
      // before resolving, avoiding the page→worker forward race.
      op: 'oauth-extras-set';
      payload: { providerId: string; domains: string[] };
    }
  | {
      // Persist the full `slicc_accounts` array (the canonical OAuth
      // login store) to real page `localStorage`. Same shim hazard as
      // `oauth-extras-set`: the kernel-worker `localStorage` shim is
      // page→worker only, so worker writes from `mcp add` /
      // `onSilentRenew` would otherwise be lost on reload. Response
      // carries the post-write serialized JSON so the worker can
      // mirror it into its shim immediately. See issue #701.
      op: 'save-oauth-accounts';
      payload: { accountsJson: string };
    }
  | {
      // Push a `cherry.slicc_event` (cone → host page) out through the
      // page-side LeaderSyncManager. The `cherry-emit` shell command runs
      // in the kernel worker, but the leader tray's WebRTC data channels
      // live on the page, so the worker bridges here. `runtimeId` is the
      // canonical follower id (a bare runtime id, no `:localTarget`
      // suffix). Result `delivered` is false when no leader tray is active
      // or the owning follower is not connected, letting the command
      // surface a clear failure rather than silently succeeding.
      op: 'cherry-emit';
      payload: { runtimeId: string; name: string; detail?: unknown };
    }
  | {
      // Fetch remote (follower) browser targets from the page-side
      // BrowserAPI. The tray provider is set on the page-side instance
      // only — the worker's BrowserAPI has no reference to it, so
      // listAllTargets() in the worker falls back to local CDP tabs.
      // This op bridges the gap: the page fetches its full target list
      // and returns only entries with composite targetIds (remote ones).
      op: 'list-remote-targets';
      payload?: undefined;
    }
  | {
      // Drive a remote (tray/cherry) target: relay a single CDP command
      // to the page-side RemoteCDPTransport that owns the WebRTC channel.
      // The worker's PanelRpcCdpTransport can't own an RTCDataChannel, so
      // it tunnels here. `sessionId` threads through transparently.
      op: 'remote-cdp-send';
      payload: {
        runtimeId: string;
        localTargetId: string;
        method: string;
        params?: Record<string, unknown>;
        sessionId?: string;
        /**
         * Per-op CDP timeout (ms) forwarded to the page-side
         * `RemoteCDPTransport.send` so a long op (e.g. `Page.printToPDF`)
         * isn't floored at the page transport's 30s default. The panel-RPC
         * `call` timeout is always layered strictly above this.
         */
        timeout?: number;
      };
    }
  | {
      // Subscribe the page-side RemoteCDPTransport to a CDP event so its
      // firings get pushed back to the worker as `remote-cdp-event`.
      // Ref-counted page-side (0→1 wires a forwarder).
      op: 'remote-cdp-subscribe';
      payload: { runtimeId: string; localTargetId: string; event: string };
    }
  | {
      // Drop one event subscription (1→0 unwires the page-side forwarder).
      op: 'remote-cdp-unsubscribe';
      payload: { runtimeId: string; localTargetId: string; event: string };
    }
  | {
      // Dispose the page-side session for a target (drops forwarders and
      // the RemoteCDPTransport). Sent by PanelRpcCdpTransport.disconnect().
      op: 'remote-cdp-detach';
      payload: { runtimeId: string; localTargetId: string };
    }
  | {
      // Open a new tab on a remote runtime; returns the composite targetId.
      op: 'remote-open-tab';
      payload: { runtimeId: string; url: string };
    };

export interface PanelRpcResults {
  'page-info': { origin: string; href: string; title: string };
  screencapture: { bytes: ArrayBuffer; width: number; height: number; mimeType: string };
  'speak-text': { done: true };
  'list-voices': { voices: Array<{ name: string; lang: string; default: boolean }> };
  'play-audio': { done: true };
  'play-chime': { done: true };
  'clipboard-read-text': { text: string };
  'clipboard-write-text': { done: true };
  'clipboard-write-image': { done: true };
  'window-open': { opened: boolean };
  'oauth-popup': { redirectUrl: string | null };
  'capture-camera': {
    bytes: ArrayBuffer;
    mimeType: string;
    width: number;
    height: number;
    durationMs?: number;
  };
  'enumerate-media-devices': {
    videoinputs: Array<{ deviceId: string; label: string; groupId?: string }>;
    audioinputs: Array<{ deviceId: string; label: string; groupId?: string }>;
  };
  'tray-reset': LeaderTrayRuntimeStatus;
  'tray-leave': TrayLeaveResult;
  'oauth-extras-set': { storeAfter: OAuthExtraDomainsStore };
  'save-oauth-accounts': { storedJson: string };
  'cherry-emit': { delivered: boolean };
  'list-remote-targets': {
    targets: Array<{ targetId: string; title: string; url: string }>;
  };
  'remote-cdp-send': Record<string, unknown>;
  'remote-cdp-subscribe': { ok: true };
  'remote-cdp-unsubscribe': { ok: true };
  'remote-cdp-detach': { ok: true };
  'remote-open-tab': { targetId: string };
}

export type PanelRpcOp = PanelRpcRequest['op'];
export type PanelRpcPayloadFor<O extends PanelRpcOp> = Extract<
  PanelRpcRequest,
  { op: O }
>['payload'];
export type PanelRpcResultFor<O extends PanelRpcOp> = PanelRpcResults[O];

/**
 * Compile-time completeness guard: every `PanelRpcOp` must have a
 * matching `PanelRpcResults` entry. Indexing `PanelRpcResults[K]` for an
 * op `K` that lacks a result entry is a type error here, so adding an op
 * to the `PanelRpcRequest` union without its result fails the build
 * (rather than silently degrading `PanelRpcResultFor` to an index error
 * only at some unrelated call site).
 */
export type PanelRpcResultsCoverage = { [K in PanelRpcOp]: PanelRpcResults[K] };

// ── Wire envelopes ──────────────────────────────────────────────────

interface PanelRpcRequestMsg {
  type: 'panel-rpc-request';
  id: string;
  op: PanelRpcOp;
  payload: unknown;
}

interface PanelRpcResponseMsg {
  type: 'panel-rpc-response';
  id: string;
  result?: unknown;
  error?: string;
}

/** Payload of a `remote-cdp-event` push (page → worker). */
export interface RemoteCdpEventPayload {
  runtimeId: string;
  localTargetId: string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Page → worker push envelope, distinct from the request/response
 * envelopes. Relays CDP events fired on a page-side `RemoteCDPTransport`
 * back to the worker-side `PanelRpcCdpTransport` that subscribed. Posted
 * on the same instance-scoped channel; the worker client routes it to a
 * registered push target keyed by `runtimeId:localTargetId`.
 */
export interface PanelRpcPushMsg {
  type: 'panel-rpc-push';
  op: 'remote-cdp-event';
  payload: RemoteCdpEventPayload;
}

// ── Worker-side client ──────────────────────────────────────────────

export interface PanelRpcClient {
  call<O extends PanelRpcOp>(
    op: O,
    payload: PanelRpcPayloadFor<O>,
    opts?: { timeoutMs?: number }
  ): Promise<PanelRpcResultFor<O>>;
  /**
   * Register a handler for `remote-cdp-event` pushes targeting a
   * composite key (`runtimeId:localTargetId`). Used by
   * `PanelRpcCdpTransport` to receive page-pushed CDP events. No-op
   * when `BroadcastChannel` is unavailable.
   */
  registerPushTarget(key: string, handler: (payload: RemoteCdpEventPayload) => void): void;
  /** Drop a previously registered push handler. */
  unregisterPushTarget(key: string): void;
  /** Close the BroadcastChannel and reject any in-flight requests. */
  dispose(): void;
}

/**
 * Build the worker-side proxy. Returns a `call(op, payload)` helper
 * and a `dispose()`. The client may be constructed in environments
 * without `BroadcastChannel` (older test runners, isolated test
 * harnesses); in that case every call rejects with a clear "bridge
 * unavailable" error.
 */
export function createPanelRpcClient(options: { instanceId?: string } = {}): PanelRpcClient {
  if (typeof BroadcastChannel !== 'function') {
    return {
      call: () => Promise.reject(new Error('panel-rpc: BroadcastChannel is unavailable')),
      registerPushTarget: () => {},
      unregisterPushTarget: () => {},
      dispose: () => {},
    };
  }

  const channelName = panelRpcChannelName(options.instanceId);
  const channel = new BroadcastChannel(channelName);
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const pushTargets = new Map<string, (payload: RemoteCdpEventPayload) => void>();

  channel.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as PanelRpcResponseMsg | PanelRpcPushMsg | undefined;
    if (msg?.type === 'panel-rpc-push') {
      if (msg.op === 'remote-cdp-event') {
        const p = msg.payload;
        pushTargets.get(`${p.runtimeId}:${p.localTargetId}`)?.(p);
      }
      return;
    }
    if (msg?.type !== 'panel-rpc-response') return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (typeof msg.error === 'string') slot.reject(new Error(msg.error));
    else slot.resolve(msg.result);
  });

  function call<O extends PanelRpcOp>(
    op: O,
    payload: PanelRpcPayloadFor<O>,
    opts: { timeoutMs?: number } = {}
  ): Promise<PanelRpcResultFor<O>> {
    const id = newRequestId();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<PanelRpcResultFor<O>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`panel-rpc: op '${op}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      const req: PanelRpcRequestMsg = { type: 'panel-rpc-request', id, op, payload };
      channel.postMessage(req);
    });
  }

  function registerPushTarget(
    key: string,
    handler: (payload: RemoteCdpEventPayload) => void
  ): void {
    pushTargets.set(key, handler);
  }

  function unregisterPushTarget(key: string): void {
    pushTargets.delete(key);
  }

  function dispose(): void {
    for (const [, slot] of pending) {
      clearTimeout(slot.timer);
      slot.reject(new Error('panel-rpc: client disposed'));
    }
    pending.clear();
    pushTargets.clear();
    try {
      channel.close();
    } catch {
      /* noop */
    }
  }

  return { call, registerPushTarget, unregisterPushTarget, dispose };
}

// ── Page-side handler ───────────────────────────────────────────────

export type PanelRpcHandlers = {
  [O in PanelRpcOp]?: (
    payload: PanelRpcPayloadFor<O>
  ) => Promise<PanelRpcResultFor<O>> | PanelRpcResultFor<O>;
};

/**
 * Install a page-side handler that listens for `panel-rpc-request`
 * messages on the bridge channel and dispatches them. Unknown ops are
 * answered with an error so the worker's `call` rejects cleanly
 * instead of hanging until the timeout. Errors raised inside a handler
 * are forwarded as `error` strings on the response.
 *
 * Returns a disposer that removes the listener and closes the channel.
 */
export function installPanelRpcHandler(options: {
  handlers: PanelRpcHandlers;
  instanceId?: string;
}): () => void {
  if (typeof BroadcastChannel !== 'function') return () => {};
  const channel = new BroadcastChannel(panelRpcChannelName(options.instanceId));

  const respond = (id: string, result?: unknown, error?: string): void => {
    const msg: PanelRpcResponseMsg = { type: 'panel-rpc-response', id };
    if (error !== undefined) msg.error = error;
    else msg.result = result;
    try {
      channel.postMessage(msg);
    } catch (err) {
      // Posting can fail if the channel was closed while we were
      // resolving — there's no useful recovery beyond logging.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`panel-rpc: failed to post response for id=${id}: ${reason}`);
    }
  };

  const listener = async (event: MessageEvent): Promise<void> => {
    const msg = event.data as PanelRpcRequestMsg | undefined;
    if (msg?.type !== 'panel-rpc-request') return;
    const handler = (options.handlers as Record<string, ((p: unknown) => unknown) | undefined>)[
      msg.op
    ];
    if (!handler) {
      respond(msg.id, undefined, `panel-rpc: no handler for op '${msg.op}'`);
      return;
    }
    try {
      const result = await handler(msg.payload);
      respond(msg.id, result);
    } catch (err) {
      respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
    }
  };

  channel.addEventListener('message', listener as (ev: MessageEvent) => void);

  return () => {
    channel.removeEventListener('message', listener as (ev: MessageEvent) => void);
    try {
      channel.close();
    } catch {
      /* noop */
    }
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `prpc-${crypto.randomUUID()}`;
  }
  return `prpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ── Worker-shell consumer helper ────────────────────────────────────

/**
 * Returns the bridge client published on `globalThis.__slicc_panelRpc`
 * by `kernel-worker.ts`, or null when the current realm has a real
 * DOM and should run DOM operations directly. Commands use this to
 * pick between local-DOM and bridged execution.
 */
export function getPanelRpcClient(): PanelRpcClient | null {
  const g = globalThis as unknown as { __slicc_panelRpc?: PanelRpcClient };
  return g.__slicc_panelRpc ?? null;
}

/**
 * `true` when the current realm has a real DOM. False inside a
 * DedicatedWorker, irrespective of whether the bridge client is
 * published.
 */
export function hasLocalDom(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}
