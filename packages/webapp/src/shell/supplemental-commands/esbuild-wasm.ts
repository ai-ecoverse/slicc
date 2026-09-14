import * as esbuild from 'esbuild-wasm';
import { splitPath } from '../../fs/path-utils.js';
import { compileWasmModule } from '../../kernel/realm/wasm-compiler.js';
import { type ModuleReader, nodeModulesSearchPath, resolve } from '../ipk/resolver.js';
import { GLOBAL_IPK_ADD, isNodeRuntime } from './shared.js';

export const ESBUILD_VERSION = esbuild.version;

export const ESBUILD_INIT_TIMEOUT_MS = 20_000;

export class EsbuildInitStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EsbuildInitStallError';
  }
}

export interface IpkResolutionContext {
  reader: ModuleReader;
  readBytes(absolutePath: string): Promise<Uint8Array>;
  fromDir: string;
}

let esbuildPromise: Promise<typeof esbuild> | null = null;

let esbuildStall: EsbuildInitStallError | null = null;

let initTimeoutMs: number = ESBUILD_INIT_TIMEOUT_MS;

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

export interface EsbuildWasmBinary {
  packageDir: string;

  bytes: Uint8Array;
}

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
    log('esbuild ready (node service)');
    return esbuild;
  }

  if (!ipk) {
    throw new Error(
      `esbuild-wasm is not available: install via \`${GLOBAL_IPK_ADD} esbuild-wasm@${ESBUILD_VERSION}\``
    );
  }
  const binary = await tryLoadEsbuildWasmFromNodeModules(ipk);
  if (!binary) {
    throw new Error(
      `esbuild-wasm is not installed in node_modules: run \`${GLOBAL_IPK_ADD} esbuild-wasm@${ESBUILD_VERSION}\`` +
        ` (searched from ${ipk.fromDir}: ${nodeModulesSearchPath(ipk.fromDir).join(', ')})`
    );
  }
  const bytes = binary.bytes;
  log(`esbuild.wasm loaded from ${binary.packageDir} (${bytes.byteLength} bytes)`);

  const wasmModule = await compileWasmModule(bytes);

  await initializeWithTimeout(wasmModule, binary);
  log('esbuild ready');
  return esbuild;
}

export function resetEsbuildForTests(options: { initTimeoutMs?: number } = {}): void {
  esbuildPromise = null;
  esbuildStall = null;
  initTimeoutMs = options.initTimeoutMs ?? ESBUILD_INIT_TIMEOUT_MS;
}
