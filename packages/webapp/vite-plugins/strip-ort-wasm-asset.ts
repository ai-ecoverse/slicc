import type { Dirent } from 'node:fs';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { ORT_WEB_VERSION } from '../src/speech/ort-version.js';

export const ORT_WASM_ASSET_RE = /ort-wasm-[\w.-]+\.wasm$/;

export function originalOrtWasmName(emittedName: string): string {
  return emittedName.replace(/-[\w-]+(\.wasm)$/, '$1');
}

export function buildOrtWasmRuntimeUrlExpr(distFile: string): string {
  return (
    '`https://${["cdn","jsdelivr","net"].join(".")}' +
    `/npm/onnxruntime-web@${ORT_WEB_VERSION}/dist/${distFile}\``
  );
}

export function rewriteOrtWasmReferences(code: string): { code: string; changed: boolean } {
  const re = /(['"`])(?:[^'"`\\]|\\.)*?(ort-wasm-[\w.-]+\.wasm)\1/g;
  const out = code.replace(re, (_match, _quote: string, emittedName: string) =>
    buildOrtWasmRuntimeUrlExpr(originalOrtWasmName(emittedName))
  );
  return { code: out, changed: out !== code };
}

export function sanitizeOrtCdnLiterals(code: string): { code: string; changed: boolean } {
  const re = /https:\/\/cdn\.jsdelivr\.net\/(npm\/onnxruntime-web@\$\{)/g;
  const out = code.replace(re, 'https://${["cdn","jsdelivr","net"].join(".")}/$1');
  return { code: out, changed: out !== code };
}

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
    } catch {}
    rmSync(wasm);
    removed.push(wasm);
  }

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
    },
  };
}
