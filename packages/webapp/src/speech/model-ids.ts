/**
 * On-device speech model ids — the ONLY thing `ensure-speech-assets.ts` needs
 * from the engines.
 *
 * The ids live here, not in `whisper-engine.ts` / `kokoro-engine.ts`, because
 * the asset-staging routine runs in the **kernel worker** while the engines
 * only ever run in the **page realm** (they need Web Audio / the DOM). A
 * static `import { KOKORO_MODEL_ID } from './kokoro-engine.js'` for a string
 * constant pulled both engines — and, through their dynamic imports, the
 * `kokoro-js` + `@huggingface/transformers` chunks (~1.8 MB) — into the
 * worker's build graph, where nothing can ever execute them. Vite builds the
 * worker separately from the page, so those bytes were a second, unreachable
 * copy of chunks the page graph already ships.
 *
 * Keep this module dependency-free: anything imported here lands in the worker
 * bundle again.
 */

/** Whisper ASR weights repo (`whisper-engine.ts`). */
export const WHISPER_MODEL_ID = 'onnx-community/whisper-tiny';

/** Kokoro TTS weights repo (`kokoro-engine.ts`). */
export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
