import { createLogger } from '../base/logger.js';
import { createDownloadTracker, type DownloadSnapshot } from './download-progress.js';
import { WHISPER_MODEL_ID } from './model-ids.js';
import {
  assertLocalModelPresent,
  configureTransformersEnv,
  ensureOrtWasmPaths,
} from './transformers-env.js';

const log = createLogger('speech:whisper');

export { WHISPER_MODEL_ID };

export type WhisperProgress = (snapshot: DownloadSnapshot) => void;

export interface WhisperAsr {
  transcribe(audio: Float32Array, opts?: { language?: string }): Promise<string>;
}

export type WhisperLoadState = 'idle' | 'loading' | 'ready' | 'failed';

let whisperPromise: Promise<WhisperAsr> | null = null;
let loadState: WhisperLoadState = 'idle';
let lastSnapshot: DownloadSnapshot | null = null;
const progressSubs = new Set<WhisperProgress>();

export function whisperLoadState(): WhisperLoadState {
  return loadState;
}

export function whisperDownloadSnapshot(): DownloadSnapshot | null {
  return lastSnapshot;
}

export function getWhisper(onProgress?: WhisperProgress): Promise<WhisperAsr> {
  if (onProgress) progressSubs.add(onProgress);
  if (!whisperPromise) {
    loadState = 'loading';
    whisperPromise = loadWhisper().then(
      (asr) => {
        loadState = 'ready';
        chainKokoroWarmup();
        return asr;
      },
      (err) => {
        loadState = 'failed';
        whisperPromise = null;
        log.error('whisper load failed', err);
        throw err;
      }
    );
  }
  return whisperPromise;
}

function chainKokoroWarmup(): void {
  void import('./speak.js')
    .then(({ kokoroWarmup }) => kokoroWarmup())
    .catch((err) => log.warn('kokoro warmup (chained after whisper) failed', err));
}

interface AsrCallOptions {
  chunk_length_s: number;
  task: 'transcribe';
  language?: string;
}

type AsrPipeline = (
  audio: Float32Array,
  opts: AsrCallOptions
) => Promise<{ text?: string } | Array<{ text?: string }>>;

async function loadWhisper(): Promise<WhisperAsr> {
  const { pipeline, env } = await import('@huggingface/transformers');
  configureTransformersEnv(env as never);

  await assertLocalModelPresent(WHISPER_MODEL_ID);

  await ensureOrtWasmPaths();

  const tracker = createDownloadTracker();
  const progressCallback = (p: {
    status?: string;
    file?: string;
    loaded?: number;
    total?: number;
  }) => {
    if (!p?.file) return;
    if (p.status === 'progress') tracker.update(p.file, p.loaded ?? 0, p.total ?? 0);
    else if (p.status === 'done') tracker.complete(p.file);
    else return;
    lastSnapshot = tracker.snapshot();
    for (const sub of progressSubs) sub(lastSnapshot);
  };

  const buildPipeline = async (device: 'webgpu' | 'wasm') =>
    (await pipeline('automatic-speech-recognition', WHISPER_MODEL_ID, {
      device,

      dtype: device === 'webgpu' ? 'fp32' : 'q8',
      progress_callback: progressCallback,
    })) as unknown as AsrPipeline;

  const wantGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
  let asr: AsrPipeline;
  if (wantGpu) {
    try {
      asr = await buildPipeline('webgpu');
    } catch (err) {
      log.warn('whisper webgpu init failed; retrying on wasm', err);
      asr = await buildPipeline('wasm');
    }
  } else {
    asr = await buildPipeline('wasm');
  }

  log.info('whisper ready', { model: WHISPER_MODEL_ID, device: wantGpu ? 'webgpu' : 'wasm' });

  return {
    async transcribe(audio, opts) {
      const t0 = performance.now();
      const out = await asr(audio, {
        chunk_length_s: 30,
        task: 'transcribe',
        ...(opts?.language ? { language: opts.language } : {}),
      });
      const text = Array.isArray(out) ? out.map((o) => o.text ?? '').join(' ') : (out.text ?? '');

      log.info('whisper transcribe', {
        elapsedMs: Math.round(performance.now() - t0),
        audioSeconds: Math.round(audio.length / 160) / 100,
        numThreads: env.backends?.onnx?.wasm?.numThreads,
        device: wantGpu ? 'webgpu' : 'wasm',
      });
      return text.trim();
    },
  };
}

export function resetWhisperForTests(): void {
  whisperPromise = null;
  loadState = 'idle';
  lastSnapshot = null;
  progressSubs.clear();
}
