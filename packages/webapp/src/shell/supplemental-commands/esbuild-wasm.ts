/**
 * Shared esbuild-wasm loader. Bundled as the small `esbuild-wasm`
 * JS wrapper; the heavy `esbuild.wasm` binary (~10 MB) is NOT
 * bundled in the browser builds — it is read on demand from an
 * ipk-installed `esbuild-wasm` in the VFS `node_modules` (see
 * `IpkResolutionContext`). There is no CDN fallback: if nothing
 * is installed, the browser path throws a clean error and any
 * caller with its own fallback (e.g. `esm-transpile.ts` →
 * TypeScript) takes over.
 *
 * Extension mode: the wasm bytes are materialized through the
 * VFS, compiled to a `WebAssembly.Module`, and handed to
 * `initialize({ wasmModule })` — sidestepping any blob-URL or
 * `wasmURL` CSP differences between extension and standalone.
 *
 * Standalone CLI: same path. `initialize` accepts either a
 * `wasmURL` or a `wasmModule`; passing the compiled module keeps
 * the loader symmetric across floats.
 *
 * Vitest / Node: the `esbuild-wasm` npm package's Node entry
 * (`lib/main.js`, picked when `"main"` resolves) spawns a wasm
 * subprocess via `node bin/esbuild` and explicitly REJECTS the
 * `wasmURL` / `wasmModule` / `worker` options on `initialize`.
 * The Node path therefore must not call `initialize` at all —
 * `esbuild.build()` lazily boots the service on first call.
 */

import * as esbuild from 'esbuild-wasm';
import { splitPath } from '../../fs/path-utils.js';
import { compileWasmModule } from '../../kernel/realm/wasm-compiler.js';
import { type ModuleReader, resolve } from '../ipk/resolver.js';
import { isExtensionRuntime, isNodeRuntime } from './shared.js';

/** Version string read off the installed `esbuild-wasm` package. */
export const ESBUILD_VERSION = esbuild.version;

/**
 * Read-only VFS context the loader needs to read an ipk-installed
 * `esbuild-wasm/esbuild.wasm`. `reader` is the resolver's
 * `ModuleReader` (used to find the package via the standard
 * `node_modules` walk); `readBytes` reads the resolved `.wasm` as
 * raw bytes (the resolver's `readFile` is text-only). `fromDir` is
 * the starting directory for the `node_modules` walk — typically
 * the shell `cwd` of the calling command.
 */
export interface IpkResolutionContext {
  reader: ModuleReader;
  readBytes(absolutePath: string): Promise<Uint8Array>;
  fromDir: string;
}

let esbuildPromise: Promise<typeof esbuild> | null = null;

/**
 * Public entry point. Idempotent across calls within a session —
 * `esbuild.initialize` may only be called once per realm, so the
 * loader memoizes the underlying promise and re-throws the same
 * failure if init was rejected (a fresh import would still reject).
 *
 * In Node / vitest, `ipk` is unused (the package's Node entry boots
 * lazily on first `build` / `transform`). In the browser, `ipk` is
 * required to locate `esbuild.wasm`; calls without an ipk context,
 * or with one that finds nothing installed, throw a clean error.
 */
export async function getEsbuild(
  options: { onProgress?: (msg: string) => void; ipk?: IpkResolutionContext } = {}
): Promise<typeof esbuild> {
  if (!esbuildPromise) {
    esbuildPromise = loadEsbuild(options.onProgress, options.ipk).catch((err) => {
      esbuildPromise = null;
      throw err;
    });
  }
  return esbuildPromise;
}

/**
 * Try to read `esbuild.wasm` from an ipk-installed `esbuild-wasm` in
 * the VFS. Resolves `esbuild-wasm/package.json` through the shared
 * resolver (so the standard `node_modules` walk and resolution rules
 * apply), derives the package directory from the resolved file, and
 * reads sibling `esbuild.wasm` bytes. Returns `null` on any miss —
 * the caller surfaces a clean "not installed" error.
 *
 * Exported so the loader's resolution behavior is unit-testable
 * without booting the heavy WASM service.
 */
export async function tryLoadEsbuildWasmFromNodeModules(
  ipk: IpkResolutionContext
): Promise<Uint8Array | null> {
  let resolved;
  try {
    resolved = await resolve('esbuild-wasm/package.json', ipk.fromDir, ipk.reader);
  } catch {
    return null;
  }
  if (resolved.type !== 'file') return null;
  const pkgDir = splitPath(resolved.path).dir;
  const wasmPath = `${pkgDir}/esbuild.wasm`;
  if (!(await ipk.reader.exists(wasmPath))) return null;
  try {
    return await ipk.readBytes(wasmPath);
  } catch {
    return null;
  }
}

async function loadEsbuild(
  onProgress?: (msg: string) => void,
  ipk?: IpkResolutionContext
): Promise<typeof esbuild> {
  const log = onProgress ?? (() => {});

  if (isNodeRuntime()) {
    // Node / vitest: the package entry (`lib/main.js`) ships a
    // subprocess-based service that boots lazily on the first
    // `build` / `transform` call. Calling `initialize` here would
    // throw (see file header). Nothing to do — return the module
    // as-is; the service will spin up on demand.
    log('esbuild ready (node service)');
    return esbuild;
  }

  // Browser (standalone OR extension): an ipk-installed copy of
  // `esbuild.wasm` in the VFS `node_modules` is the only supported
  // source. Without it, surface a clean error rather than reaching
  // out to the network.
  if (!ipk) {
    throw new Error(
      'esbuild-wasm is not available: install via `ipk add esbuild-wasm` or invoke through `ipx esbuild`'
    );
  }
  const bytes = await tryLoadEsbuildWasmFromNodeModules(ipk);
  if (!bytes) {
    throw new Error(
      'esbuild-wasm is not installed in node_modules: run `ipk add esbuild-wasm` or invoke through `ipx esbuild`'
    );
  }
  log(`esbuild.wasm loaded from ipk node_modules (${bytes.byteLength} bytes)`);
  // Compile through the shared host-context helper (same primitive the
  // realm-host `wasm` channel uses), so esbuild and biome share one
  // compilation path. This already runs host-side (the `esm-transpile`
  // hook), so there's no realm-worker OOM to avoid here — the consolidation
  // is for a single source of truth.
  const wasmModule = await compileWasmModule(bytes);
  // Run the wasm in a web worker by default to keep the calling
  // thread responsive. The extension's offscreen document opts out
  // because spawning a worker that imports `https://...` source
  // bumps into the extension origin's CSP; running on the offscreen
  // thread is fine because the offscreen document is already
  // dedicated to the agent runtime.
  await esbuild.initialize({ wasmModule, worker: !isExtensionRuntime() });
  log('esbuild ready');
  return esbuild;
}

/**
 * Drop the cached esbuild promise so the next `getEsbuild` call
 * rebuilds from scratch. Test-only — production callers share the
 * single loaded instance for the lifetime of the realm.
 */
export function resetEsbuildForTests(): void {
  esbuildPromise = null;
}
