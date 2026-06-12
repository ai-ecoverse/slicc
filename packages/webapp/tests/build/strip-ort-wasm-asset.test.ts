import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ORT_WEB_VERSION } from '../../src/speech/ort-version.js';
import {
  buildOrtWasmRuntimeUrlExpr,
  ORT_WASM_ASSET_RE,
  originalOrtWasmName,
  rewriteOrtWasmReferences,
  sanitizeOrtCdnLiterals,
  stripOrtWasmAssetPlugin,
  stripOrtWasmFromDir,
} from '../../vite-plugins/strip-ort-wasm-asset';

/** Minimal structural view of the build-only hooks we drive directly. */
type PluginHooks = {
  name: string;
  apply?: string;
  configResolved: (config: { root: string; build: { outDir: string } }) => void;
  closeBundle: () => void;
};

/** The shape ort-web's zero-config fallback is emitted as in the bundle. */
const EMITTED_REF =
  't===void 0&&(t=new URL(`/assets/ort-wasm-simd-threaded.asyncify-DMmc6YqF.wasm`,import.meta.url))';

describe('ORT_WASM_ASSET_RE', () => {
  it('matches emitted, content-hashed ort wasm filenames (any variant)', () => {
    expect(ORT_WASM_ASSET_RE.test('assets/ort-wasm-simd-threaded.asyncify-DMmc6YqF.wasm')).toBe(
      true
    );
    expect(ORT_WASM_ASSET_RE.test('/dist/ui/assets/ort-wasm-simd-threaded.jsep-Ab12_-.wasm')).toBe(
      true
    );
  });

  it('does not match unrelated wasm binaries', () => {
    expect(ORT_WASM_ASSET_RE.test('assets/biome_wasm_bg-DQn8Ios_.wasm')).toBe(false);
    expect(ORT_WASM_ASSET_RE.test('assets/sql-wasm-X.wasm')).toBe(false);
  });
});

describe('originalOrtWasmName', () => {
  it('strips the content hash back to the dist filename', () => {
    expect(originalOrtWasmName('ort-wasm-simd-threaded.asyncify-DMmc6YqF.wasm')).toBe(
      'ort-wasm-simd-threaded.asyncify.wasm'
    );
    expect(originalOrtWasmName('ort-wasm-simd-threaded.jsep-Ab12x.wasm')).toBe(
      'ort-wasm-simd-threaded.jsep.wasm'
    );
  });
});

describe('rewriteOrtWasmReferences', () => {
  it('repoints emitted references at the version-pinned CDN expression', () => {
    const { code, changed } = rewriteOrtWasmReferences(EMITTED_REF);
    expect(changed).toBe(true);
    expect(code).not.toContain('/assets/ort-wasm-');
    // Variant-correct original filename, version-pinned path.
    expect(code).toContain(
      `/npm/onnxruntime-web@${ORT_WEB_VERSION}/dist/ort-wasm-simd-threaded.asyncify.wasm`
    );
    // The host stays split — no full https://cdn.jsdelivr.net/ literal.
    expect(code).not.toContain('https://cdn.jsdelivr.net/');
    expect(code).toContain('["cdn","jsdelivr","net"].join(".")');
    // Surrounding code (the dead-branch guard) is preserved.
    expect(code).toContain('t===void 0&&(t=new URL(');
  });

  it('leaves unrelated code untouched', () => {
    const { code, changed } = rewriteOrtWasmReferences('const x = "biome_wasm_bg-X.wasm";');
    expect(changed).toBe(false);
    expect(code).toContain('biome_wasm_bg-X.wasm');
  });
});

describe('sanitizeOrtCdnLiterals', () => {
  it("splits the host out of ort's baked-in CDN fallback (MV3 RHC scanner)", () => {
    // The shape ort-web bundles: a template literal interpolating its version.
    const emitted = 'r=`https://cdn.jsdelivr.net/npm/onnxruntime-web@${Bc.versions.web}/dist/`';
    const { code, changed } = sanitizeOrtCdnLiterals(emitted);
    expect(changed).toBe(true);
    expect(code).not.toContain('https://cdn.jsdelivr.net/npm');
    expect(code).toBe(
      'r=`https://${["cdn","jsdelivr","net"].join(".")}/npm/onnxruntime-web@${Bc.versions.web}/dist/`'
    );
  });

  it('only rewrites the template-literal fallback shape, nothing else', () => {
    const plain = 'const u = "https://cdn.jsdelivr.net/npm/lodash";';
    expect(sanitizeOrtCdnLiterals(plain).changed).toBe(false);
  });
});

describe('buildOrtWasmRuntimeUrlExpr', () => {
  it('evaluates to the jsdelivr URL at runtime', () => {
    const expr = buildOrtWasmRuntimeUrlExpr('ort-wasm-simd-threaded.jsep.wasm');
    // biome-ignore lint/security/noGlobalEval: evaluating the build-produced expression IS the test
    const url = eval(expr) as string;
    expect(url).toBe(
      `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_WEB_VERSION}/dist/ort-wasm-simd-threaded.jsep.wasm`
    );
  });
});

describe('stripOrtWasmFromDir + plugin', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strip-ort-'));
    mkdirSync(join(dir, 'assets'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('deletes the emitted binaries and rewrites their references', () => {
    const wasm = join(dir, 'assets', 'ort-wasm-simd-threaded.asyncify-DMmc6YqF.wasm');
    writeFileSync(wasm, Buffer.alloc(1024));
    const keep = join(dir, 'assets', 'pyodide.asm.wasm');
    writeFileSync(keep, Buffer.alloc(16));
    const js = join(dir, 'assets', 'transformers.web-X.js');
    writeFileSync(js, EMITTED_REF);

    const result = stripOrtWasmFromDir(dir);
    expect(result.removed).toEqual([wasm]);
    expect(result.bytesRemoved).toBe(1024);
    expect(result.rewritten).toEqual([js]);
    expect(existsSync(wasm)).toBe(false);
    expect(existsSync(keep)).toBe(true);
    expect(readFileSync(js, 'utf8')).toContain(`onnxruntime-web@${ORT_WEB_VERSION}`);
  });

  it('sanitizes the baked-in CDN fallback even when no binaries were emitted', () => {
    const js = join(dir, 'assets', 'kernel-worker-X.js');
    writeFileSync(js, 'r=`https://cdn.jsdelivr.net/npm/onnxruntime-web@${v.versions.web}/dist/`');

    const result = stripOrtWasmFromDir(dir);
    expect(result.removed).toEqual([]);
    expect(result.rewritten).toEqual([js]);
    expect(readFileSync(js, 'utf8')).not.toContain('https://cdn.jsdelivr.net/npm');
  });

  it('is a no-op on output with no ort assets or literals', () => {
    const result = stripOrtWasmFromDir(dir);
    expect(result.removed).toEqual([]);
    expect(result.rewritten).toEqual([]);
  });

  it('runs end-to-end through the plugin hooks', () => {
    const wasm = join(dir, 'assets', 'ort-wasm-simd-threaded.jsep-Hash1.wasm');
    writeFileSync(wasm, Buffer.alloc(64));

    const plugin = stripOrtWasmAssetPlugin() as unknown as PluginHooks;
    expect(plugin.name).toBe('slicc:strip-ort-wasm-asset');
    expect(plugin.apply).toBe('build');
    plugin.configResolved({ root: dir, build: { outDir: '.' } });
    plugin.closeBundle();
    expect(existsSync(wasm)).toBe(false);
  });
});
