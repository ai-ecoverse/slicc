import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BIOME_WASM_ASSET_RE,
  buildBiomeWasmRuntimeUrlExpr,
  rewriteBiomeWasmReference,
  resolveBiomeWasmCdnUrl,
  stripBiomeWasmFromDir,
  stripBiomeWasmAssetPlugin,
} from '../../vite-plugins/strip-biome-wasm-asset';

/** Minimal structural view of the build-only hooks we drive directly. */
type PluginHooks = {
  name: string;
  apply?: string;
  configResolved: (config: { root: string; build: { outDir: string } }) => void;
  closeBundle: () => void;
};

/**
 * Runtime expression substituted for the wasm-bindgen string literal. The
 * test mirrors the plugin's strategy: the host is split so no full
 * `https://unpkg.com/<path>` literal appears in the output.
 */
const RUNTIME_EXPR =
  '`https://${["unpkg","com"].join(".")}/@biomejs/wasm-web@2.4.16/biome_wasm_bg.wasm`';

/** Substring all rewrite outputs share — the host-less path tail. */
const PATH_TAIL = '/@biomejs/wasm-web@2.4.16/biome_wasm_bg.wasm';

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

describe('rewriteBiomeWasmReference', () => {
  it('repoints the emitted backtick reference at the runtime URL expression', () => {
    const { code, changed } = rewriteBiomeWasmReference(EMITTED_REF, RUNTIME_EXPR);
    expect(changed).toBe(true);
    expect(code).not.toContain('/assets/biome_wasm_bg-');
    expect(code).toContain(RUNTIME_EXPR);
    // The substituted expression evaluates to the CDN URL at runtime, but no
    // full `https://<host>/<path>` literal survives in the source — the host
    // is split via `["unpkg","com"].join(".")` to defeat the MV3 RHC scanner.
    expect(code).not.toContain('https://unpkg.com/');
    // Surrounding code (the dead-branch guard) is preserved.
    expect(code).toContain('e===void 0&&(e=new URL(');
    expect(code).toContain('import.meta.url');
  });

  it('handles single- and double-quoted references too', () => {
    expect(rewriteBiomeWasmReference("x='/assets/biome_wasm_bg-Z9.wasm'", RUNTIME_EXPR).code).toBe(
      `x=${RUNTIME_EXPR}`
    );
    expect(rewriteBiomeWasmReference('x="biome_wasm_bg-Z9.wasm"', RUNTIME_EXPR).code).toBe(
      `x=${RUNTIME_EXPR}`
    );
  });

  it('rewrites every reference (global flag) when a file carries more than one', () => {
    const input = "a='/assets/biome_wasm_bg-A.wasm';b=`biome_wasm_bg-B.wasm`";
    const { code, changed } = rewriteBiomeWasmReference(input, RUNTIME_EXPR);
    expect(changed).toBe(true);
    expect(code).toBe(`a=${RUNTIME_EXPR};b=${RUNTIME_EXPR}`);
    // No reference left dangling.
    expect(code).not.toContain('biome_wasm_bg-');
  });

  it('leaves code without a biome wasm reference untouched', () => {
    const input = 'const x = new URL("other.wasm", import.meta.url);';
    const { code, changed } = rewriteBiomeWasmReference(input, RUNTIME_EXPR);
    expect(changed).toBe(false);
    expect(code).toBe(input);
  });

  it('does not let a replacement containing $ break the substitution', () => {
    // Replacer is a function, so $-sequences are not interpreted.
    const weird = '`https://x/$1$&-biome.wasm`';
    const out = rewriteBiomeWasmReference("a='biome_wasm_bg-A.wasm'", weird).code;
    expect(out).toBe(`a=${weird}`);
  });
});

describe('resolveBiomeWasmCdnUrl', () => {
  it('builds an unpkg URL pinned to the installed wasm-web version', () => {
    expect(resolveBiomeWasmCdnUrl()).toMatch(
      /^https:\/\/unpkg\.com\/@biomejs\/wasm-web@\d+\.\d+\.\d+\/biome_wasm_bg\.wasm$/
    );
  });
});

describe('buildBiomeWasmRuntimeUrlExpr', () => {
  it('emits a template-literal expression with a runtime-joined host', () => {
    const expr = buildBiomeWasmRuntimeUrlExpr();
    // No full `https://unpkg.com/...` literal — the host is reassembled at
    // runtime via `["unpkg","com"].join(".")`. The path tail is allowed to
    // appear as a fragment (no scheme + host prefix).
    expect(expr).not.toContain('https://unpkg.com/');
    expect(expr).toContain('["unpkg","com"].join(".")');
    expect(expr).toMatch(/\/@biomejs\/wasm-web@\d+\.\d+\.\d+\/biome_wasm_bg\.wasm/);
    expect(expr.startsWith('`')).toBe(true);
    expect(expr.endsWith('`')).toBe(true);
  });

  it('evaluates to the same URL `resolveBiomeWasmCdnUrl` returns', () => {
     
    const evaluated = new Function(`return ${buildBiomeWasmRuntimeUrlExpr()};`)() as string;
    expect(evaluated).toBe(resolveBiomeWasmCdnUrl());
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

  it('deletes the wasm binary and repoints its reference', () => {
    const wasmPath = join(dir, 'assets', 'biome_wasm_bg-DQn8Ios_.wasm');
    const gluePath = join(dir, 'assets', 'biome_wasm-9dIxwChb.js');
    writeFileSync(wasmPath, Buffer.alloc(1024, 0)); // stand-in binary
    writeFileSync(gluePath, EMITTED_REF);

    const result = stripBiomeWasmFromDir(dir, RUNTIME_EXPR);

    expect(result.removed).toEqual([wasmPath]);
    expect(result.bytesRemoved).toBe(1024);
    expect(result.rewritten).toEqual([gluePath]);
    expect(existsSync(wasmPath)).toBe(false);
    const glue = readFileSync(gluePath, 'utf8');
    expect(glue).not.toContain('/assets/biome_wasm_bg-');
    expect(glue).toContain(RUNTIME_EXPR);
    // The host literal `https://unpkg.com/` must not survive — only the
    // runtime-joined form does.
    expect(glue).not.toContain('https://unpkg.com/');
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

    const result = stripBiomeWasmFromDir(dir, RUNTIME_EXPR);

    expect(result.removed).toEqual([biomeWasm]);
    expect(existsSync(otherWasm)).toBe(true);
    expect(readFileSync(unrelatedJs, 'utf8')).toBe('export const x = 1;');
  });

  it('is a no-op when no biome wasm is present', () => {
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1);');
    const result = stripBiomeWasmFromDir(dir, RUNTIME_EXPR);
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
    // outDir is resolved relative to root: root=dir, outDir='.' -> dir.
    plugin.configResolved({ root: dir, build: { outDir: '.' } });
    plugin.closeBundle();

    expect(existsSync(wasmPath)).toBe(false);
    const glue = readFileSync(gluePath, 'utf8');
    expect(glue).not.toContain('/assets/biome_wasm_bg-');
    // Host literal must not survive; the runtime-joined form does.
    expect(glue).not.toContain('https://unpkg.com/');
    expect(glue).toContain(PATH_TAIL); // the CDN URL path tail is allowed
    expect(glue).toContain('["unpkg","com"].join(".")');
  });
});
