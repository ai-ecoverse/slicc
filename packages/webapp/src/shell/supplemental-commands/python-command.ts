/**
 * `python` / `python3` command — runs Python code via Pyodide
 * inside a `kind:'py'` realm. SIGKILL terminates the realm worker
 * synchronously (`worker.terminate()`), so a runaway
 * `while True: pass` exits 137 in ~50 ms — the same hard-kill
 * guarantee `node -e` provides.
 *
 * The realm worker (`kernel/realm/py-realm-worker.ts`) handles
 * `loadPyodide`, VFS↔Pyodide-FS sync via the `vfs` RPC channel,
 * `setStdin`/`setStdout`/`setStderr` capture, and the
 * `__slicc_exit_code` extraction. This file just parses argv,
 * resolves the indexURL, and hands off.
 *
 * Pyodide cold-start is ~1-2 s on first call (no warm pool yet —
 * follow-up). Documented in plan §Risks.
 */

import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';
import {
  createDefaultRealmFactory,
  resolvePyodideIndexURL,
} from '../../kernel/realm/realm-factory.js';
import type { RealmFactory } from '../../kernel/realm/realm-runner.js';
import { runInRealm } from '../../kernel/realm/realm-runner.js';
import type { RealmMountPoint } from '../../kernel/realm/realm-types.js';
import { stdinAsText } from '../just-bash-compat.js';

/**
 * Top-level names reserved by Pyodide/Emscripten. Mounting OPFS over
 * any of these shadows Pyodide's own writable scratch dir, its
 * built-in module tree, or the device pseudo-fs. `/tmp` is excluded
 * here because we always include `/tmp` explicitly via the
 * `OPFS_SYNC_FS` plugin (Pyodide's MEMFS `/tmp` would otherwise lose
 * write-back to the kernel VFS). `bin`, `usr`, `etc` belong to no
 * VFS root today but are reserved defensively so a future top-level
 * `/usr` or `/bin` directory doesn't silently clobber the realm.
 */
const PYODIDE_BUILTIN_ROOT_NAMES = new Set([
  'dev',
  'proc',
  'lib',
  'bin',
  'usr',
  'etc',
  'home',
  'tmp',
]);

/**
 * Build the list of absolute VFS directories to mount into the
 * Python realm. Enumerates `/` via `fs.readdir`, keeps only
 * directories, drops Pyodide/Emscripten built-in names, then always
 * appends `/tmp` so the realm has a writable scratch dir whose
 * mutations flush back through `OPFS_SYNC_FS`.
 *
 * Mounting the full non-conflicting VFS root (regardless of cwd) lets
 * Python read `/workspace`, `/shared`, `/scoops`, `/sessions`, … by
 * absolute path from any cwd. The legacy `[cwd, '/tmp']` restriction
 * was a hedge against the cost of the pre-OPFS `walkTree` sync path;
 * under `OPFS_SYNC_FS` mount setup is cheap and bounded to the
 * `slicc-fs` subtree (external/remote mounts live elsewhere and are
 * not preloaded).
 *
 * Failures enumerating `/` (e.g. a vfs adapter without `readdir`)
 * collapse to `['/tmp']` — better to lose absolute-path coverage than
 * to crash the command.
 */
export async function computePyodideMountDirs(
  fs: CommandContext['fs'],
  builtins: ReadonlySet<string> = PYODIDE_BUILTIN_ROOT_NAMES
): Promise<string[]> {
  const dirs: string[] = [];
  const seen = new Set<string>();
  try {
    const names = await fs.readdir('/');
    for (const name of names) {
      if (!name || name.includes('/')) continue;
      if (builtins.has(name)) continue;
      const abs = `/${name}`;
      let isDir = false;
      try {
        const st = await fs.stat(abs);
        isDir = !!st.isDirectory;
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      dirs.push(abs);
    }
  } catch {
    /* enumeration failure → fall through to /tmp-only mount */
  }
  if (!seen.has('/tmp')) {
    seen.add('/tmp');
    dirs.push('/tmp');
  }
  return dirs;
}

/**
 * Compute the set of user-visible VFS mount points that overlap any
 * of `syncDirs`. A mount overlaps when its path is exactly a syncDir,
 * is contained within a syncDir, or is an ancestor of a syncDir. Each
 * overlapping mount is tagged with its backend `kind` (informational
 * only — every kind bombs identically on sync access). Internal
 * mounts (`/proc`, …) are skipped by `VirtualFS.listMountPoints`.
 *
 * Returns `[]` when the wrapped FS doesn't expose `listMountPoints`
 * (test stubs, scoop-restricted FS) — the realm then runs with no
 * bomb overlays and the OPFS placeholder is what Python sees.
 */
export function computeOverlappingMountPoints(
  fs: CommandContext['fs'],
  syncDirs: readonly string[]
): RealmMountPoint[] {
  const wrapped = fs as unknown as {
    listMountPoints?: () => { path: string; kind: 'local' | 's3' | 'da' | 'proc' }[];
  };
  if (typeof wrapped.listMountPoints !== 'function') return [];
  const overlap = (mountPath: string): boolean => {
    for (const dir of syncDirs) {
      if (mountPath === dir) return true;
      if (mountPath.startsWith(dir === '/' ? '/' : dir + '/')) return true;
      if (dir.startsWith(mountPath + '/')) return true;
    }
    return false;
  };
  const out: RealmMountPoint[] = [];
  for (const entry of wrapped.listMountPoints()) {
    if (entry.kind === 'proc') continue;
    if (!overlap(entry.path)) continue;
    out.push({ path: entry.path, kind: entry.kind });
  }
  return out;
}

/**
 * The kernel worker's VFS lives at `OPFS-root/slicc-fs/`. We pass
 * the dbName through `RealmInitMsg.opfsMountDbName` so the Python
 * realm worker (a separate `DedicatedWorker`) can resolve the same
 * OPFS subtree and mount it via the in-tree `OPFS_SYNC_FS` plugin.
 * The dbName mirrors `Orchestrator`'s primary
 * `VirtualFS.create({ dbName: 'slicc-fs' })` call site — kept in
 * sync explicitly rather than imported to avoid pulling the
 * orchestrator into this command.
 *
 * Production always selects OPFS so the dbName is always set. The
 * capability check exists only so Node-based test environments
 * without `navigator.storage.getDirectory` fall through to the
 * legacy `walkTree` sync path (same env-fallback used by
 * `resolveVfsBackendFromEnv`).
 */
const OPFS_KERNEL_DB_NAME = 'slicc-fs';

function resolveOpfsMountDbName(): string | undefined {
  try {
    const storage = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } })
      .navigator?.storage;
    if (typeof storage?.getDirectory === 'function') return OPFS_KERNEL_DB_NAME;
  } catch {
    /* navigator may be unavailable in some test contexts */
  }
  return undefined;
}

export interface PythonCommandOptions {
  /**
   * Override the realm factory. Default: `createDefaultRealmFactory()`
   * — picks the Pyodide DedicatedWorker realm in both standalone
   * and extension modes (Pyodide is WASM, only needs
   * `wasm-unsafe-eval`). Tests can inject a mock.
   */
  realmFactory?: RealmFactory;
  /** Override the indexURL used by `loadPyodide`. */
  pyodideIndexURL?: string;
}

function pythonHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: python3 [-c code | script.py] [args...]\n',
    stderr: '',
    exitCode: 0,
  };
}

function pythonVersion(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'Python 3.12 (Pyodide)\n',
    stderr: '',
    exitCode: 0,
  };
}

export function createPython3LikeCommand(
  name: 'python3' | 'python',
  options: PythonCommandOptions = {}
): Command {
  return defineCommand(name, async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) return pythonHelp();
    if (args.includes('--version') || args.includes('-V')) return pythonVersion();

    let code = '';
    let filename = '<stdin>';
    // Two argv forms — `procArgv` for the kernel process record
    // (what `ps` shows) and `sysArgv` for `sys.argv` inside the
    // Python realm. They differ for `python3 -c CODE` because
    // POSIX Python sets `sys.argv[0] = '-c'`, but `ps`-style
    // displays read better with the full `python3 -c CODE…` form.
    // Both are assigned in every non-returning branch below.
    let procArgv: string[];
    let sysArgv: string[];

    if (args[0] === '-c') {
      if (!args[1]) {
        return {
          stdout: '',
          stderr: `${name}: option requires an argument -- 'c'\n`,
          exitCode: 2,
        };
      }
      code = args[1];
      filename = '-c';
      sysArgv = ['-c', ...args.slice(2)];
      procArgv = [name, '-c', code, ...args.slice(2)];
    } else if (args.length > 0 && !args[0].startsWith('-')) {
      const scriptArg = args[0];
      const scriptPath = ctx.fs.resolvePath(ctx.cwd, scriptArg);
      if (!(await ctx.fs.exists(scriptPath))) {
        return {
          stdout: '',
          stderr: `${name}: can't open file '${scriptArg}': [Errno 2] No such file or directory\n`,
          exitCode: 2,
        };
      }
      code = await ctx.fs.readFile(scriptPath);
      filename = scriptArg;
      sysArgv = [scriptArg, ...args.slice(1)];
      procArgv = [name, scriptArg, ...args.slice(1)];
    } else if (stdinAsText(ctx.stdin).trim().length > 0) {
      code = stdinAsText(ctx.stdin);
      filename = '<stdin>';
      sysArgv = ['<stdin>'];
      procArgv = [name];
    } else if (args.length > 0) {
      return {
        stdout: '',
        stderr: `${name}: unsupported option '${args[0]}'\n`,
        exitCode: 2,
      };
    } else {
      return {
        stdout: '',
        stderr: `${name}: no input provided (use -c CODE, script path, or stdin)\n`,
        exitCode: 2,
      };
    }

    // Mount the full non-conflicting VFS root so Python can read
    // any top-level directory (`/workspace`, `/shared`, `/scoops`,
    // `/sessions`, …) by absolute path regardless of cwd. Built-in
    // names (`dev`/`proc`/`lib`/`bin`/`usr`/`etc`/`home`/`tmp`) are
    // dropped so we don't shadow Pyodide's writable scratch dir or
    // its module tree; `/tmp` is appended explicitly so its writes
    // flush back through `OPFS_SYNC_FS`. The realm worker syncs
    // VFS→Pyodide-FS before exec and Pyodide-FS→VFS after, so file
    // writes from Python persist back through the kernel's VFS.
    const syncDirs = await computePyodideMountDirs(ctx.fs);
    // Tag every mount that overlaps the sync dirs with its backend
    // `kind`. The realm overlays a throwing FS plugin at each path
    // so any synchronous Python access raises an OSError directing
    // the caller at the async `slicc.fs` module.
    const mountPoints = computeOverlappingMountPoints(ctx.fs, syncDirs);

    const pm = options ? lookupGlobalPm() : null;
    const owner: ProcessOwner = { kind: 'system' };
    const realmFactory = options.realmFactory ?? createDefaultRealmFactory();
    const pyodideIndexURL = options.pyodideIndexURL ?? resolvePyodideIndexURL();
    // When the program source itself was read from piped stdin, the script
    // must not re-read its own code as input — mirror the `node` command's
    // empty-stdin behavior in that branch.
    const realmStdin = filename === '<stdin>' ? '' : stdinAsText(ctx.stdin);
    const opfsMountDbName = resolveOpfsMountDbName();

    if (!pm) {
      return runWithEphemeralPm({
        realmFactory,
        owner,
        code,
        argv: procArgv,
        realmArgv: sysArgv,
        env: Object.fromEntries(ctx.env.entries()),
        cwd: ctx.cwd,
        filename,
        ctx,
        stdin: realmStdin,
        pyodideIndexURL,
        pyodideMountDirs: syncDirs,
        opfsMountDbName,
        mountPoints,
      });
    }

    return runInRealm({
      pm,
      realmFactory,
      owner,
      kind: 'py',
      code,
      argv: procArgv,
      realmArgv: sysArgv,
      env: Object.fromEntries(ctx.env.entries()),
      cwd: ctx.cwd,
      filename,
      ctx,
      stdin: realmStdin,
      pyodideIndexURL,
      pyodideMountDirs: syncDirs,
      opfsMountDbName,
      mountPoints,
      procKind: 'py',
    });
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function lookupGlobalPm(): ProcessManager | null {
  const g = globalThis as Record<string, unknown>;
  const pm = g.__slicc_pm;
  if (
    pm &&
    typeof pm === 'object' &&
    typeof (pm as { spawn?: unknown }).spawn === 'function' &&
    typeof (pm as { onSignal?: unknown }).onSignal === 'function'
  ) {
    return pm as ProcessManager;
  }
  return null;
}

let EphemeralPm: ProcessManager | null = null;
async function runWithEphemeralPm(args: {
  realmFactory: RealmFactory;
  owner: ProcessOwner;
  code: string;
  argv: string[];
  realmArgv?: string[];
  env: Record<string, string>;
  cwd: string;
  filename: string;
  ctx: Parameters<typeof runInRealm>[0]['ctx'];
  stdin?: string;
  pyodideIndexURL: string;
  pyodideMountDirs: string[];
  opfsMountDbName: string | undefined;
  mountPoints?: RealmMountPoint[];
}) {
  if (!EphemeralPm) {
    const { ProcessManager: PM } = await import('../../kernel/process-manager.js');
    EphemeralPm = new PM();
  }
  return runInRealm({
    pm: EphemeralPm,
    realmFactory: args.realmFactory,
    owner: args.owner,
    kind: 'py',
    code: args.code,
    argv: args.argv,
    realmArgv: args.realmArgv,
    env: args.env,
    cwd: args.cwd,
    filename: args.filename,
    ctx: args.ctx,
    stdin: args.stdin,
    pyodideIndexURL: args.pyodideIndexURL,
    pyodideMountDirs: args.pyodideMountDirs,
    mountPoints: args.mountPoints,
    opfsMountDbName: args.opfsMountDbName,
    procKind: 'py',
  });
}
