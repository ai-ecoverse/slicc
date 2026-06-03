/**
 * `python` / `python3` command — runs Python code via Pyodide
 * inside a `kind:'py'` realm. SIGKILL terminates the realm worker
 * synchronously (`worker.terminate()`), so a runaway
 * `while True: pass` exits 137 in ~50 ms — the same hard-kill
 * guarantee `node -e` got from Phase 8.
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

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';
import { createPyRealmPool } from '../../kernel/realm/py-realm-pool.js';
import {
  createDefaultRealmFactory,
  resolvePyodideIndexURL,
} from '../../kernel/realm/realm-factory.js';
import type { RealmFactory, RealmPool } from '../../kernel/realm/realm-runner.js';
import { runInPooledRealm, runInRealm } from '../../kernel/realm/realm-runner.js';
import { stdinAsText } from '../just-bash-compat.js';

export interface PythonCommandOptions {
  /**
   * Override the realm factory. When set, the command runs the
   * one-shot path (`runInRealm` — fresh realm per call, terminated
   * after) instead of the warm pool. Tests inject a mock realm here;
   * production leaves it unset so `python` reuses warm Pyodide
   * workers from the pool.
   */
  realmFactory?: RealmFactory;
  /**
   * Override the warm realm pool. Default: a process-wide singleton
   * built on `createDefaultRealmFactory()`. Tests inject a pool over
   * a mock/in-process factory; ignored when `realmFactory` is set.
   */
  pool?: RealmPool;
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

    // Sync directories: cwd, /tmp, and the script's directory
    // when running a file. The realm worker syncs VFS→Pyodide-FS
    // before exec and Pyodide-FS→VFS after, so file writes from
    // Python persist back through the kernel's VFS.
    const syncDirs = [ctx.cwd, '/tmp'];
    if (filename !== '<stdin>' && filename !== '-c') {
      const scriptDir = filename.includes('/')
        ? filename.slice(0, filename.lastIndexOf('/'))
        : ctx.cwd;
      if (!syncDirs.includes(scriptDir)) syncDirs.push(scriptDir);
    }

    const owner: ProcessOwner = { kind: 'system' };
    const pyodideIndexURL = options.pyodideIndexURL ?? resolvePyodideIndexURL();
    // When the program source itself was read from piped stdin, the script
    // must not re-read its own code as input — mirror the `node` command's
    // empty-stdin behavior in that branch.
    const realmStdin = filename === '<stdin>' ? '' : stdinAsText(ctx.stdin);
    const pm = await resolvePm();
    const env = Object.fromEntries(ctx.env.entries());

    // Injected factory → one-shot path (fresh realm per call,
    // terminated after). Backward-compatible surface tests use to
    // drive a mock realm. Otherwise route through the warm pool so
    // the Pyodide interpreter + FS survive between invocations.
    if (options.realmFactory) {
      return runInRealm({
        pm,
        realmFactory: options.realmFactory,
        owner,
        kind: 'py',
        code,
        argv: procArgv,
        realmArgv: sysArgv,
        env,
        cwd: ctx.cwd,
        filename,
        ctx,
        stdin: realmStdin,
        pyodideIndexURL,
        pyodideSyncDirs: syncDirs,
        procKind: 'py',
      });
    }

    const pool = options.pool ?? getGlobalPyRealmPool();
    return runInPooledRealm({
      pm,
      pool,
      owner,
      code,
      argv: procArgv,
      realmArgv: sysArgv,
      env,
      cwd: ctx.cwd,
      filename,
      ctx,
      stdin: realmStdin,
      pyodideIndexURL,
      pyodideSyncDirs: syncDirs,
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

/**
 * Resolve the `ProcessManager`: the kernel-host singleton when wired
 * (`globalThis.__slicc_pm`), else a lazily-built ephemeral one for
 * vitest / headless tooling so `ps` / `kill` still have a registry.
 */
let EphemeralPm: ProcessManager | null = null;
async function resolvePm(): Promise<ProcessManager> {
  const global = lookupGlobalPm();
  if (global) return global;
  if (!EphemeralPm) {
    const { ProcessManager: PM } = await import('../../kernel/process-manager.js');
    EphemeralPm = new PM();
  }
  return EphemeralPm;
}

/**
 * Process-wide warm Pyodide pool. One per JS context (each kernel
 * worker / offscreen agent gets its own), stashed on `globalThis` so
 * a single pool is shared across `WasmShell` instances within the
 * context. Built on the default realm factory, which falls back to
 * the reusable in-process Pyodide realm when no `Worker` is
 * available (vitest / headless).
 */
function getGlobalPyRealmPool(): RealmPool {
  const g = globalThis as { __slicc_py_pool?: RealmPool };
  if (!g.__slicc_py_pool) {
    g.__slicc_py_pool = createPyRealmPool({ factory: createDefaultRealmFactory() });
  }
  return g.__slicc_py_pool;
}
