import type { SpeechAssetProgress, SpeechAssetProgressFn } from '../speech/ensure-speech-assets.js';

const SPEECH_ASSETS_CHANNEL = 'slicc-speech-assets';

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

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

export type EnsureSpeechAssetsRunner = (onProgress: SpeechAssetProgressFn) => Promise<unknown>;

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

  let inflight: Set<string> | null = null;

  const settleAll = (error?: string): void => {
    const ids = inflight ?? new Set<string>();
    inflight = null;
    for (const id of ids) {
      post(
        error === undefined
          ? { type: 'speech-assets-response', id }
          : { type: 'speech-assets-response', id, error }
      );
    }
  };

  const listener = (event: MessageEvent): void => {
    const msg = event.data as RequestMsg | undefined;
    if (msg?.type !== 'speech-assets-request') return;
    const { id } = msg;
    if (inflight) {
      inflight.add(id);
      return;
    }
    const subscribers = new Set<string>([id]);
    inflight = subscribers;
    let run: Promise<unknown>;
    try {
      run = options.ensure((progress) => {
        for (const sid of subscribers) post({ type: 'speech-assets-progress', id: sid, progress });
      });
    } catch (err) {
      settleAll(err instanceof Error ? err.message : String(err));
      return;
    }
    void run.then(
      () => settleAll(),
      (err) => settleAll(err instanceof Error ? err.message : String(err))
    );
  };

  channel.addEventListener('message', listener as (ev: MessageEvent) => void);
  return () => {
    channel.removeEventListener('message', listener as (ev: MessageEvent) => void);
    try {
      channel.close();
    } catch {}
  };
}

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
      } catch {}
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
