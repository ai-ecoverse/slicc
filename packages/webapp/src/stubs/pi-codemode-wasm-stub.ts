/**
 * Browser replacement for pi-codemode's `wasm.js`, which uses
 * `node:fs/promises` and `node:module` to read `quickjs.wasm` from disk.
 *
 * In the browser we fetch and compile the WASM from a CDN URL derived from
 * the installed `quickjs-wasi` version (injected via `define` in vite.config.ts).
 */

declare const __QUICKJS_WASI_VERSION__: string;

export type CodemodeWasmModule = object;

let cached: Promise<CodemodeWasmModule> | undefined;

export function loadQuickJSWasm(): Promise<CodemodeWasmModule> {
  if (cached) return cached;
  const version = typeof __QUICKJS_WASI_VERSION__ === 'string' ? __QUICKJS_WASI_VERSION__ : '3.6.2';
  const url = `https://cdn.jsdelivr.net/npm/quickjs-wasi@${version}/quickjs.wasm`;
  cached = WebAssembly.compileStreaming(fetch(url)).catch((err) => {
    cached = undefined;
    throw err;
  });
  return cached;
}
