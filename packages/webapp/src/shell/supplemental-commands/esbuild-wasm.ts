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
 * Every browser float takes the same path: the wasm bytes are
 * materialized through the VFS, compiled to a `WebAssembly.Module`,
 * and handed to `initialize({ wasmModule, worker: false })` —
 * sidestepping the blob-URL / `wasmURL` CSP differences between
 * extension and standalone, and the nested-blob-Worker handshake
 * that can stall forever (#2200, see `loadEsbuild`). `initialize`
 * accepts either a `wasmURL` or a `wasmModule`; passing the compiled
 * module keeps the loader symmetric across floats. The handshake is
 * bounded by {@link ESBUILD_INIT_TIMEOUT_MS} so a stall becomes a
 * named rejection instead of an indefinite hang.
 *
 * Vitest / Node: the `esbuild-wasm` npm package's Node entry
 * (`lib/main.js`, picked when `"main"` resolves) spawns a wasm
 * subprocess via `node bin/esbuild` and explicitly REJECTS the
 * `wasmURL` / `wasmModule` / `worker` options on `initialize`.
 * The Node path therefore must not call `initialize` at all —
 * `esbuild.build()` lazily boots the service on first call.
 *
 * The glue is a namespace import on purpose, unlike `magick-wasm.ts`,
 * where named bindings shave ~100 kB of unused dual glue off the kernel
 * worker's cold-boot graph. Vite resolves `esbuild-wasm` through its
 * `browser` field to `lib/browser.js`, which is CommonJS: the bundle
 * carries it as one opaque interop closure that no import style can
 * tree-shake, and the package ships a single service with no dual glue
 * to drop anyway. Named imports were measured at +163 B on the worker
 * graph (the wrapper object), not a saving. The module sits in that
 * eager graph for a functional reason — `realm-host.ts` needs
 * `getEsbuild` for realm `require()` of ESM — so hoisting
 * `ESBUILD_VERSION` into a leaf would not detach it either.
 */

import * as esbuild from 'esbuild-wasm';
import { splitPath } from '../../fs/path-utils.js';
import { compileWasmModule } from '../../kernel/realm/wasm-compiler.js';
import { type ModuleReader, nodeModulesSearchPath, resolve } from '../ipk/resolver.js';
import { GLOBAL_IPK_ADD, isNodeRuntime } from './shared.js';

/** Version string read off the installed `esbuild-wasm` package. */
export const ESBUILD_VERSION = esbuild.version;

/**
 * Budget for the `esbuild.initialize` service handshake (compile is done by
 * then; this covers only the Go runtime boot + first stdout message).
 *
 * A stalled handshake used to hang every caller forever with no output
 * (#2200): `node` on any ESM source and the `esbuild` command simply
 * produced nothing until killed. A named rejection inside the budget is
 * strictly better — the ESM transpiler can fall back to TypeScript and the
 * `esbuild` command can print why.
 */
export const ESBUILD_INIT_TIMEOUT_MS = 20_000;

/**
 * Thrown when `esbuild.initialize` neither resolves nor rejects within
 * {@link ESBUILD_INIT_TIMEOUT_MS}. Distinct type because a stall is not
 * retryable: `initialize` may be called only once per realm, and the
 * abandoned call keeps esbuild's own internal promise pending, so every
 * later `getEsbuild` re-rejects with the recorded stall instead of
 * starting a second load.
 */
export class EsbuildInitStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EsbuildInitStallError';
  }
}

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
 * Recorded stall (see {@link EsbuildInitStallError}) — sticky for the
 * lifetime of the realm because the abandoned `initialize` cannot be
 * retried. Kept separate from `esbuildPromise` so the cache holds only
 * pending-or-resolved loads and can never hold a promise that will never
 * settle.
 */
let esbuildStall: EsbuildInitStallError | null = null;
/** Effective handshake budget; only tests shorten it (`resetEsbuildForTests`). */
let initTimeoutMs: number = ESBUILD_INIT_TIMEOUT_MS;

/**
 * Public entry point. Idempotent across calls within a session —
 * `esbuild.initialize` may only be called once per realm, so the
 * loader memoizes the underlying promise and re-throws the same
 * failure if init was rejected (a fresh import would still reject).
 *
 * A REJECTED load clears the cache so the next call retries (a package
 * installed in the meantime, or a different cwd, then resolves). A
 * STALLED load (init never settled) is bounded by
 * {@link ESBUILD_INIT_TIMEOUT_MS} and recorded in `esbuildStall`, so
 * later callers fail fast with the same diagnosis instead of awaiting a
 * dead promise for the rest of the session (#2200).
 *
 * In Node / vitest, `ipk` is unused (the package's Node entry boots
 * lazily on first `build` / `transform`). In the browser, `ipk` is
 * required to locate `esbuild.wasm`; calls without an ipk context,
 * or with one that finds nothing installed, throw a clean error.
 */
export async function getEsbuild(
  options: { onProgress?: (msg: string) => void; ipk?: IpkResolutionContext } = {}
): Promise<typeof esbuild> {
  if (esbuildStall) throw esbuildStall;
  if (!esbuildPromise) {
    esbuildPromise = loadEsbuild(options.onProgress, options.ipk).catch((err) => {
      esbuildPromise = null;
      if (err instanceof EsbuildInitStallError) esbuildStall = err;
      throw err;
    });
  }
  return esbuildPromise;
}

/** A located, readable ipk-installed `esbuild-wasm` binary. */
export interface EsbuildWasmBinary {
  /** Directory of the resolved `esbuild-wasm` package. */
  packageDir: string;
  /** Bytes of `<packageDir>/esbuild.wasm`. */
  bytes: Uint8Array;
}

/**
 * Try to read `esbuild.wasm` from an ipk-installed `esbuild-wasm` in
 * the VFS. Resolves `esbuild-wasm/package.json` through the shared
 * resolver (so the standard `node_modules` walk and resolution rules
 * apply), derives the package directory from the resolved file, and
 * reads sibling `esbuild.wasm` bytes. Returns `null` on any miss —
 * the caller surfaces a clean "not installed" error.
 *
 * The binary has lived at the package root in every `esbuild-wasm`
 * release since 0.5.0, so there is deliberately no candidate list here.
 * A release that moves it would still pass every mocked test in this
 * tree; `esbuild-wasm-live.test.ts` reads the real installed package
 * and is the check that catches that.
 *
 * Exported so the loader's resolution behavior is unit-testable
 * without booting the heavy WASM service.
 */
export async function tryLoadEsbuildWasmFromNodeModules(
  ipk: IpkResolutionContext
): Promise<EsbuildWasmBinary | null> {
  let resolved;
  try {
    resolved = await resolve('esbuild-wasm/package.json', ipk.fromDir, ipk.reader);
  } catch {
    return null;
  }
  if (resolved.type !== 'file') return null;
  const packageDir = splitPath(resolved.path).dir;
  const wasmPath = `${packageDir}/esbuild.wasm`;
  if (!(await ipk.reader.exists(wasmPath))) return null;
  try {
    return { packageDir, bytes: await ipk.readBytes(wasmPath) };
  } catch {
    return null;
  }
}

/**
 * Race `esbuild.initialize` against {@link ESBUILD_INIT_TIMEOUT_MS} and
 * turn a stall into an {@link EsbuildInitStallError} naming the resolved
 * package, its wasm byte count and the budget. The abandoned call is left
 * running (esbuild exposes no abort for it); `getEsbuild` records the stall
 * so nothing awaits it again.
 */
async function initializeWithTimeout(
  wasmModule: WebAssembly.Module,
  binary: EsbuildWasmBinary
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new EsbuildInitStallError(
          `esbuild-wasm found at ${binary.packageDir} (${binary.bytes.byteLength} bytes) ` +
            `but the wasm service did not start within ${initTimeoutMs / 1000}s ` +
            '(in-thread mode, `worker: false`). esbuild stays unavailable until this ' +
            'session is reloaded; ESM transpiles fall back to TypeScript.'
        )
      );
    }, initTimeoutMs);
  });
  try {
    await Promise.race([esbuild.initialize({ wasmModule, worker: false }), budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
      `esbuild-wasm is not available: install via \`${GLOBAL_IPK_ADD} esbuild-wasm@${ESBUILD_VERSION}\``
    );
  }
  const binary = await tryLoadEsbuildWasmFromNodeModules(ipk);
  if (!binary) {
    // Resolution is cwd-relative, so name the walked directories: an
    // `esbuild-wasm` installed in `/workspace/node_modules` is invisible
    // from `/shared`, and the bare "not installed" claim reads as a lie
    // there (#2200).
    throw new Error(
      `esbuild-wasm is not installed in node_modules: run \`${GLOBAL_IPK_ADD} esbuild-wasm@${ESBUILD_VERSION}\`` +
        ` (searched from ${ipk.fromDir}: ${nodeModulesSearchPath(ipk.fromDir).join(', ')})`
    );
  }
  const bytes = binary.bytes;
  log(`esbuild.wasm loaded from ${binary.packageDir} (${bytes.byteLength} bytes)`);
  // Compile through the shared host-context helper (same primitive the
  // realm-host `wasm` channel uses), so esbuild and biome share one
  // compilation path. This already runs host-side (the `esm-transpile`
  // hook), so there's no realm-worker OOM to avoid here — the consolidation
  // is for a single source of truth.
  const wasmModule = await compileWasmModule(bytes);
  // `worker: false` in EVERY browser float, deliberately.
  //
  // With `worker: true` esbuild spawns a nested `blob:` Worker and settles
  // its handshake promise ONLY on that worker's first `message`: it attaches
  // no `onerror` and no timeout. Anything that stops the blob worker from
  // running (a `worker-src`/`child-src` CSP, blob URLs unavailable, nested
  // workers disallowed) therefore leaves `initialize()` pending forever with
  // no diagnostic — the #2200 hang, reproduced in a headless Chromium
  // DedicatedWorker under `worker-src 'self'`. `worker: false` needs no
  // nested worker, resolved in ~130 ms in every configuration tested
  // (including that CSP), and surfaces boot failures as rejections. This
  // code already runs off the UI thread (kernel worker / offscreen
  // document), so there is no thread to keep responsive.
  await initializeWithTimeout(wasmModule, binary);
  log('esbuild ready');
  return esbuild;
}

/**
 * Drop the cached esbuild promise (and any recorded stall) so the next
 * `getEsbuild` call rebuilds from scratch. Test-only — production callers
 * share the single loaded instance for the lifetime of the realm.
 *
 * `initTimeoutMs` shortens the handshake budget so a test can exercise the
 * stall path in milliseconds instead of {@link ESBUILD_INIT_TIMEOUT_MS};
 * omitting it restores the production budget.
 */
export function resetEsbuildForTests(options: { initTimeoutMs?: number } = {}): void {
  esbuildPromise = null;
  esbuildStall = null;
  initTimeoutMs = options.initTimeoutMs ?? ESBUILD_INIT_TIMEOUT_MS;
}
