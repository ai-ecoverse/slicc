import type { Dirent } from 'node:fs';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

export const BIOME_WASM_ASSET_RE = /biome_wasm_bg-[\w-]+\.wasm$/;

export const BIOME_WASM_NEUTRALIZED_EXPR = '""';

export function rewriteBiomeWasmReference(
  code: string,
  replacementExpr: string = BIOME_WASM_NEUTRALIZED_EXPR
): { code: string; changed: boolean } {
  const re = /(['"`])(?:[^'"`\\]|\\.)*?biome_wasm_bg-[\w-]+\.wasm\1/g;
  const out = code.replace(re, () => replacementExpr);
  return { code: out, changed: out !== code };
}

function listFiles(dir: string, ext: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
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
    } catch {}
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
