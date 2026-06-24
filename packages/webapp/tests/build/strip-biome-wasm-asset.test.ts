import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BIOME_WASM_ASSET_RE,
  BIOME_WASM_NEUTRALIZED_EXPR,
  rewriteBiomeWasmReference,
  stripBiomeWasmAssetPlugin,
  stripBiomeWasmFromDir,
} from '../../vite-plugins/strip-biome-wasm-asset';

/** Minimal structural view of the build-only hooks we drive directly. */
type PluginHooks = {
  name: string;
  apply?: string;
  configResolved: (config: { root: string; build: { outDir: string } }) => void;
  closeBundle: () => void;
};

/** The shape the wasm-bindgen glue is emitted as in the built bundle. */
const EMITTED_REF =
  'e===void 0&&(e=new URL(`/assets/biome_wasm_bg-DQn8Ios_.wasm`,``+import.meta.url))';

describe('BIOME_WASM_ASSET_RE', () => {
  it('matches the emitted, content-hashed wasm filename', () => {
    expect(BIOME_WASM_ASSET_RE.test('assets/biome_wasm_bg-DQn8Ios_.wasm')).toBe(true);
    expect(BIOME_WASM_ASSET_RE.test('/abs/dist/ui/assets/biome_wasm_bg-AbC123.wasm')).toBe(true);
  });

  it('does not match unrelated wasm binaries', () => {
    expect(BIOME_WASM_ASSET_RE.test('assets/sql-wasm-X.wasm')).toBe(false);
    expect(BIOME_WASM_ASSET_RE.test('pyodide/pyodide.asm.wasm')).toBe(false);
  });
});

describe('BIOME_WASM_NEUTRALIZED_EXPR', () => {
  it('is an empty string literal so the dead-code fallback hits no network', () => {
    expect(BIOME_WASM_NEUTRALIZED_EXPR).toBe('""');
    expect(new Function(`return ${BIOME_WASM_NEUTRALIZED_EXPR};`)()).toBe('');
  });
});

describe('rewriteBiomeWasmReference', () => {
  it('neutralizes the emitted backtick reference', () => {
    const { code, changed } = rewriteBiomeWasmReference(EMITTED_REF);
    expect(changed).toBe(true);
    expect(code).not.toContain('/assets/biome_wasm_bg-');
    expect(code).toContain(BIOME_WASM_NEUTRALIZED_EXPR);
    // No CDN host (full or token-joined) survives.
    expect(code).not.toContain('https://unpkg.com/');
    expect(code).not.toContain('["unpkg","com"]');
    // Surrounding code (the dead-branch guard) is preserved.
    expect(code).toContain('e===void 0&&(e=new URL(');
    expect(code).toContain('import.meta.url');
  });

  it('handles single- and double-quoted references too', () => {
    expect(rewriteBiomeWasmReference("x='/assets/biome_wasm_bg-Z9.wasm'").code).toBe(
      `x=${BIOME_WASM_NEUTRALIZED_EXPR}`
    );
    expect(rewriteBiomeWasmReference('x="biome_wasm_bg-Z9.wasm"').code).toBe(
      `x=${BIOME_WASM_NEUTRALIZED_EXPR}`
    );
  });

  it('rewrites every reference (global flag) when a file carries more than one', () => {
    const input = "a='/assets/biome_wasm_bg-A.wasm';b=`biome_wasm_bg-B.wasm`";
    const { code, changed } = rewriteBiomeWasmReference(input);
    expect(changed).toBe(true);
    expect(code).toBe(`a=${BIOME_WASM_NEUTRALIZED_EXPR};b=${BIOME_WASM_NEUTRALIZED_EXPR}`);
    // No reference left dangling.
    expect(code).not.toContain('biome_wasm_bg-');
  });

  it('leaves code without a biome wasm reference untouched', () => {
    const input = 'const x = new URL("other.wasm", import.meta.url);';
    const { code, changed } = rewriteBiomeWasmReference(input);
    expect(changed).toBe(false);
    expect(code).toBe(input);
  });

  it('does not let a replacement containing $ break the substitution', () => {
    // Replacer is a function, so $-sequences are not interpreted.
    const weird = '`$1$&-neutralized`';
    const out = rewriteBiomeWasmReference("a='biome_wasm_bg-A.wasm'", weird).code;
    expect(out).toBe(`a=${weird}`);
  });
});

describe('stripBiomeWasmFromDir', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slicc-strip-biome-'));
    mkdirSync(join(dir, 'assets'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('deletes the wasm binary and neutralizes its reference', () => {
    const wasmPath = join(dir, 'assets', 'biome_wasm_bg-DQn8Ios_.wasm');
    const gluePath = join(dir, 'assets', 'biome_wasm-9dIxwChb.js');
    writeFileSync(wasmPath, Buffer.alloc(1024, 0));
    writeFileSync(gluePath, EMITTED_REF);

    const result = stripBiomeWasmFromDir(dir);

    expect(result.removed).toEqual([wasmPath]);
    expect(result.bytesRemoved).toBe(1024);
    expect(result.rewritten).toEqual([gluePath]);
    expect(existsSync(wasmPath)).toBe(false);
    const glue = readFileSync(gluePath, 'utf8');
    expect(glue).not.toContain('/assets/biome_wasm_bg-');
    expect(glue).toContain(BIOME_WASM_NEUTRALIZED_EXPR);
    // No CDN host literal — token-joined or otherwise — survives.
    expect(glue).not.toContain('https://unpkg.com/');
    expect(glue).not.toContain('["unpkg","com"]');
  });

  it('walks nested directories and leaves unrelated wasm/js alone', () => {
    const nested = join(dir, 'assets', 'nested');
    mkdirSync(nested, { recursive: true });
    const biomeWasm = join(nested, 'biome_wasm_bg-AbC1.wasm');
    const otherWasm = join(dir, 'assets', 'sql-wasm-X.wasm');
    const unrelatedJs = join(dir, 'assets', 'unrelated.js');
    writeFileSync(biomeWasm, Buffer.alloc(8));
    writeFileSync(otherWasm, Buffer.alloc(8));
    writeFileSync(unrelatedJs, 'export const x = 1;');

    const result = stripBiomeWasmFromDir(dir);

    expect(result.removed).toEqual([biomeWasm]);
    expect(existsSync(otherWasm)).toBe(true);
    expect(readFileSync(unrelatedJs, 'utf8')).toBe('export const x = 1;');
  });

  it('is a no-op when no biome wasm is present', () => {
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1);');
    const result = stripBiomeWasmFromDir(dir);
    expect(result.removed).toEqual([]);
    expect(result.rewritten).toEqual([]);
    expect(result.bytesRemoved).toBe(0);
  });
});

describe('stripBiomeWasmAssetPlugin', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slicc-strip-plugin-'));
    mkdirSync(join(dir, 'assets'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a build-only plugin', () => {
    const plugin = stripBiomeWasmAssetPlugin();
    expect(plugin.name).toBe('slicc:strip-biome-wasm-asset');
    expect(plugin.apply).toBe('build');
  });

  it('strips the asset against the resolved outDir in closeBundle', () => {
    const wasmPath = join(dir, 'assets', 'biome_wasm_bg-DQn8Ios_.wasm');
    const gluePath = join(dir, 'assets', 'biome_wasm-9dIxwChb.js');
    writeFileSync(wasmPath, Buffer.alloc(2048, 0));
    writeFileSync(gluePath, EMITTED_REF);

    const plugin = stripBiomeWasmAssetPlugin() as unknown as PluginHooks;
    plugin.configResolved({ root: dir, build: { outDir: '.' } });
    plugin.closeBundle();

    expect(existsSync(wasmPath)).toBe(false);
    const glue = readFileSync(gluePath, 'utf8');
    expect(glue).not.toContain('/assets/biome_wasm_bg-');
    expect(glue).not.toContain('https://unpkg.com/');
    expect(glue).not.toContain('["unpkg","com"]');
    expect(glue).toContain(BIOME_WASM_NEUTRALIZED_EXPR);
  });
});
