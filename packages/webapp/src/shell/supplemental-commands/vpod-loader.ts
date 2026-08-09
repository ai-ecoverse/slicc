/**
 * Shared vpod SDK loader. Install-gated like `v86-wasm.ts`: NOTHING is
 * bundled — the whole `@capsule-run/vpod` package comes from an
 * ipk-installed copy in the VFS `node_modules`, and uninstalled calls
 * throw the canonical `ipk add` guidance error. ZERO network in the
 * not-installed path.
 *
 * Load mechanism (deliberately different from v86's blob-URL glue):
 * vpod is a deeply URL-relative multi-file ESM distribution — the entry
 * imports sibling chunks, spawns `new Worker(url, {type:'module'})`
 * from URLs derived off `import.meta.url`, and the jco-transpiled
 * component fetches `vpod.core.wasm` relative to itself. Blob URLs are
 * not hierarchical, so the pyodide/ffmpeg wrap pattern cannot work.
 * Instead the SDK is imported through the preview service worker
 * (`toPreviewUrl`), which serves VFS bytes at real same-origin
 * hierarchical URLs — relative chunk imports, worker spawning, and the
 * component's wasm fetch then all resolve natively in the browser.
 * Precedent: pyodide's wheel loader fetches through the same surface
 * (`py-realm-shared.ts`).
 *
 * The pinned version is a source literal (no package.json entry for
 * Renovate to bump — bumping means updating `VPOD_PINNED_VERSION` after
 * re-verifying the SDK surfaces `vpod-command.ts` drives).
 */

import { splitPath } from '../../fs/path-utils.js';
import { resolve as ipkResolve, type ModuleReader } from '../ipk/resolver.js';
import { isNodeRuntime, toPreviewUrl } from './shared.js';

/** The npm `@capsule-run/vpod` release the command is pinned to. */
export const VPOD_PINNED_VERSION = '0.6.0';

export const VPOD_PACKAGE = '@capsule-run/vpod';

export const VPOD_NOT_INSTALLED = `vpod is not installed in node_modules: run \`ipk add ${VPOD_PACKAGE}@${VPOD_PINNED_VERSION}\` (no network fallback)`;

/**
 * Read-only VFS context the loader needs to resolve an ipk-installed
 * `@capsule-run/vpod`. Mirrors the `IpkResolutionContext` shape used by
 * `esbuild-wasm.ts` / `v86-wasm.ts` so every float wires the loader the
 * same way (`readBytes` is unused here — the preview SW streams the
 * wasm — but kept for wiring parity).
 */
export interface IpkResolutionContext {
  reader: ModuleReader;
  readBytes(absolutePath: string): Promise<Uint8Array>;
  fromDir: string;
}

/** Result of one guest command (`sandbox.commands.run`). */
export interface VpodCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

/** What the guest's network can do, per backend (`sandbox.network`). */
export interface VpodNetworkCapabilities {
  backend: 'none' | 'fetch' | 'sockets';
  rawTcp: boolean;
  arbitraryPorts: boolean;
  corsRestricted: boolean;
  byteFaithfulHeaders: boolean;
  udp: boolean;
  strippedRequestHeaders: string[];
}

/** The subset of the vpod `Sandbox` API the command drives. */
export interface VpodSandbox {
  commands: {
    run(command: string, options?: { timeout?: number }): Promise<VpodCommandResult>;
  };
  readonly snapshotId: string;
  readonly network: VpodNetworkCapabilities;
  close(): Promise<void>;
}

export interface VpodSandboxOptions {
  snapshot?: string;
  network?: boolean;
  registryUrl?: string;
}

/** The subset of the SDK module surface the command uses. */
export interface VpodSdk {
  Sandbox: {
    create(options?: VpodSandboxOptions): Promise<VpodSandbox>;
  };
  explainUnreachable(capabilities: VpodNetworkCapabilities, port: number): string | null;
}

export interface VpodModule {
  sdk: VpodSdk;
  /** Version string read off the installed package's manifest. */
  version: string;
}

let vpodPromise: Promise<VpodModule> | null = null;

/**
 * Public entry point. Idempotent across calls within a session — the
 * imported SDK module is shared; each `vpod start` creates a fresh
 * sandbox from it.
 */
export async function getVpodModule(
  options: { ipk?: IpkResolutionContext } = {}
): Promise<VpodModule> {
  if (!vpodPromise) {
    vpodPromise = loadVpod(options.ipk).catch((err) => {
      vpodPromise = null;
      throw err;
    });
  }
  return vpodPromise;
}

/**
 * Resolve an ipk-installed `@capsule-run/vpod` in the VFS to its package
 * directory + manifest version. Returns `null` on any resolution / read
 * miss so the caller surfaces the canonical guidance error. Exported so
 * resolution is unit-testable without importing the SDK.
 */
export async function tryResolveVpodFromNodeModules(
  ipk: IpkResolutionContext
): Promise<{ pkgDir: string; version: string } | null> {
  let resolved;
  try {
    resolved = await ipkResolve(`${VPOD_PACKAGE}/package.json`, ipk.fromDir, ipk.reader);
  } catch {
    return null;
  }
  if (resolved.type !== 'file') return null;
  const pkgDir = splitPath(resolved.path).dir;
  if (!(await ipk.reader.exists(`${pkgDir}/dist/index.js`))) return null;
  try {
    const manifest = await ipk.reader.readFile(resolved.path);
    const version = String(JSON.parse(manifest).version ?? VPOD_PINNED_VERSION);
    return { pkgDir, version };
  } catch {
    return null;
  }
}

async function loadVpod(ipk?: IpkResolutionContext): Promise<VpodModule> {
  if (isNodeRuntime()) {
    // Node / vitest never boots a sandbox — lifecycle tests inject a
    // fake SDK via `createVpodCommand({ loadSdk })`. Surface a clear
    // error if a caller still tries.
    throw new Error('vpod is not available in Node runtime');
  }
  if (!ipk) throw new Error(VPOD_NOT_INSTALLED);
  const resolved = await tryResolveVpodFromNodeModules(ipk);
  if (!resolved) throw new Error(VPOD_NOT_INSTALLED);

  // Import the browser entry through the preview SW so `import.meta.url`
  // inside the SDK is a real hierarchical same-origin URL and its own
  // asset auto-discovery (`setAssetBaseUrl(directoryOf(import.meta.url))`)
  // finds the worker/component/wasm siblings without any explicit URLs.
  // The `/* @vite-ignore */` keeps Vite from resolving the runtime URL
  // at build time (same pattern as the pyodide core loader).
  const entryUrl = toPreviewUrl(`${resolved.pkgDir}/dist/index.js`);
  const sdk = (await import(/* @vite-ignore */ entryUrl)) as Partial<VpodSdk>;
  if (typeof sdk.Sandbox?.create !== 'function') {
    throw new Error('vpod: installed package did not export a Sandbox with create()');
  }
  return { sdk: sdk as VpodSdk, version: resolved.version };
}

/**
 * Drop the cached module promise so the next `getVpodModule` call
 * rebuilds from scratch. Test-only.
 */
export function resetVpodForTests(): void {
  vpodPromise = null;
}
