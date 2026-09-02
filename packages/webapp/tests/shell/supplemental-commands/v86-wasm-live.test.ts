/**
 * Live canary for the ipk-installed `v86` engine.
 *
 * Every other v86 test drives the loader over a synthetic file map or a
 * mocked engine, so all of them pass against a package whose real on-disk
 * shape, exports or internals have changed underneath us — the failure
 * mode that let `@imagemagick/magick-wasm` 0.0.43 ship with a green unit
 * suite and a broken `convert` (PR #2744). `v86` is a webapp devDependency
 * purely so this test has the REAL package to probe; the runtime never
 * imports it (see the header of `v86-wasm.ts`). Keep this pointed at the
 * installed copy — mocking anything here defeats the purpose.
 *
 * What it covers, against the installed package:
 *   - the layout probe: `tryLoadV86FromNodeModules` resolves the glue and
 *     engine over a VFS that mirrors the real install, byte for byte, and
 *     the candidate it picks is the package's own `main`;
 *   - the engine binary: the resolved bytes compile to a module whose
 *     import surface is the single `env` object `makeWasmFn` is handed;
 *   - the glue's exports: the real module exposes the `V86` constructor
 *     `loadV86` picks (`glue.V86 ?? glue.default`);
 *   - the version pin: `V86_PINNED_VERSION` equals the installed manifest
 *     AND the `ipk add` line in the agent skill, so a Renovate bump cannot
 *     land without the skill moving with it;
 *   - the internals `v86-vm.ts` / `v86-command.ts` reach into
 *     (`screen_adapter.update_buffer`, `get_text_screen`, the fetch relay,
 *     the `emulator-loaded` bus event, ...) still exist in the glue.
 *
 * What it does NOT cover: booting a guest (needs BIOS blobs and seconds of
 * CPU — the mocked-engine lifecycle tests in `v86-command.test.ts` own that
 * surface), the `blob:` URL import in `loadV86` (browser-only; Node cannot
 * import blob URLs), instantiating the wasm against the glue's real import
 * object, or a SEMANTIC change to an internal that keeps its name. Cost is
 * ~100 ms, dominated by compiling the ~2 MB engine.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Bare specifier on purpose: the webapp vitest project aliases `node:module`
// to a browser stub whose `createRequire` throws.
import { createRequire } from 'module';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileWasmModule } from '../../../src/kernel/realm/wasm-compiler.js';
import {
  tryLoadV86FromNodeModules,
  V86_LAYOUT_CANDIDATES,
  V86_PINNED_VERSION,
} from '../../../src/shell/supplemental-commands/v86-wasm.js';

const require = createRequire(import.meta.url);
// Resolve through npm rather than a hardcoded `node_modules` path so the
// test follows the package wherever the workspace hoists it.
const PKG = dirname(require.resolve('v86/package.json'));
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SKILL_PATH = resolve(REPO_ROOT, 'packages/vfs-root/workspace/skills/v86/SKILL.md');

const VFS_ROOT = '/workspace';
const VFS_PKG = `${VFS_ROOT}/node_modules/v86`;

/**
 * The tarball's manifest carries the git build metadata of the release
 * (`0.5.424+g2f1346b`), which npm strips from the version people install
 * by. The pin is the installable form, so compare on the release part.
 * This is also why a magick-style exact-equality version guard would have
 * rejected every correctly pinned install.
 */
const releaseOf = (version: string): string => version.split('+')[0] ?? version;

/**
 * Every v86 internal the command layer touches by name. Sourced from the
 * `V86Emulator` / `V86ScreenAdapter` / `V86NetworkAdapter` /
 * `V86BootOptions` interfaces in `v86-wasm.ts` and the bus events
 * `v86-vm.ts` / `v86-command.ts` subscribe to. A release that renames one
 * of these would not fail typecheck (the interfaces are hand-written) and
 * would not fail the lifecycle tests (they mock the engine); it would only
 * show up as an empty screenshot or a VM that never reports ready.
 */
const INSTRUMENTED_INTERNALS = [
  // Constructor options the command relies on.
  'wasm_fn',
  'net_device',
  'relay_url',
  // Emulator methods.
  'add_listener',
  'is_running',
  'save_state',
  'restore_state',
  'keyboard_send_text',
  'keyboard_send_scancodes',
  'serial0_send',
  // Bus events.
  '"emulator-loaded"',
  '"serial0-output-byte"',
  // Screen adapter surface wrapped by `instrumentVm`.
  'screen_adapter',
  'set_mode',
  'set_size_graphical',
  'update_buffer',
  'get_text_screen',
  // VGA device reached via `emulator.v86.cpu.devices.vga`.
  'screen_fill_buffer',
  'graphical_mode',
  // Fetch relay whose `fetch` the command swaps for the SLICC proxy.
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
    // Mirror the real layout into the VFS the loader walks.
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
    // The candidate the probe picked is the package's own entry point, so a
    // release that moves `main` elsewhere fails here even if it leaves a
    // stale copy behind at the old path.
    expect(require.resolve('v86')).toBe(resolve(PKG, layout.js));
  });

  it('compiles the real engine and exposes the surface makeWasmFn feeds it', async () => {
    const mod = await compileWasmModule(loaded.wasmBytes);
    // v86 builds its whole import object under `env`; `makeWasmFn` passes
    // that object straight through, so a second import module would be a
    // silent instantiate failure inside the emulator.
    const imports = WebAssembly.Module.imports(mod);
    expect(imports.length).toBeGreaterThan(0);
    expect(new Set(imports.map((entry) => entry.module))).toEqual(new Set(['env']));
    expect(WebAssembly.Module.exports(mod)).toContainEqual({ name: 'memory', kind: 'memory' });
  });

  it('exports the V86 constructor the loader picks', async () => {
    // Node's resolver, not the blob-URL path — that is browser-only. Same
    // file, same exports, so this is the check for a renamed/dropped export.
    // Mirror `loadV86`'s pick exactly: the glue currently ships both a named
    // `V86` and a default export, and either one keeps the runtime working.
    const glue = (await import('v86')) as { V86?: unknown; default?: unknown };
    expect(typeof (glue.V86 ?? glue.default)).toBe('function');
  });

  it('keeps V86_PINNED_VERSION in lockstep with the installed package and the agent skill', () => {
    const pkg = JSON.parse(readFileSync(`${PKG}/package.json`, 'utf8')) as { version: string };
    expect(V86_PINNED_VERSION).toBe(releaseOf(pkg.version));
    // The agent-facing skill carries the install line as a literal; a bump
    // that lands without updating it would leave agents installing the old
    // release the canary no longer verifies.
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
