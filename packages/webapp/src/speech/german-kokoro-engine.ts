/**
 * Lazy German on-device Kokoro engine — issue #1171.
 *
 * The community model `Godelaune/Kokoro-82M-ONNX-German-Martin` is a bare
 * Kokoro checkpoint (`kokoro-martin.onnx` + `voices-martin.npz`, single voice
 * `martin`) with NO HF `tokenizer.json` / `config.json`, so it cannot ride the
 * `kokoro-js` path the English/multilingual voices use. Instead we drive
 * `onnxruntime-web` DIRECTLY: dynamic-import the SAME ort module the base
 * kokoro/whisper path uses (a real Vite chunk, so its wasm glue resolves
 * against a valid `import.meta.url` instead of a base-less blob URL) and point
 * `env.wasm.wasmPaths` at the VFS-staged dist via `ensureOrtWasmPaths()` —
 * exactly the blob-URL map `configureTransformersEnv` wires for the English
 * engine. We then parse the `.npz` style matrix ourselves (`npz.ts`),
 * phonemize via the shared espeak seam (`phonemizeForKokoro(text,'de',…)`),
 * tokenize against the canonical Kokoro vocab (`kokoro-vocab.ts`), and build
 * the `{input_ids, style, speed}` feeds the Kokoro ONNX graph declares —
 * yielding the `waveform` output @ 24 kHz.
 *
 * OPT-IN: ~325 MB, NOT added to the auto-staged speech warmup. The user runs
 * `hf download Godelaune/Kokoro-82M-ONNX-German-Martin` first; `say --list`
 * surfaces the voice only once the weights are present.
 *
 * Standalone / hosted-leader only. The extension float (MV3 CSP) degrades to
 * Web Speech exactly like the other non-English languages (see `speak.ts`
 * routing), so it never reaches this ort path.
 */

import { createLogger } from '../core/logger.js';
import { getEspeakPhonemize } from './espeak-phonemizer.js';
import type { KokoroAudioChunk, KokoroLoadState, KokoroVoiceInfo } from './kokoro-engine.js';
import { type EspeakPhonemize, phonemizeForKokoro } from './kokoro-phonemize.js';
import { tokenizeKokoroPhonemes } from './kokoro-vocab.js';
import { parseSingleEntryNpz } from './npz.js';
import { ensureOrtWasmPaths, LOCAL_MODELS_VFS_PATH } from './transformers-env.js';

const log = createLogger('speech:kokoro-de');

/** The opt-in German on-device model repo (under `/workspace/models/`). */
export const GERMAN_KOKORO_MODEL_ID = 'Godelaune/Kokoro-82M-ONNX-German-Martin';
/** The ONNX graph file the repo ships (note: NOT the kokoro-js `model.onnx`). */
export const GERMAN_KOKORO_MODEL_FILE = 'kokoro-martin.onnx';
/** The single-entry `.npz` carrying the `martin` style matrix. */
export const GERMAN_KOKORO_VOICES_FILE = 'voices-martin.npz';
/** espeak-ng voice the German text is phonemized with. */
export const GERMAN_ESPEAK_LANG = 'de';
/** Kokoro audio is mono PCM at 24 kHz. */
export const GERMAN_KOKORO_SAMPLE_RATE = 24000;
/** Kokoro style-vector width (`ref_s`). */
export const KOKORO_STYLE_DIM = 256;

/** The one voice this engine exposes — normalized for `say --list` / pickers. */
export const GERMAN_KOKORO_VOICE: Readonly<KokoroVoiceInfo> = Object.freeze({
  id: 'martin',
  name: 'Martin',
  lang: 'de-DE',
  onDevice: true,
  gender: 'Male',
});

/** A decoded `.npz` style matrix: flat C-order f32 + its row count. */
export interface GermanVoiceMatrix {
  data: Float32Array;
  rows: number;
}

/** Decode the `voices-martin.npz` bytes into the style matrix, validating the
 *  Kokoro `(rows, 1, 256)` layout. Pure (delegates to the npz reader). */
export function parseGermanVoiceMatrix(npzBytes: Uint8Array): GermanVoiceMatrix {
  const { shape, data } = parseSingleEntryNpz(npzBytes);
  const lastDim = shape[shape.length - 1];
  if (lastDim !== KOKORO_STYLE_DIM) {
    throw new Error(`german kokoro voice: expected last dim ${KOKORO_STYLE_DIM}, got ${lastDim}`);
  }
  const rows = shape[0] ?? 0;
  if (rows <= 0 || data.length < rows * KOKORO_STYLE_DIM) {
    throw new Error('german kokoro voice: empty or truncated style matrix');
  }
  return { data, rows };
}

/** The raw ORT feed arrays + dims (pure — Tensor-wrapped by the engine). */
export interface GermanKokoroInputs {
  tokenIds: BigInt64Array;
  tokenDims: [number, number];
  style: Float32Array;
  styleDims: [number, number];
  speed: Float32Array;
  speedDims: [number];
}

/**
 * Build the Kokoro ONNX inputs (pure — unit-tested). Mirrors the canonical
 * kokoro-onnx contract: ids are clamped so the style row index `len(ids)` stays
 * within the matrix (`rows-1` max), the style row at `len(ids)` is sliced out,
 * tokens are bracketed `[0, ...ids, 0]` (pad/BOS/EOS), and speed is a length-1
 * f32 vector.
 */
export function buildGermanKokoroInputs(
  ids: number[],
  voice: GermanVoiceMatrix,
  speed: number
): GermanKokoroInputs {
  const maxIds = Math.max(voice.rows - 1, 0);
  const clamped = ids.length > maxIds ? ids.slice(0, maxIds) : ids;
  const start = clamped.length * KOKORO_STYLE_DIM;
  const style = voice.data.slice(start, start + KOKORO_STYLE_DIM);
  const tokens = [0, ...clamped, 0];
  return {
    tokenIds: BigInt64Array.from(tokens, (n) => BigInt(n)),
    tokenDims: [1, tokens.length],
    style,
    styleDims: [1, KOKORO_STYLE_DIM],
    speed: Float32Array.from([speed]),
    speedDims: [1],
  };
}

/**
 * Split German text into speakable sentences (pure — mirrors the model repo's
 * `split_into_sentences`): break after `.!?` boundaries and on newlines, drop
 * single-character fragments. Keeps a long reply from being clamped to one
 * ~510-token chunk (#1038) — each sentence is tokenized + synthesized alone.
 */
export function splitGermanSentences(text: string): string[] {
  const out: string[] = [];
  for (const segment of text.split(/(?<=[.!?])\s+(?=\S)/)) {
    for (const line of segment.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 1) out.push(trimmed);
    }
  }
  return out;
}

/** Minimal slice of the `onnxruntime-web` ESM surface this engine drives. */
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown } | undefined>>;
}
interface OrtModule {
  InferenceSession: {
    create(model: Uint8Array, opts?: Record<string, unknown>): Promise<OrtSession>;
  };
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => unknown;
  env?: { wasm?: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean } };
}

/** The loaded German engine — text in, mono PCM @ 24 kHz out. */
export interface GermanKokoroTts {
  synthesize(text: string, opts?: { speed?: number }): Promise<KokoroAudioChunk>;
  synthesizeStream(
    text: string,
    opts?: { speed?: number; splitPattern?: RegExp }
  ): AsyncGenerator<KokoroAudioChunk, void, void>;
  voices(): KokoroVoiceInfo[];
}

/** Absolute VFS dir the German model repo is staged into. */
function modelBase(): string {
  return `${LOCAL_MODELS_VFS_PATH}${GERMAN_KOKORO_MODEL_ID}/`;
}

/** True for a genuinely-missing file (the staging pre-step hasn't run). */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && err.message.includes('ENOENT');
}

/** No-ack window: the `preview-vfs` responder posts `preview-vfs-ack` the moment
 *  it receives a read. If none arrives this fast there is no responder in this
 *  realm (kernel-worker boot race, or a non-page test env) — so the staged
 *  probe fails fast (→ Web Speech / not-staged) instead of blocking on the full
 *  read budget. Once acked, the read may take the full budget. */
const PREVIEW_VFS_ACK_TIMEOUT_MS = 2000;
/** Overall read budget after an ack — the model onnx (~80 MB) can stream a while
 *  over the worker RPC, so this matches the transformers-env reader. */
const PREVIEW_VFS_READ_TIMEOUT_MS = 60000;

/** Read VFS bytes via the page-side `preview-vfs` responder (same wire the
 *  espeak + ort-web loads use). Page/offscreen realm only. Fails fast (ENOENT)
 *  when no responder acks within `PREVIEW_VFS_ACK_TIMEOUT_MS`. */
function readVfsBytes(path: string): Promise<Uint8Array> {
  if (typeof BroadcastChannel === 'undefined') {
    return Promise.reject(new Error(`ENOENT: ${path} (BroadcastChannel unavailable)`));
  }
  const channel = new BroadcastChannel('preview-vfs');
  const id = `kokoro-de-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<Uint8Array>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = (cb: () => void): void => {
      clearTimeout(timer);
      channel.removeEventListener('message', listener);
      channel.close();
      cb();
    };
    timer = setTimeout(
      () => done(() => reject(new Error(`ENOENT: ${path} (no preview-vfs responder)`))),
      PREVIEW_VFS_ACK_TIMEOUT_MS
    );
    const listener = (ev: MessageEvent): void => {
      const data = ev.data as { type?: string; id?: string; content?: unknown; error?: string };
      if (data?.id !== id) return;
      if (data.type === 'preview-vfs-ack') {
        // Responder is present — extend the budget for the actual read.
        clearTimeout(timer);
        timer = setTimeout(
          () => done(() => reject(new Error(`ENOENT: ${path} (read timed out)`))),
          PREVIEW_VFS_READ_TIMEOUT_MS
        );
        return;
      }
      if (data.type !== 'preview-vfs-response') return;
      if (typeof data.error === 'string') {
        done(() => reject(new Error(data.error)));
      } else if (data.content instanceof Uint8Array) {
        const c = data.content;
        done(() => resolve(c));
      } else if (typeof data.content === 'string') {
        const c = data.content;
        done(() => resolve(new TextEncoder().encode(c)));
      } else {
        done(() => reject(new Error(`Empty preview-vfs response for ${path}`)));
      }
    };
    channel.addEventListener('message', listener);
    channel.postMessage({ type: 'preview-vfs-read', id, path, asText: false });
  });
}

/** Default ORT loader: dynamic-import the bundled `onnxruntime-web` module
 *  (the SAME ort the base kokoro/whisper path uses) so its wasm glue resolves
 *  against a real `import.meta.url`, then point the wasm runtime at the
 *  VFS-staged dist blob URLs (`ensureOrtWasmPaths` — the same map
 *  `configureTransformersEnv` builds for the English engine). Browser realm. */
async function loadOrtModule(): Promise<OrtModule> {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('onnxruntime-web requires URL.createObjectURL (browser realm only)');
  }
  const mod = (await import('onnxruntime-web')) as unknown as OrtModule;
  const wasmPaths = await ensureOrtWasmPaths();
  if (mod.env?.wasm) mod.env.wasm.wasmPaths = wasmPaths;
  return mod;
}

/** I/O seams — overridable in tests so the ORT run path needs no real wasm. */
interface GermanKokoroDeps {
  readVfs: (path: string) => Promise<Uint8Array>;
  loadOrt: () => Promise<OrtModule>;
  getPhonemize: () => Promise<EspeakPhonemize>;
}
const defaultDeps: GermanKokoroDeps = {
  readVfs: readVfsBytes,
  loadOrt: loadOrtModule,
  getPhonemize: getEspeakPhonemize,
};
let deps: GermanKokoroDeps = defaultDeps;

let enginePromise: Promise<GermanKokoroTts> | null = null;
let loadState: KokoroLoadState = 'idle';
let readyTts: GermanKokoroTts | null = null;
let stagedMemo: Promise<boolean> | null = null;
let voiceCache: GermanVoiceMatrix | null = null;

/** Where the German engine is in its lifecycle (sync, render-friendly). */
export function germanKokoroLoadState(): KokoroLoadState {
  return loadState;
}

/** The loaded engine when ready, else null (sync — for engine picks). */
export function germanKokoroIfReady(): GermanKokoroTts | null {
  return readyTts;
}

/**
 * Whether the German weights are staged (the `voices-martin.npz` entry reads).
 * Memoizes a successful probe (the parsed matrix is cached for the engine
 * load); a missing/failed probe is NOT cached so a later `hf download` is
 * picked up on the next `say --list`.
 */
export async function germanKokoroStaged(): Promise<boolean> {
  if (voiceCache) return true;
  if (!stagedMemo) {
    stagedMemo = (async () => {
      try {
        const npz = await deps.readVfs(`${modelBase()}${GERMAN_KOKORO_VOICES_FILE}`);
        voiceCache = parseGermanVoiceMatrix(npz);
        return true;
      } catch (err) {
        if (!isEnoent(err)) log.warn('german kokoro staged probe failed', err);
        return false;
      }
    })();
  }
  const ok = await stagedMemo;
  if (!ok) stagedMemo = null;
  return ok;
}

async function loadGermanKokoro(): Promise<GermanKokoroTts> {
  const base = modelBase();
  let voice = voiceCache;
  if (!voice) {
    voice = parseGermanVoiceMatrix(await deps.readVfs(`${base}${GERMAN_KOKORO_VOICES_FILE}`));
    voiceCache = voice;
  }
  const resolvedVoice = voice;
  const [ort, modelBytes, phonemize] = await Promise.all([
    deps.loadOrt(),
    deps.readVfs(`${base}${GERMAN_KOKORO_MODEL_FILE}`),
    deps.getPhonemize(),
  ]);
  const wantGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: wantGpu ? ['webgpu', 'wasm'] : ['wasm'],
  });
  const Tensor = ort.Tensor;
  log.info('german kokoro ready', {
    device: wantGpu ? 'webgpu' : 'wasm',
    rows: resolvedVoice.rows,
  });

  const synth = async (text: string, speed: number): Promise<KokoroAudioChunk> => {
    const phonemes = await phonemizeForKokoro(text, GERMAN_ESPEAK_LANG, phonemize);
    const ids = tokenizeKokoroPhonemes(phonemes);
    const inputs = buildGermanKokoroInputs(ids, resolvedVoice, speed);
    const out = await session.run({
      input_ids: new Tensor('int64', inputs.tokenIds, inputs.tokenDims),
      style: new Tensor('float32', inputs.style, inputs.styleDims),
      speed: new Tensor('float32', inputs.speed, inputs.speedDims),
    });
    const waveform = out.waveform?.data as Float32Array | undefined;
    if (!waveform) throw new Error('german kokoro: model produced no waveform output');
    return { audio: waveform, sampleRate: GERMAN_KOKORO_SAMPLE_RATE };
  };

  return {
    synthesize: (text, opts) => synth(text, opts?.speed ?? 1),
    async *synthesizeStream(text, opts) {
      const speed = opts?.speed ?? 1;
      const parts = opts?.splitPattern
        ? text
            .split(opts.splitPattern)
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
        : splitGermanSentences(text);
      const sentences = parts.length > 0 ? parts : [text.trim()].filter((t) => t.length > 0);
      for (const sentence of sentences) {
        yield await synth(sentence, speed);
      }
    },
    voices: () => [{ ...GERMAN_KOKORO_VOICE }],
  };
}

/**
 * Public entry point. Idempotent — concurrent/repeat callers share one load.
 * A failed load resets so a later call can retry. Loads the staged weights
 * lazily (the model is opt-in; nothing warms it automatically).
 */
export function getGermanKokoro(): Promise<GermanKokoroTts> {
  if (!enginePromise) {
    loadState = 'loading';
    enginePromise = loadGermanKokoro().then(
      (tts) => {
        loadState = 'ready';
        readyTts = tts;
        return tts;
      },
      (err) => {
        loadState = 'failed';
        enginePromise = null;
        log.error('german kokoro load failed', err);
        throw err;
      }
    );
  }
  return enginePromise;
}

/** Test seam: override the I/O deps (and reset all cached state). */
export function setGermanKokoroDepsForTests(overrides: Partial<GermanKokoroDeps>): void {
  deps = { ...defaultDeps, ...overrides };
  enginePromise = null;
  loadState = 'idle';
  readyTts = null;
  stagedMemo = null;
  voiceCache = null;
}

/** Test-only: restore the real deps + drop all cached state. */
export function resetGermanKokoroForTests(): void {
  deps = defaultDeps;
  enginePromise = null;
  loadState = 'idle';
  readyTts = null;
  stagedMemo = null;
  voiceCache = null;
}
