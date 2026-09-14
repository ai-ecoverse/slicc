import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'module';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileWasmModule } from '../../../src/kernel/realm/wasm-compiler.js';
import {
  tryLoadV86FromNodeModules,
  V86_LAYOUT_CANDIDATES,
  V86_PINNED_VERSION,
} from '../../../src/shell/supplemental-commands/v86-wasm.js';

const require = createRequire(import.meta.url);

const PKG = dirname(require.resolve('v86/package.json'));
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SKILL_PATH = resolve(REPO_ROOT, 'packages/vfs-root/workspace/skills/v86/SKILL.md');

const VFS_ROOT = '/workspace';
const VFS_PKG = `${VFS_ROOT}/node_modules/v86`;

const releaseOf = (version: string): string => version.split('+')[0] ?? version;

const INSTRUMENTED_INTERNALS = [
  'wasm_fn',
  'net_device',
  'relay_url',

  'add_listener',
  'is_running',
  'save_state',
  'restore_state',
  'keyboard_send_text',
  'keyboard_send_scancodes',
  'serial0_send',

  '"emulator-loaded"',
  '"serial0-output-byte"',

  'screen_adapter',
  'set_mode',
  'set_size_graphical',
  'update_buffer',
  'get_text_screen',

  'screen_fill_buffer',
  'graphical_mode',

  'network_adapter',
] as const;

describe('v86 live canary (real installed package)', () => {
  let layout: (typeof V86_LAYOUT_CANDIDATES)[number];
  let realJs: string;
  let realWasm: Uint8Array;
  let loaded: NonNullable<Awaited<ReturnType<typeof tryLoadV86FromNodeModules>>>;

  beforeAll(async () => {
    const found = V86_LAYOUT_CANDIDATES.find(
      (candidate) => existsSync(`${PKG}/${candidate.js}`) && existsSync(`${PKG}/${candidate.wasm}`)
    );
    expect(
      found,
      `no glue + engine pair under ${PKG} in any known layout ` +
        `(${V86_LAYOUT_CANDIDATES.map((c) => `${c.js} + ${c.wasm}`).join(', ')}) — the package ` +
        `changed shape; add the new layout to V86_LAYOUT_CANDIDATES in v86-wasm.ts`
    ).toBeDefined();
    layout = found as (typeof V86_LAYOUT_CANDIDATES)[number];

    realJs = readFileSync(`${PKG}/${layout.js}`, 'utf8');
    realWasm = new Uint8Array(readFileSync(`${PKG}/${layout.wasm}`));
    const pkgJson = readFileSync(`${PKG}/package.json`, 'utf8');

    const text = new Map([
      [`${VFS_PKG}/package.json`, pkgJson],
      [`${VFS_PKG}/${layout.js}`, realJs],
    ]);
    const present = new Set([...text.keys(), `${VFS_PKG}/${layout.wasm}`]);
    const ipk = {
      fromDir: VFS_ROOT,
      reader: {
        exists: async (path: string) => present.has(path),
        isDirectory: async (path: string) =>
          [...present].some((file) => file.startsWith(`${path}/`)),
        readFile: async (path: string) => {
          const body = text.get(path);
          if (body === undefined) throw new Error(`ENOENT: ${path}`);
          return body;
        },
      },
      readBytes: async (path: string) => {
        if (path === `${VFS_PKG}/${layout.wasm}`) return realWasm;
        throw new Error(`ENOENT: ${path}`);
      },
    };
    const result = await tryLoadV86FromNodeModules(ipk);
    expect(result, 'the loader could not resolve the mirrored real install').not.toBeNull();
    loaded = result as typeof loaded;
  });

  it('resolves the real install and hands back the real glue and engine bytes', () => {
    expect(releaseOf(loaded.version)).toBe(V86_PINNED_VERSION);
    expect(loaded.jsSource).toBe(realJs);
    expect(loaded.wasmBytes.byteLength).toBe(realWasm.byteLength);
    expect(Buffer.from(loaded.wasmBytes).equals(Buffer.from(realWasm))).toBe(true);

    expect(require.resolve('v86')).toBe(resolve(PKG, layout.js));
  });

  it('compiles the real engine and exposes the surface makeWasmFn feeds it', async () => {
    const mod = await compileWasmModule(loaded.wasmBytes);

    const imports = WebAssembly.Module.imports(mod);
    expect(imports.length).toBeGreaterThan(0);
    expect(new Set(imports.map((entry) => entry.module))).toEqual(new Set(['env']));
    expect(WebAssembly.Module.exports(mod)).toContainEqual({ name: 'memory', kind: 'memory' });
  });

  it('exports the V86 constructor the loader picks', async () => {
    const glue = (await import('v86')) as { V86?: unknown; default?: unknown };
    expect(typeof (glue.V86 ?? glue.default)).toBe('function');
  });

  it('keeps V86_PINNED_VERSION in lockstep with the installed package and the agent skill', () => {
    const pkg = JSON.parse(readFileSync(`${PKG}/package.json`, 'utf8')) as { version: string };
    expect(V86_PINNED_VERSION).toBe(releaseOf(pkg.version));

    const skill = readFileSync(SKILL_PATH, 'utf8');
    expect(skill).toContain(`ipk add -g v86@${V86_PINNED_VERSION}`);
  });

  it('still ships every internal the command instruments', () => {
    for (const internal of INSTRUMENTED_INTERNALS) {
      expect(
        loaded.jsSource.includes(internal),
        `${internal} is gone from the installed glue — re-verify v86-vm.ts / v86-command.ts against v86@${loaded.version}`
      ).toBe(true);
    }
  });
});
