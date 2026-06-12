/**
 * The onnxruntime-web version whose runtime assets (wasm + JSEP loader) the
 * speech stack fetches from the CDN. MUST track the exact version
 * `@huggingface/transformers` depends on (see its package.json) — a mismatch
 * surfaces as cryptic "failed to load wasm" errors at first use, not at
 * build time. Single source of truth for both the runtime loader
 * (`whisper-engine.ts`) and the build-side dead-asset strip
 * (`vite-plugins/strip-ort-wasm-asset.ts`).
 */
export const ORT_WEB_VERSION = '1.26.0-dev.20260416-b7804b056c';
