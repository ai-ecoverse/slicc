/**
 * Speech-assets bridge: a typed page→worker BroadcastChannel that lets the
 * page realm (e.g. the composer push-to-talk warmup, R11) invoke the
 * kernel-worker `ensureSpeechAssetsStaged` routine and stream coarse progress
 * back.
 *
 * ## Why a dedicated channel (not the panel-RPC op surface)
 *
 * `kernel/panel-rpc.ts` runs worker→page: the worker is the request *client*
 * and the page is the *responder*. This op runs the other way — the page asks
 * the worker (which owns the VFS + proxied `SecureFetch`) to do the staging.
 * Reusing the panel-RPC channel would collide: the worker already holds a
 * panel-RPC client on that channel, and a same-realm worker responder would
 * also receive the worker's own worker→page requests (BroadcastChannel
 * delivers to every *other* instance in a realm), double-answering them. So
 * the page→worker direction gets its own instance-scoped channel.
 *
 * Mirrors the panel-RPC envelope shape (UUID request ids, instance-scoped
 * name). The page caller uses an *idle* timeout that resets on every progress
 * message, so a long-but-progressing model download (kokoro weights are
 * hundreds of MB) never times out while a genuinely hung worker still does.
 * The extension float doesn't use this bridge — its offscreen agent has a DOM
 * and stages speech assets directly under `host_permissions`.
 */

import type { SpeechAssetProgress, SpeechAssetProgressFn } from '../speech/ensure-speech-assets.js';

const SPEECH_ASSETS_CHANNEL = 'slicc-speech-assets';
/** Default page-side idle timeout — rejected if no progress for this long. */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
/** Public alias of the default idle timeout. */
export const SPEECH_ASSETS_DEFAULT_IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MS;

export function speechAssetsChannelName(instanceId?: string): string {
  return instanceId ? `${SPEECH_ASSETS_CHANNEL}:${instanceId}` : SPEECH_ASSETS_CHANNEL;
}

interface RequestMsg {
  type: 'speech-assets-request';
  id: string;
}
interface ProgressMsg {
  type: 'speech-assets-progress';
  id: string;
  progress: SpeechAssetProgress;
}
interface ResponseMsg {
  type: 'speech-assets-response';
  id: string;
  error?: string;
}

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `spa-${crypto.randomUUID()}`;
  }
  return `spa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The worker-side staging entry the responder drives per request. */
export type EnsureSpeechAssetsRunner = (onProgress: SpeechAssetProgressFn) => Promise<unknown>;

/**
 * Install the worker-side responder. Each incoming request runs `ensure`,
 * forwarding every progress event back on the channel, then posts a final
 * response (empty on success, `error` on failure). Returns a disposer. No-op
 * when `BroadcastChannel` is unavailable (older test runners).
 */
export function installSpeechAssetsResponder(options: {
  instanceId?: string;
  ensure: EnsureSpeechAssetsRunner;
}): () => void {
  if (typeof BroadcastChannel !== 'function') return () => {};
  const channel = new BroadcastChannel(speechAssetsChannelName(options.instanceId));

  const post = (msg: ProgressMsg | ResponseMsg): void => {
    try {
      channel.postMessage(msg);
    } catch (err) {
      console.warn(
        'speech-assets: failed to post message:',
        err instanceof Error ? err.message : String(err)
      );
    }
  };

  const listener = async (event: MessageEvent): Promise<void> => {
    const msg = event.data as RequestMsg | undefined;
    if (msg?.type !== 'speech-assets-request') return;
    const { id } = msg;
    try {
      await options.ensure((progress) => post({ type: 'speech-assets-progress', id, progress }));
      post({ type: 'speech-assets-response', id });
    } catch (err) {
      post({
        type: 'speech-assets-response',
        id,
        error: err instanceof Error ? err.message : String(err),
      });
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

/**
 * Page-side caller. Posts a request, forwards progress to `onProgress`, and
 * resolves when the worker reports completion (rejects on worker error or
 * after `idleTimeoutMs` with no progress). Rejects immediately when
 * `BroadcastChannel` is unavailable.
 */
export function callEnsureSpeechAssets(options: {
  instanceId?: string;
  onProgress?: SpeechAssetProgressFn;
  idleTimeoutMs?: number;
}): Promise<void> {
  if (typeof BroadcastChannel !== 'function') {
    return Promise.reject(new Error('speech-assets: BroadcastChannel is unavailable'));
  }
  const channel = new BroadcastChannel(speechAssetsChannelName(options.instanceId));
  const id = newRequestId();
  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      settled = true;
      clearTimeout(timer);
      channel.removeEventListener('message', listener as (ev: MessageEvent) => void);
      try {
        channel.close();
      } catch {
        /* noop */
      }
    };
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error(`speech-assets: no progress for ${idleMs}ms (worker unreachable?)`));
      }, idleMs);
    };
    const listener = (event: MessageEvent): void => {
      const msg = event.data as ProgressMsg | ResponseMsg | undefined;
      if (!msg || msg.id !== id || settled) return;
      if (msg.type === 'speech-assets-progress') {
        arm();
        options.onProgress?.(msg.progress);
        return;
      }
      if (msg.type === 'speech-assets-response') {
        cleanup();
        if (typeof msg.error === 'string') reject(new Error(msg.error));
        else resolve();
      }
    };
    channel.addEventListener('message', listener as (ev: MessageEvent) => void);
    arm();
    channel.postMessage({ type: 'speech-assets-request', id } satisfies RequestMsg);
  });
}
