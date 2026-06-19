/**
 * Lazy whisper-tiny loader — the enhanced speech-recognition engine behind
 * push-to-talk and the `hear` command.
 *
 * Mirrors the `ffmpeg-wasm.ts` pattern for heavy on-demand artifacts: nothing
 * is bundled. The first call dynamically imports `@huggingface/transformers`
 * (its own Vite chunk) and reads the `onnx-community/whisper-tiny` model
 * files (~150 MB fp32 on WebGPU, a q8 subset on WASM) from the VFS at
 * `/workspace/models/onnx-community/whisper-tiny/` (Wave 7 swap — no
 * Hugging Face CDN). `configureTransformersEnv` pins `allowRemoteModels =
 * false` + `localModelPath` to the VFS preview URL, so weights must be
 * staged via the `hf download` shell command (`hf download
 * onnx-community/whisper-tiny --to /workspace/models/onnx-community/whisper-tiny`)
 * before the first call.
 *
 * Progress: per-file `progress_callback` events are folded by
 * `createDownloadTracker` into one loaded/total/ETA snapshot, which feeds the
 * composer's "better speech recognition downloading · ready in ~ETA" line and
 * `hear --status`. With local-only weights the snapshot mostly reflects the
 * preview-SW read pass (initial decode + cache warm).
 *
 * Device: WebGPU when the browser exposes it, with one automatic retry on
 * plain WASM when the WebGPU path fails to initialize (driver/adapter
 * issues are common enough that the fallback is mandatory, not best-effort).
 */

import { createLogger } from '../core/logger.js';
import { createDownloadTracker, type DownloadSnapshot } from './download-progress.js';
import { configureTransformersEnv } from './transformers-env.js';

const log = createLogger('speech:whisper');

/** The model the enhanced engine runs (https://ttslab.dev/models/whisper-tiny). */
export const WHISPER_MODEL_ID = 'onnx-community/whisper-tiny';

export type WhisperProgress = (snapshot: DownloadSnapshot) => void;

/** The loaded engine: 16 kHz mono Float32 PCM in, transcript out. */
export interface WhisperAsr {
  transcribe(audio: Float32Array, opts?: { language?: string }): Promise<string>;
}

export type WhisperLoadState = 'idle' | 'loading' | 'ready' | 'failed';

let whisperPromise: Promise<WhisperAsr> | null = null;
let loadState: WhisperLoadState = 'idle';
let lastSnapshot: DownloadSnapshot | null = null;
const progressSubs = new Set<WhisperProgress>();

/** Where the enhanced engine is in its lifecycle (sync, render-friendly). */
export function whisperLoadState(): WhisperLoadState {
  return loadState;
}

/** The latest aggregated download snapshot (null before the first sample). */
export function whisperDownloadSnapshot(): DownloadSnapshot | null {
  return lastSnapshot;
}

/**
 * Public entry point. Idempotent — concurrent and repeated callers share one
 * load; the resolved engine is shared for the lifetime of the realm. A failed
 * load resets so a later call can retry from scratch.
 */
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

/**
 * Stage 2 of the model chain: once speech RECOGNITION is on device, fetch the
 * kokoro speech-SYNTHESIS model in the background so spoken input can get
 * spoken replies (and `say` upgrades). Fire-and-forget — a kokoro failure
 * never affects whisper's readiness.
 */
function chainKokoroWarmup(): void {
  void import('./kokoro-engine.js')
    .then(({ getKokoro }) => getKokoro())
    .catch((err) => log.warn('kokoro warmup (chained after whisper) failed', err));
}

type AsrPipeline = (
  audio: Float32Array,
  opts: Record<string, unknown>
) => Promise<{ text?: string } | Array<{ text?: string }>>;

async function loadWhisper(): Promise<WhisperAsr> {
  const { pipeline, env } = await import('@huggingface/transformers');
  configureTransformersEnv(env as never);

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
      // WebGPU runs the full-precision weights; WASM takes the quantized
      // set so CPU-only machines stay responsive.
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
      const out = await asr(audio, {
        // Long inputs (hear -i on a recording) chunk transparently; PTT
        // utterances fit one window.
        chunk_length_s: 30,
        task: 'transcribe',
        ...(opts?.language ? { language: opts.language } : {}),
      });
      const text = Array.isArray(out) ? out.map((o) => o.text ?? '').join(' ') : (out.text ?? '');
      return text.trim();
    },
  };
}

/**
 * Drop the cached engine promise + state so the next `getWhisper` call
 * rebuilds from scratch. Test-only.
 */
export function resetWhisperForTests(): void {
  whisperPromise = null;
  loadState = 'idle';
  lastSnapshot = null;
  progressSubs.clear();
}
