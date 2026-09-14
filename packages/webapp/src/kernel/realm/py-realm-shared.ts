import type { SecureFetch } from 'just-bash';
import type { PyodideInterface } from 'pyodide';
import { version as pyodidePackageVersion } from 'pyodide/package.json';
import type { VirtualFS } from '../../fs/index.js';
import { splitPath } from '../../fs/path-utils.js';
import { fetchAndVerify } from '../../shell/di/fetcher.js';
import {
  findManifestDir,
  type LockEntry,
  loadPyproject,
  loadUvLock,
  normalizePackageName,
  splitDependency,
} from '../../shell/di/manifest.js';
import { resolve as ipkResolve, type ModuleReader } from '../../shell/ipk/resolver.js';
import {
  resolvePinnedPackageVersion,
  toPreviewUrl,
} from '../../shell/supplemental-commands/shared.js';
import { installMountBombs } from './mount-bomb-fs.js';
import {
  createBufferedOpfsSahProvider,
  createOpfsSyncFs,
  flushPendingOpfsOps,
  type OpfsMount,
  type OpfsSyncFilesystems,
  type OpfsSyncFsPlugin,
  prewalkOpfsTree,
} from './opfs-sync-fs.js';
import { installPythonMountGuard } from './python-mount-guard.js';
import { type RealmPortLike, RealmRpcClient } from './realm-rpc.js';
import type {
  RealmDoneMsg,
  RealmErrorMsg,
  RealmInitMsg,
  RealmMountPoint,
  SerializedFetchResponse,
} from './realm-types.js';
import { registerSliccFsModule } from './slicc-fs-module.js';

export const PYODIDE_VERSION = resolvePinnedPackageVersion('pyodide', pyodidePackageVersion);

export const PYODIDE_RUNTIME_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export const PYODIDE_NOT_INSTALLED = `pyodide is not installed in node_modules: run \`ipk add pyodide@${PYODIDE_VERSION}\` (no network fallback)`;

const PYODIDE_ASSET_FILES = {
  asmJs: 'pyodide.asm.mjs',
  asmWasm: 'pyodide.asm.wasm',
  stdlibZip: 'python_stdlib.zip',
  lockJson: 'pyodide-lock.json',
} as const;

export async function tryResolvePyodideAssetRoot(ipk: {
  reader: ModuleReader;
  fromDir: string;
}): Promise<string | null> {
  let resolved;
  try {
    resolved = await ipkResolve('pyodide/package.json', ipk.fromDir, ipk.reader);
  } catch {
    return null;
  }
  if (resolved.type !== 'file') return null;
  const pkgDir = splitPath(resolved.path).dir;
  for (const file of Object.values(PYODIDE_ASSET_FILES)) {
    if (!(await ipk.reader.exists(`${pkgDir}/${file}`))) return null;
  }
  return pkgDir;
}

export interface PyodideAssetBytes {
  asmJsSource: string;
  asmWasmBytes: Uint8Array;
  stdlibBytes: Uint8Array;
  lockJsonString: string;
}

export async function loadPyodideAssetsViaRpc(
  rpc: RealmRpcClient,
  assetRoot: string
): Promise<PyodideAssetBytes | null> {
  try {
    const [asmJsSource, asmWasmRaw, stdlibRaw, lockJsonString] = await Promise.all([
      rpc.call<string>('vfs', 'readFile', [`${assetRoot}/${PYODIDE_ASSET_FILES.asmJs}`]),
      rpc.call<Uint8Array | ArrayBuffer>('vfs', 'readFileBinary', [
        `${assetRoot}/${PYODIDE_ASSET_FILES.asmWasm}`,
      ]),
      rpc.call<Uint8Array | ArrayBuffer>('vfs', 'readFileBinary', [
        `${assetRoot}/${PYODIDE_ASSET_FILES.stdlibZip}`,
      ]),
      rpc.call<string>('vfs', 'readFile', [`${assetRoot}/${PYODIDE_ASSET_FILES.lockJson}`]),
    ]);
    return {
      asmJsSource,
      asmWasmBytes: asmWasmRaw instanceof Uint8Array ? asmWasmRaw : new Uint8Array(asmWasmRaw),
      stdlibBytes: stdlibRaw instanceof Uint8Array ? stdlibRaw : new Uint8Array(stdlibRaw),
      lockJsonString,
    };
  } catch {
    return null;
  }
}

export function installPyodideAsmWasmFetchShim(
  indexURL: string,
  wasmBytes: Uint8Array
): { restore: () => void } {
  const targetUrl = indexURL + PYODIDE_ASSET_FILES.asmWasm;
  const origFetch = globalThis.fetch;
  let active = true;
  const shimmed: typeof globalThis.fetch = (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url === targetUrl) {
      return Promise.resolve(
        new Response(wasmBytes as unknown as BodyInit, {
          headers: { 'Content-Type': 'application/wasm' },
        })
      );
    }
    return origFetch(input, init);
  };
  globalThis.fetch = shimmed;
  return {
    restore: (): void => {
      if (!active) return;
      active = false;

      if (globalThis.fetch === shimmed) globalThis.fetch = origFetch;
    },
  };
}

export const PYTHON_RUNNER = `
import sys
import traceback

__slicc_exit_code = 0
try:
    sys.argv = __slicc_argv
    exec(compile(__slicc_code, __slicc_filename, "exec"), {"__name__": "__main__", "__file__": __slicc_filename})
except SystemExit as exc:
    code = exc.code
    if code is None:
        __slicc_exit_code = 0
    elif isinstance(code, int):
        __slicc_exit_code = code
    else:
        print(code, file=sys.stderr)
        __slicc_exit_code = 1
except BaseException:
    traceback.print_exc()
    __slicc_exit_code = 1
`;

export async function loadPyodideFromVfsAssets(
  mod: typeof import('pyodide'),
  assetRoot: string,
  rpc: RealmRpcClient
): Promise<PyodideInterface> {
  const assets = await loadPyodideAssetsViaRpc(rpc, assetRoot);
  if (!assets) throw new Error(PYODIDE_NOT_INSTALLED);

  const coreJsBlobUrl = URL.createObjectURL(
    new Blob([assets.asmJsSource], { type: 'text/javascript' })
  );

  type PyodideConfig = NonNullable<Parameters<typeof mod.loadPyodide>[0]>;
  type CreatePyodideModuleFn = PyodideConfig['createPyodideModule'];
  const stdlibBlobUrl = URL.createObjectURL(
    new Blob([assets.stdlibBytes as unknown as BlobPart], { type: 'application/zip' })
  );

  const indexURL = `slicc-pyodide://local/${crypto.randomUUID()}/`;
  const shim = installPyodideAsmWasmFetchShim(indexURL, assets.asmWasmBytes);
  try {
    const asmModule = (await import(/* @vite-ignore */ coreJsBlobUrl)) as {
      default: CreatePyodideModuleFn;
    };
    return await mod.loadPyodide({
      indexURL,
      lockFileContents: assets.lockJsonString,
      stdLibURL: stdlibBlobUrl,
      createPyodideModule: asmModule.default,

      packageBaseUrl: toPreviewUrl('/workspace/python_wheels/'),
    });
  } finally {
    shim.restore();
    URL.revokeObjectURL(coreJsBlobUrl);
    URL.revokeObjectURL(stdlibBlobUrl);
  }
}

export async function runPyRealm(
  init: RealmInitMsg,
  port: RealmPortLike,
  loaderImport: () => Promise<typeof import('pyodide')> = () => import('pyodide')
): Promise<void> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const rpc = new RealmRpcClient(port);

  let pyodide: PyodideInterface;
  try {
    const mod = await loaderImport();
    pyodide = init.pyodideAssetRoot
      ? await loadPyodideFromVfsAssets(mod, init.pyodideAssetRoot, rpc)
      : await mod.loadPyodide({
          indexURL: init.pyodideIndexURL,
        });
  } catch (err) {
    rpc.dispose();
    const message = err instanceof Error ? err.message : String(err);
    const errMsg: RealmErrorMsg = {
      type: 'realm-error',
      message: `loadPyodide: ${message}`,
    };
    port.postMessage(errMsg);
    return;
  }

  const pushWarning = (msg: string): void => {
    stderrChunks.push(`Warning: ${msg}\n`);
  };

  let opfsMounts: OpfsRealmMount[] = [];
  let exitCode: number;
  try {
    await preloadMicropip(
      pyodide,
      rpc,
      pushWarning,
      resolvePyodideLockfilePath(init.pyodideAssetRoot)
    );

    opfsMounts = await mountOpfsIfNeeded(pyodide, init, pushWarning);
    await installMountOverlays(pyodide, init, pushWarning);

    await activateManifest(pyodide, rpc, init, pushWarning);

    await registerSliccFsModuleSafe(pyodide, rpc, pushWarning);

    try {
      pyodide.FS.chdir(init.cwd);
    } catch {}

    configurePyodideIo(pyodide, init, stdoutChunks, stderrChunks);

    exitCode = await executePythonCode(pyodide, stderrChunks);

    await flushOpfsIfNeeded(opfsMounts, init, rpc, pushWarning);
  } catch (err) {
    rpc.dispose();
    const message = err instanceof Error ? err.message : String(err);
    const errMsg: RealmErrorMsg = {
      type: 'realm-error',
      message: `${message}${stderrChunks.length ? `\n${stderrChunks.join('')}` : ''}`,
    };
    port.postMessage(errMsg);
    return;
  }

  rpc.dispose();
  const done: RealmDoneMsg = {
    type: 'realm-done',
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  };
  port.postMessage(done);
}

const PYTHON_WHEELS_DIR = '/workspace/python_wheels';

async function preloadMicropip(
  pyodide: PyodideInterface,
  rpc: RealmRpcClient,
  pushWarning: WarningSink,
  lockfilePath: string
): Promise<void> {
  await ensureMicropipWheelStaged(rpc, pushWarning, lockfilePath);
  try {
    await pyodide.loadPackage(['micropip']);
  } catch (err) {
    pushWarning(`micropip preload failed: ${describeRealmError(err)}`);
  }
}

const PYODIDE_LOCKFILE_VFS_PATH = '/workspace/node_modules/pyodide/pyodide-lock.json';

export function resolvePyodideLockfilePath(assetRoot: string | undefined): string {
  return assetRoot ? `${assetRoot}/${PYODIDE_ASSET_FILES.lockJson}` : PYODIDE_LOCKFILE_VFS_PATH;
}

const MICROPIP_FETCH_TIMEOUT_MS = 10_000;

const micropipStagingCache = new WeakMap<RealmRpcClient, Promise<void>>();

function ensureMicropipWheelStaged(
  rpc: RealmRpcClient,
  pushWarning: WarningSink,
  lockfilePath: string
): Promise<void> {
  const cached = micropipStagingCache.get(rpc);
  if (cached) return cached;
  const promise = stageMicropipWheel(rpc, pushWarning, lockfilePath);
  micropipStagingCache.set(rpc, promise);
  return promise;
}

interface MicropipLockEntry {
  name?: string;
  file_name?: string;
  sha256?: string;
}

async function stageMicropipWheel(
  rpc: RealmRpcClient,
  pushWarning: WarningSink,
  lockfilePath: string
): Promise<void> {
  let entry: MicropipLockEntry | undefined;
  try {
    if (!(await rpc.call<boolean>('vfs', 'exists', [lockfilePath]))) return;
    const lockText = await rpc.call<string>('vfs', 'readFile', [lockfilePath]);
    const parsed = JSON.parse(lockText) as {
      packages?: Record<string, MicropipLockEntry>;
    };
    for (const [key, candidate] of Object.entries(parsed.packages ?? {})) {
      if (!candidate?.file_name) continue;
      if (normalizePackageName(candidate.name ?? key) === 'micropip') {
        entry = candidate;
        break;
      }
    }
  } catch (err) {
    pushWarning(`micropip wheel staging skipped: ${describeRealmError(err)}`);
    return;
  }
  if (!entry?.file_name || !entry.sha256) return;

  const wheelPath = `${PYTHON_WHEELS_DIR}/${entry.file_name}`;
  try {
    if (await rpc.call<boolean>('vfs', 'exists', [wheelPath])) return;

    const bytes = await fetchAndVerify(createRealmFetch(rpc), {
      url: `${PYODIDE_RUNTIME_CDN}${entry.file_name}`,
      sha256: entry.sha256,
      label: 'micropip wheel',
      timeoutMs: MICROPIP_FETCH_TIMEOUT_MS,
    });
    await rpc.call('vfs', 'mkdir', [PYTHON_WHEELS_DIR]);
    await rpc.call('vfs', 'writeFileBinary', [wheelPath, bytes]);
  } catch (err) {
    pushWarning(`micropip wheel staging failed: ${describeRealmError(err)}`);
  }
}

function createRealmFetch(rpc: RealmRpcClient): SecureFetch {
  return async (url, options) => {
    const init: RequestInit = {
      method: options?.method ?? 'GET',
      ...(options?.headers ? { headers: options.headers } : {}),
      ...(options?.body !== undefined ? { body: options.body } : {}),
    };
    const res = await raceWithTimeout(
      rpc.call<SerializedFetchResponse>('fetch', 'request', [url, init]),
      options?.timeoutMs ?? MICROPIP_FETCH_TIMEOUT_MS,
      url
    );
    return {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      body: res.body instanceof Uint8Array ? res.body : new Uint8Array(res.body),
      url: res.url,
    };
  };
}

function raceWithTimeout<T>(promise: Promise<T>, ms: number, url: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`request to ${url} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function createRealmManifestVfs(rpc: RealmRpcClient): VirtualFS {
  return {
    exists: (path: string) => rpc.call<boolean>('vfs', 'exists', [path]),
    readFile: (path: string) => rpc.call<string>('vfs', 'readFile', [path]),
  } as unknown as VirtualFS;
}

async function activateManifest(
  pyodide: PyodideInterface,
  rpc: RealmRpcClient,
  init: RealmInitMsg,
  pushWarning: WarningSink
): Promise<void> {
  const fs = createRealmManifestVfs(rpc);

  let manifestDir: string | null;
  try {
    manifestDir = await findManifestDir(fs, init.cwd);
  } catch (err) {
    pushWarning(`manifest discovery failed: ${describeRealmError(err)}`);
    return;
  }
  if (manifestDir === null) return;

  let dependencies: string[];
  let lockEntries: LockEntry[];
  try {
    const [project, lock] = await Promise.all([
      loadPyproject(fs, manifestDir),
      loadUvLock(fs, manifestDir),
    ]);
    dependencies = project.dependencies;
    lockEntries = lock;
  } catch (err) {
    pushWarning(`manifest read failed: ${describeRealmError(err)}`);
    return;
  }

  const lockByName = new Map<string, LockEntry>();
  for (const entry of lockEntries) lockByName.set(normalizePackageName(entry.name), entry);

  for (const dep of dependencies) {
    const { name } = splitDependency(dep);
    if (!name) continue;
    const entry = lockByName.get(normalizePackageName(name));
    if (!entry) {
      pushWarning(`no integrity pin for \`${name}\`; run \`di sync\` to repair`);
      continue;
    }
    await activateLockEntry(pyodide, entry, pushWarning);
  }
}

async function activateLockEntry(
  pyodide: PyodideInterface,
  entry: LockEntry,
  pushWarning: WarningSink
): Promise<void> {
  switch (entry.source) {
    case 'pyodide-cdn':
      try {
        await pyodide.loadPackage([entry.name]);
      } catch (err) {
        pushWarning(`activation of \`${entry.name}\` failed: ${describeRealmError(err)}`);
      }
      return;
    case 'pypi':
      try {
        const wheelPath = `${PYTHON_WHEELS_DIR}/${entry.fileName}`;
        await pyodide.runPythonAsync(
          `import micropip; await micropip.install('emfs:${wheelPath}')`
        );
      } catch (err) {
        pushWarning(`activation of \`${entry.name}\` failed: ${describeRealmError(err)}`);
      }
      return;
    default:
      pushWarning(`unknown source \`${entry.source}\` for \`${entry.name}\`; skipping`);
  }
}

async function mountOpfsIfNeeded(
  pyodide: PyodideInterface,
  init: RealmInitMsg,
  pushWarning: WarningSink
): Promise<OpfsRealmMount[]> {
  if (init.opfsMountDbName === undefined) return [];

  const syncDirs = init.pyodideMountDirs ?? [init.cwd, '/tmp'];
  const mountPoints: RealmMountPoint[] = init.mountPoints ?? [];
  const exactMountPaths = new Set(mountPoints.map((m) => m.path));

  try {
    const mounted = await mountOpfsDirsAndSyncIn(
      pyodide,
      syncDirs,
      init.opfsMountDbName,
      pushWarning,
      { skipMountPaths: exactMountPaths }
    );
    return mounted.mounts;
  } catch (err) {
    pushWarning(`VFS→Pyodide OPFS mount failed: ${describeRealmError(err)}`);
    return [];
  }
}

async function installMountOverlays(
  pyodide: PyodideInterface,
  init: RealmInitMsg,
  pushWarning: WarningSink
): Promise<void> {
  const mountPoints: RealmMountPoint[] = init.mountPoints ?? [];
  if (mountPoints.length === 0) return;

  try {
    installMountBombs(
      pyodide.FS as unknown as Parameters<typeof installMountBombs>[0],
      mountPoints.map((mp) => mp.path),
      pushWarning
    );
  } catch (err) {
    pushWarning(`bomb overlay install failed: ${describeRealmError(err)}`);
  }

  try {
    await installPythonMountGuard(
      pyodide,
      mountPoints.map((mp) => mp.path)
    );
  } catch (err) {
    pushWarning(`python mount guard install failed: ${describeRealmError(err)}`);
  }
}

async function registerSliccFsModuleSafe(
  pyodide: PyodideInterface,
  rpc: RealmRpcClient,
  pushWarning: WarningSink
): Promise<void> {
  try {
    await registerSliccFsModule(pyodide, rpc);
  } catch (err) {
    pushWarning(`slicc.fs registration failed: ${describeRealmError(err)}`);
  }
}

function configurePyodideIo(
  pyodide: PyodideInterface,
  init: RealmInitMsg,
  stdoutChunks: string[],
  stderrChunks: string[]
): void {
  pyodide.setStdout({ batched: (msg: string) => stdoutChunks.push(msg + '\n') });
  pyodide.setStderr({ batched: (msg: string) => stderrChunks.push(msg + '\n') });

  let stdinConsumed = false;
  pyodide.setStdin({
    stdin: () => {
      if (stdinConsumed || !init.stdin) return null;
      stdinConsumed = true;
      return init.stdin;
    },
  });
  pyodide.globals.set('__slicc_code', init.code);
  pyodide.globals.set('__slicc_filename', init.filename);
  pyodide.globals.set('__slicc_argv', init.argv);
}

async function executePythonCode(
  pyodide: PyodideInterface,
  stderrChunks: string[]
): Promise<number> {
  let exitCode: number;
  try {
    await pyodide.runPythonAsync(PYTHON_RUNNER);
    const raw = pyodide.globals.get('__slicc_exit_code');
    exitCode = typeof raw === 'number' ? raw : Number(raw ?? 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderrChunks.push(`${message}\n`);
    exitCode = 1;
  }

  try {
    pyodide.runPython('del __slicc_code, __slicc_filename, __slicc_argv, __slicc_exit_code');
  } catch {}
  return exitCode;
}

async function flushOpfsIfNeeded(
  opfsMounts: OpfsRealmMount[],
  init: RealmInitMsg,
  rpc: RealmRpcClient,
  pushWarning: WarningSink
): Promise<void> {
  if (init.opfsMountDbName === undefined) return;

  try {
    await flushOpfsRealmMounts(opfsMounts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushWarning(`Pyodide→VFS OPFS flush failed: ${message}`);
  }

  try {
    await invalidateDirtyPathsInKernelVfs(opfsMounts, rpc);
  } catch (err) {
    pushWarning(`Pyodide→kernel VFS invalidation failed: ${describeRealmError(err)}`);
  }
}

type WarningSink = (message: string) => void;

const EMSCRIPTEN_BUILTIN_ROOT_DIRS = new Set(['dev', 'proc', 'lib', 'tmp', 'home']);

export function describeRealmError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown; errno?: unknown; code?: unknown };
    const hasErrno = typeof e.errno === 'number';
    const hasCode = typeof e.code === 'string';
    if (hasErrno || hasCode) {
      const name = typeof e.name === 'string' && e.name ? e.name : 'Error';
      const message = typeof e.message === 'string' ? e.message : '';
      const detail: string[] = [];
      if (hasErrno) detail.push(`errno ${e.errno as number}`);
      if (hasCode) detail.push(e.code as string);
      const suffix = detail.length ? ` (${detail.join(', ')})` : '';
      return message ? `${name}: ${message}${suffix}` : `${name}${suffix}`;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface OpfsRealmMount {
  pyPath: string;
  mount: OpfsMount;
  rootHandle: FileSystemDirectoryHandle;
  flushBuffers: (rootHandle: FileSystemDirectoryHandle) => Promise<void>;
  getDirtyPaths: () => string[];
}

export interface MountedOpfsResult {
  mounts: OpfsRealmMount[];
}

function ensureOpfsSyncFsRegistered(pyodide: PyodideInterface): OpfsSyncFsPlugin {
  const filesystems = (pyodide.FS as unknown as { filesystems: OpfsSyncFilesystems }).filesystems;
  let plugin = filesystems.OPFS_SYNC_FS;
  if (!plugin) {
    plugin = createOpfsSyncFs(pyodide.FS as unknown as Parameters<typeof createOpfsSyncFs>[0]);
    filesystems.OPFS_SYNC_FS = plugin;
  }
  return plugin;
}

export async function mountOpfsDirsAndSyncIn(
  pyodide: PyodideInterface,
  dirs: string[],
  opfsDbName: string,
  pushWarning: WarningSink = () => {},
  opts: { skipMountPaths?: ReadonlySet<string> } = {}
): Promise<MountedOpfsResult> {
  const mounts: OpfsRealmMount[] = [];
  const skip = opts.skipMountPaths ?? new Set<string>();
  const storage = (navigator as unknown as { storage?: StorageManager }).storage;
  if (!storage?.getDirectory) {
    pushWarning('VFS→Pyodide OPFS mount skipped: navigator.storage.getDirectory unavailable');
    return { mounts };
  }
  let opfsRoot: FileSystemDirectoryHandle;
  try {
    opfsRoot = await storage.getDirectory();
  } catch (err) {
    pushWarning(`VFS→Pyodide OPFS mount: getDirectory() failed: ${describeRealmError(err)}`);
    return { mounts };
  }
  let kernelDbHandle: FileSystemDirectoryHandle;
  try {
    kernelDbHandle = await opfsRoot.getDirectoryHandle(opfsDbName, { create: true });
  } catch (err) {
    pushWarning(
      `VFS→Pyodide OPFS mount: opening '${opfsDbName}' failed: ${describeRealmError(err)}`
    );
    return { mounts };
  }

  const plugin = ensureOpfsSyncFsRegistered(pyodide);

  for (const dir of dirs) {
    if (dir === '/') {
      await mountRootChildren(pyodide, plugin, kernelDbHandle, skip, mounts, pushWarning);
      continue;
    }
    if (skip.has(dir)) continue;
    try {
      let handle: FileSystemDirectoryHandle = kernelDbHandle;
      for (const part of dir.split('/').filter(Boolean)) {
        handle = await handle.getDirectoryHandle(part, { create: true });
      }
      await mountOpfsChild(pyodide, plugin, dir, handle, mounts);
    } catch (err) {
      pushWarning(`VFS→Pyodide OPFS mount '${dir}' failed: ${describeRealmError(err)}`);
    }
  }

  return { mounts };
}

async function mountRootChildren(
  pyodide: PyodideInterface,
  plugin: OpfsSyncFsPlugin,
  kernelDbHandle: FileSystemDirectoryHandle,
  skip: ReadonlySet<string>,
  mounts: OpfsRealmMount[],
  pushWarning: WarningSink
): Promise<void> {
  try {
    const iter = kernelDbHandle as unknown as AsyncIterable<
      [string, FileSystemDirectoryHandle | FileSystemFileHandle]
    >;
    for await (const [name, childHandle] of iter) {
      if ((childHandle as { kind: string }).kind !== 'directory') continue;
      if (EMSCRIPTEN_BUILTIN_ROOT_DIRS.has(name)) continue;
      const childPath = `/${name}`;

      if (skip.has(childPath)) continue;
      try {
        await mountOpfsChild(
          pyodide,
          plugin,
          childPath,
          childHandle as FileSystemDirectoryHandle,
          mounts
        );
      } catch (err) {
        pushWarning(`VFS→Pyodide OPFS mount '${childPath}' failed: ${describeRealmError(err)}`);
      }
    }
  } catch (err) {
    pushWarning(`VFS→Pyodide OPFS mount '/' failed: ${describeRealmError(err)}`);
  }
}

async function mountOpfsChild(
  pyodide: PyodideInterface,
  plugin: OpfsSyncFsPlugin,
  pyPath: string,
  handle: FileSystemDirectoryHandle,
  mounts: OpfsRealmMount[]
): Promise<void> {
  try {
    pyodide.FS.stat(pyPath);
  } catch {
    pyodide.FS.mkdirTree(pyPath);
  }
  const prewalk = await prewalkOpfsTree(handle);
  const buffered = createBufferedOpfsSahProvider();
  await buffered.preload(prewalk);
  const opts = { rootHandle: handle, prewalk, sahProvider: buffered.provider };
  const fsMount = pyodide.FS as unknown as {
    mount: (plugin: OpfsSyncFsPlugin, opts: unknown, dir: string) => unknown;
  };
  const rootNode = fsMount.mount(plugin, opts, pyPath) as { mount?: OpfsMount } | undefined;
  const mount =
    rootNode?.mount ??
    ({ opts, mountpoint: pyPath, root: rootNode as never } as unknown as OpfsMount);
  mounts.push({
    pyPath,
    mount,
    rootHandle: handle,
    flushBuffers: buffered.flush,
    getDirtyPaths: buffered.getDirtyPaths,
  });
}

export async function flushOpfsRealmMounts(mounts: OpfsRealmMount[]): Promise<void> {
  for (const entry of mounts) {
    await flushPendingOpfsOps(entry.mount);
    await entry.flushBuffers(entry.rootHandle);
  }
}

async function invalidateDirtyPathsInKernelVfs(
  mounts: OpfsRealmMount[],
  rpc: RealmRpcClient
): Promise<void> {
  const absPaths: string[] = [];
  for (const entry of mounts) {
    for (const relPath of entry.getDirtyPaths()) {
      absPaths.push(entry.pyPath === '/' ? `/${relPath}` : `${entry.pyPath}/${relPath}`);
    }
  }
  if (absPaths.length > 0) {
    await rpc.call('vfs', 'invalidatePaths', [absPaths]);
  }
}
