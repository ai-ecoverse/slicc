/**
 * Shared transformers.js environment configuration for the speech engines.
 *
 * The ort-web wasm/JSEP runtime is resolved at run time, not bundle time —
 * point it at the version-matched CDN directory instead of letting the
 * bundler-mangled `import.meta.url` resolution guess (and instead of Vite
 * emitting ~22 MB assets into dist; see `vite-plugins/strip-ort-wasm-asset.ts`).
 *
 * Both whisper (`@huggingface/transformers` directly) and kokoro
 * (`kokoro-js`, deduped onto the same transformers copy by the Vite configs)
 * call this after import — whichever engine loads first wins; the config is
 * idempotent.
 */

import { jsdelivrNpmUrl } from '../shell/supplemental-commands/cdn-url-builder.js';
import { ORT_WEB_VERSION } from './ort-version.js';

/** Structural slice of transformers.js' `env` that we touch. */
export interface TransformersEnvLike {
  backends?: { onnx?: { wasm?: { wasmPaths?: unknown } } };
}

/** Point ort-web's runtime asset resolution at the version-pinned CDN dir. */
export function configureTransformersEnv(env: TransformersEnvLike): void {
  const onnxWasm = env.backends?.onnx?.wasm;
  if (onnxWasm) {
    onnxWasm.wasmPaths = jsdelivrNpmUrl('onnxruntime-web', ORT_WEB_VERSION, 'dist/').toString();
  }
}
