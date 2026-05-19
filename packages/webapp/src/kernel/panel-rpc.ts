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

const PANEL_RPC_CHANNEL = 'slicc-panel-rpc';
const DEFAULT_TIMEOUT_MS = 15_000;

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
  | { op: 'enumerate-media-devices'; payload?: undefined };

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
}

export type PanelRpcOp = PanelRpcRequest['op'];
export type PanelRpcPayloadFor<O extends PanelRpcOp> = Extract<
  PanelRpcRequest,
  { op: O }
>['payload'];
export type PanelRpcResultFor<O extends PanelRpcOp> = PanelRpcResults[O];

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

// ── Worker-side client ──────────────────────────────────────────────

export interface PanelRpcClient {
  call<O extends PanelRpcOp>(
    op: O,
    payload: PanelRpcPayloadFor<O>,
    opts?: { timeoutMs?: number }
  ): Promise<PanelRpcResultFor<O>>;
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

  channel.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as PanelRpcResponseMsg | undefined;
    if (!msg || msg.type !== 'panel-rpc-response') return;
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

  function dispose(): void {
    for (const [, slot] of pending) {
      clearTimeout(slot.timer);
      slot.reject(new Error('panel-rpc: client disposed'));
    }
    pending.clear();
    try {
      channel.close();
    } catch {
      /* noop */
    }
  }

  return { call, dispose };
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
    if (!msg || msg.type !== 'panel-rpc-request') return;
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
