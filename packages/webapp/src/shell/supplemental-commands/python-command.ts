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

import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { runInRealm } from '../../kernel/realm/realm-runner.js';
import type { RealmFactory } from '../../kernel/realm/realm-runner.js';
import {
  createDefaultRealmFactory,
  resolvePyodideIndexURL,
} from '../../kernel/realm/realm-factory.js';
import type { ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';

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
    let procArgv: string[] = [name];
    let sysArgv: string[] = [name];

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
    } else if (ctx.stdin.trim().length > 0) {
      code = ctx.stdin;
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

    const pm = options ? lookupGlobalPm() : null;
    const owner: ProcessOwner = { kind: 'system' };
    const realmFactory = options.realmFactory ?? createDefaultRealmFactory();
    const pyodideIndexURL = options.pyodideIndexURL ?? resolvePyodideIndexURL();

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
        stdin: ctx.stdin,
        pyodideIndexURL,
        pyodideSyncDirs: syncDirs,
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
      stdin: ctx.stdin,
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

let _ephemeralPm: ProcessManager | null = null;
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
  pyodideSyncDirs: string[];
}) {
  if (!_ephemeralPm) {
    const { ProcessManager: PM } = await import('../../kernel/process-manager.js');
    _ephemeralPm = new PM();
  }
  return runInRealm({
    pm: _ephemeralPm,
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
    pyodideSyncDirs: args.pyodideSyncDirs,
    procKind: 'py',
  });
}
