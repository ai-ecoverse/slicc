/**
 * Vite build plugin: strip the dead `biome_wasm_bg.wasm` static asset.
 *
 * `@biomejs/wasm-web/biome_wasm.js` carries wasm-bindgen's zero-config init
 * fallback `new URL('biome_wasm_bg.wasm', import.meta.url)`. If anything in
 * the bundle still references that wrapper, Vite / Rolldown statically treats
 * `new URL(<literal>, import.meta.url)` as an asset reference and copies the
 * ~33 MB `biome_wasm_bg.wasm` binary into the build output. Cloudflare
 * Workers Static Assets reject any single file over 25 MiB, so that emitted
 * blob fails the `wrangler deploy` / `--dry-run` that ships `dist/ui/` — the
 * break this plugin defends against.
 *
 * The built-in `biome` supplemental command and its `biome-runtime.ts` loader
 * have been removed, so the wasm-web wrapper is no longer reachable from the
 * webapp graph and a normal build should emit nothing matching the pattern.
 * This plugin stays in place as a defensive net: if the asset reappears (a
 * transient or transitively-pulled re-import), it is deleted and any surviving
 * `new URL('…/biome_wasm_bg-<hash>.wasm', …)` literal is neutralized to an
 * empty string so the dead-code fallback can never reach the network.
 *
 * We do the strip in `closeBundle` rather than a module `transform`:
 * Rolldown (vite >=8) processes dependency modules natively and does not
 * invoke JS `transform` / `load` / `generateBundle` hooks for them in this
 * build, and the asset is emitted through Vite's own pipeline (not the
 * rollup `bundle` map). `closeBundle` runs after the output is written, so
 * it is the one place we can reliably see and edit the emitted files.
 *
 * Kept out of `packages/webapp/src/` on purpose — this is build tooling,
 * not part of the browser bundle. The pure helpers are unit-tested in
 * `tests/build/strip-biome-wasm-asset.test.ts`.
 */

import type { Dirent } from 'node:fs';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/** Matches the emitted wasm-bindgen binary file name (any content hash). */
export const BIOME_WASM_ASSET_RE = /biome_wasm_bg-[\w-]+\.wasm$/;

/**
 * Replacement expression for any surviving biome wasm reference. Evaluates to
 * an empty string so the dead-code fallback `new URL('', import.meta.url)`
 * cannot reach the network. Exported so the unit test pins the shape.
 */
export const BIOME_WASM_NEUTRALIZED_EXPR = '""';

/**
 * Replace any string literal that references the emitted biome wasm binary
 * with a neutralized replacement expression. Matches a `'…'`, `"…"`, or
 * `` `…` `` literal whose text ends in `biome_wasm_bg-<hash>.wasm` (e.g.
 * `` `/assets/biome_wasm_bg-X.wasm` ``) and replaces the whole literal with
 * `replacementExpr` — defaults to `BIOME_WASM_NEUTRALIZED_EXPR` (an empty
 * string literal). The reference sits in dead code
 * (`module_or_path === undefined`), so correctness only requires that
 * nothing dangles. Pure and side-effect free for testing.
 */
export function rewriteBiomeWasmReference(
  code: string,
  replacementExpr: string = BIOME_WASM_NEUTRALIZED_EXPR
): { code: string; changed: boolean } {
  const re = /(['"`])(?:[^'"`\\]|\\.)*?biome_wasm_bg-[\w-]+\.wasm\1/g;
  const out = code.replace(re, () => replacementExpr);
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
 * Delete every emitted biome wasm binary under `outDir` and neutralize any
 * surviving references. Returns the files touched (for logging/tests). The
 * optional `replacementExpr` lets tests pin the replacement; production
 * defaults to `BIOME_WASM_NEUTRALIZED_EXPR`.
 */
export function stripBiomeWasmFromDir(
  outDir: string,
  replacementExpr: string = BIOME_WASM_NEUTRALIZED_EXPR
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
    const { code: out, changed } = rewriteBiomeWasmReference(code, replacementExpr);
    if (changed) {
      writeFileSync(js, out);
      rewritten.push(js);
    }
  }

  return { removed, bytesRemoved, rewritten };
}

/** Build-only Vite plugin; strips the dead biome wasm after output write. */
export function stripBiomeWasmAssetPlugin(): Plugin {
  let outDir = '';
  return {
    name: 'slicc:strip-biome-wasm-asset',
    apply: 'build',
    configResolved(config: ResolvedConfig) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const { removed, bytesRemoved } = stripBiomeWasmFromDir(outDir);
      if (removed.length > 0) {
        const mib = (bytesRemoved / (1024 * 1024)).toFixed(1);
        console.log(
          `[strip-biome-wasm-asset] removed ${removed.length} stray biome wasm asset(s) ` +
            `(${mib} MiB) — the built-in biome command is gone; references neutralized`
        );
      }
    },
  };
}
