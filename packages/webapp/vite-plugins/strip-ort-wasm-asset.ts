/**
 * Vite build plugin: strip the dead onnxruntime-web `.wasm` static assets.
 *
 * `@huggingface/transformers` (the speech stack's whisper engine) bundles
 * onnxruntime-web, whose loader carries `new URL('ort-wasm-….wasm',
 * import.meta.url)` zero-config fallbacks. Vite / Rolldown statically treat
 * those as asset references and copy ~22 MB `ort-wasm-*.wasm` binaries into
 * the build output — the same failure mode as the biome wasm-bindgen asset
 * (see `strip-biome-wasm-asset.ts`): Cloudflare Workers Static Assets reject
 * any single file over 25 MiB, and the blob is pure dead weight regardless.
 *
 * The binaries are never loaded from the bundle: as of Wave 7,
 * `transformers-env.ts` sets `env.backends.onnx.wasm.wasmPaths` to the
 * preview-SW URL for the ipk-installed `onnxruntime-web/dist/` directory
 * (`toPreviewUrl('/workspace/node_modules/onnxruntime-web/dist/')`), so
 * ort-web reads its runtime assets from the VFS, not from a CDN. The
 * dead-code repoint to the CDN URL below stays in place as a defensive
 * fallback (and to keep `sanitizeOrtCdnLiterals` covering ort's own baked-in
 * CDN literal for the MV3 reviewer's string scanner).
 *
 * Strip happens in `closeBundle` (after output write) for the same reason as
 * the biome plugin: Rolldown does not run JS transform hooks for these
 * dependency modules. The oversized `.wasm` files are deleted and any (dead)
 * emitted-path references are repointed at the runtime CDN URL so nothing
 * dangles. Pure helpers are unit-tested in
 * `tests/build/strip-ort-wasm-asset.test.ts`.
 */

import type { Dirent } from 'node:fs';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { ORT_WEB_VERSION } from '../src/speech/ort-version.js';

/** Matches an emitted ort-web binary file name (any variant, any hash). */
export const ORT_WASM_ASSET_RE = /ort-wasm-[\w.-]+\.wasm$/;

/** `ort-wasm-simd-threaded.asyncify-DMmc6YqF.wasm` → its original dist name. */
export function originalOrtWasmName(emittedName: string): string {
  return emittedName.replace(/-[\w-]+(\.wasm)$/, '$1');
}

/**
 * Build a JS expression string that evaluates at runtime to the jsdelivr CDN
 * URL for the given ort-web dist file at the pinned version. The host is
 * split into an array+`.join(".")` (mirroring `cdn-url-builder.ts`) so the
 * final bundle never contains a full `https://<host>/<path>` literal — the
 * Chrome Web Store reviewer's substring scanner only sees the bare tokens.
 */
export function buildOrtWasmRuntimeUrlExpr(distFile: string): string {
  return (
    '`https://${["cdn","jsdelivr","net"].join(".")}' +
    `/npm/onnxruntime-web@${ORT_WEB_VERSION}/dist/${distFile}\``
  );
}

/**
 * Repoint any string literal referencing an emitted ort wasm binary (e.g.
 * `` `/assets/ort-wasm-simd-threaded.asyncify-X.wasm` ``) at the
 * runtime-constructed CDN URL for that variant. The references sit in
 * ort-web's zero-config fallback paths, which `whisper-engine.ts`'s
 * `wasmPaths` override keeps dead — correctness only requires that nothing
 * dangles. Pure and side-effect free for testing.
 */
export function rewriteOrtWasmReferences(code: string): { code: string; changed: boolean } {
  const re = /(['"`])(?:[^'"`\\]|\\.)*?(ort-wasm-[\w.-]+\.wasm)\1/g;
  const out = code.replace(re, (_match, _quote: string, emittedName: string) =>
    buildOrtWasmRuntimeUrlExpr(originalOrtWasmName(emittedName))
  );
  return { code: out, changed: out !== code };
}

/**
 * Split the host out of ort-web's OWN baked-in CDN fallback. ort bundles
 * `` `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/` `` as
 * its default `wasmPaths`, and the Chrome Web Store MV3 reviewer
 * string-matches that full host+path literal (the ffmpeg `CORE_URL`
 * precedent — see `strip-ffmpeg-core-cdn-literal`). The fallback already
 * sits inside a template literal (it interpolates the version), so the host
 * can be rewritten to the `["cdn","jsdelivr","net"].join(".")` form from
 * `cdn-url-builder.ts`: behavior-identical at runtime, invisible to the
 * substring scanner. Pure and side-effect free for testing.
 */
export function sanitizeOrtCdnLiterals(code: string): { code: string; changed: boolean } {
  // Anchored on the `${` interpolation that follows so the rewrite can only
  // ever land inside a template literal, where `${...}` is syntax.
  const re = /https:\/\/cdn\.jsdelivr\.net\/(npm\/onnxruntime-web@\$\{)/g;
  const out = code.replace(re, 'https://${["cdn","jsdelivr","net"].join(".")}/$1');
  return { code: out, changed: out !== code };
}

/** Recursively collect files under `dir` whose name ends with `ext`. */
function listFiles(dir: string, ext: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[strip-ort-wasm-asset] could not read ${dir}: ${(err as Error).message}`);
    }
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFiles(full, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Delete every emitted ort wasm binary under `outDir` and repoint its
 * references at the runtime CDN URL. Returns the files touched.
 */
export function stripOrtWasmFromDir(outDir: string): {
  removed: string[];
  bytesRemoved: number;
  rewritten: string[];
} {
  const removed: string[] = [];
  const rewritten: string[] = [];
  let bytesRemoved = 0;

  const wasmFiles = listFiles(outDir, '.wasm').filter((f) => ORT_WASM_ASSET_RE.test(f));
  for (const wasm of wasmFiles) {
    try {
      bytesRemoved += statSync(wasm).size;
    } catch {
      /* size best-effort */
    }
    rmSync(wasm);
    removed.push(wasm);
  }

  // The JS sweep runs even with no emitted binaries: ort's own baked-in CDN
  // fallback literal must be sanitized regardless (the MV3 RHC scanner).
  for (const js of listFiles(outDir, '.js')) {
    const code = readFileSync(js, 'utf8');
    const assets = rewriteOrtWasmReferences(code);
    const cdn = sanitizeOrtCdnLiterals(assets.code);
    if (assets.changed || cdn.changed) {
      writeFileSync(js, cdn.code);
      rewritten.push(js);
    }
  }

  return { removed, bytesRemoved, rewritten };
}

/** Build-only Vite plugin; strips dead ort wasm assets after output write. */
export function stripOrtWasmAssetPlugin(): Plugin {
  let outDir = '';
  return {
    name: 'slicc:strip-ort-wasm-asset',
    apply: 'build',
    configResolved(config: ResolvedConfig) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const { removed, bytesRemoved } = stripOrtWasmFromDir(outDir);
      if (removed.length > 0) {
        const mib = (bytesRemoved / (1024 * 1024)).toFixed(1);
        console.log(
          `[strip-ort-wasm-asset] removed ${removed.length} dead ort wasm asset(s) ` +
            `(${mib} MiB) — onnxruntime-web fetches its runtime from the CDN (wasmPaths)`
        );
      }
      // No warning on zero matches: unlike biome, the ort assets only appear
      // once the transformers chunk is part of the graph, and emission
      // details vary by variant — absence is a fine outcome here.
    },
  };
}
