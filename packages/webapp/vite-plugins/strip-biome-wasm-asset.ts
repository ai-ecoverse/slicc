/**
 * Vite build plugin: strip the dead `biome_wasm_bg.wasm` static asset.
 *
 * `@biomejs/wasm-web/biome_wasm.js` carries wasm-bindgen's zero-config init
 * fallback `new URL('biome_wasm_bg.wasm', import.meta.url)`. Vite / Rolldown
 * statically treat `new URL(<literal>, import.meta.url)` as an asset
 * reference and copy the ~33 MB `biome_wasm_bg.wasm` binary into the build
 * output. (The `wasm-nodejs` sibling that the browser graph also pulls in
 * references its binary via a `${__dirname}/...` template, which Vite does
 * not emit, so only the `wasm-web` asset needs stripping — a build emits
 * exactly one.) Cloudflare Workers Static Assets reject any single file over
 * 25 MiB, so that emitted blob fails the `wrangler deploy` / `--dry-run`
 * that ships `dist/ui/` — the break this plugin fixes.
 *
 * The binary is never loaded: `biome-runtime.ts` always hands wasm-bindgen
 * a precompiled `WebAssembly.Module` it fetched from the versioned unpkg
 * CDN, so the `module_or_path === undefined` fallback is dead code in every
 * float. The bundled asset is pure dead weight.
 *
 * We do the strip in `closeBundle` rather than a module `transform`:
 * Rolldown (vite >=8) processes dependency modules natively and does not
 * invoke JS `transform` / `load` / `generateBundle` hooks for them in this
 * build, and the asset is emitted through Vite's own pipeline (not the
 * rollup `bundle` map). `closeBundle` runs after the output is written, so
 * it is the one place we can reliably see and edit the emitted files. We
 * delete the oversized `.wasm` and repoint the (dead) reference at the same
 * versioned CDN URL the runtime fetches, so nothing dangles.
 *
 * Kept out of `packages/webapp/src/` on purpose — this is build tooling,
 * not part of the browser bundle. The pure helpers are unit-tested in
 * `tests/build/strip-biome-wasm-asset.test.ts`.
 */

import type { Dirent } from 'node:fs';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// Read the version the same way biome-runtime.ts does. A JSON import keeps
// this build-only module free of `node:module` (which the webapp vitest
// project aliases to a browser stub).
import wasmWebPkg from '@biomejs/wasm-web/package.json' with { type: 'json' };
import type { Plugin, ResolvedConfig } from 'vite';

/** Matches the emitted wasm-bindgen binary file name (any content hash). */
export const BIOME_WASM_ASSET_RE = /biome_wasm_bg-[\w-]+\.wasm$/;

/**
 * Resolve the unpkg CDN URL for the installed `@biomejs/wasm-web` version,
 * matching the URL `biome-runtime.ts` fetches at runtime.
 */
export function resolveBiomeWasmCdnUrl(): string {
  const { version } = wasmWebPkg as { version: string };
  return `https://unpkg.com/@biomejs/wasm-web@${version}/biome_wasm_bg.wasm`;
}

/**
 * Repoint any string literal that references the emitted biome wasm binary
 * at the CDN URL. Matches a `'…'`, `"…"`, or `` `…` `` literal whose text
 * ends in `biome_wasm_bg-<hash>.wasm` (e.g. `` `/assets/biome_wasm_bg-X.wasm` ``)
 * and replaces the whole literal with a backtick CDN string. The reference
 * sits in dead code (`module_or_path === undefined`), so correctness only
 * requires that nothing dangles. Pure and side-effect free for testing.
 */
export function rewriteBiomeWasmReference(
  code: string,
  cdnUrl: string
): { code: string; changed: boolean } {
  const re = /(['"`])(?:[^'"`\\]|\\.)*?biome_wasm_bg-[\w-]+\.wasm\1/g;
  const out = code.replace(re, () => `\`${cdnUrl}\``);
  return { code: out, changed: out !== code };
}

/** Recursively collect files under `dir` whose name ends with `ext`. */
function listFiles(dir: string, ext: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A missing dir is expected (outDir may not exist yet); anything else
    // (EACCES, ELOOP, descriptor exhaustion) shouldn't be silently treated
    // as "empty" — surface it so a skipped subtree has a visible cause.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[strip-biome-wasm-asset] could not read ${dir}: ${(err as Error).message}`);
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
 * Delete every emitted biome wasm binary under `outDir` and repoint its
 * references to `cdnUrl`. Returns the files touched (for logging/tests).
 */
export function stripBiomeWasmFromDir(
  outDir: string,
  cdnUrl: string
): { removed: string[]; bytesRemoved: number; rewritten: string[] } {
  const removed: string[] = [];
  const rewritten: string[] = [];
  let bytesRemoved = 0;

  const wasmFiles = listFiles(outDir, '.wasm').filter((f) => BIOME_WASM_ASSET_RE.test(f));
  if (wasmFiles.length === 0) {
    return { removed, bytesRemoved, rewritten };
  }

  for (const wasm of wasmFiles) {
    try {
      bytesRemoved += statSync(wasm).size;
    } catch {
      /* size best-effort */
    }
    rmSync(wasm);
    removed.push(wasm);
  }

  for (const js of listFiles(outDir, '.js')) {
    const code = readFileSync(js, 'utf8');
    const { code: out, changed } = rewriteBiomeWasmReference(code, cdnUrl);
    if (changed) {
      writeFileSync(js, out);
      rewritten.push(js);
    }
  }

  return { removed, bytesRemoved, rewritten };
}

/** Build-only Vite plugin; strips the dead biome wasm after output write. */
export function stripBiomeWasmAssetPlugin(): Plugin {
  const cdnUrl = resolveBiomeWasmCdnUrl();
  let outDir = '';
  return {
    name: 'slicc:strip-biome-wasm-asset',
    apply: 'build',
    configResolved(config: ResolvedConfig) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const { removed, bytesRemoved } = stripBiomeWasmFromDir(outDir, cdnUrl);
      if (removed.length > 0) {
        const mib = (bytesRemoved / (1024 * 1024)).toFixed(1);
        console.log(
          `[strip-biome-wasm-asset] removed ${removed.length} dead biome wasm asset(s) ` +
            `(${mib} MiB) — biome fetches the binary from the CDN at runtime`
        );
      } else {
        // Not fatal — a future Vite/biome version may stop emitting the
        // asset. But it usually means BIOME_WASM_ASSET_RE drifted; surface a
        // breadcrumb so the worker asset-size CI gate failure has an obvious
        // root cause instead of a bare Cloudflare "Asset too large".
        console.warn(
          '[strip-biome-wasm-asset] no biome wasm asset matched in ' +
            `${outDir} — if the worker asset-size gate fails, BIOME_WASM_ASSET_RE likely needs updating`
        );
      }
    },
  };
}
