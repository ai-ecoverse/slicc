/**
 * `jsh-executor.ts` — entry point for `.jsh` scripts and the
 * `node -e` shell command's JS code path.
 *
 * Post Phase-8 this is a thin wrapper around `runInRealm`. The
 * heavy lifting (AsyncFunction construction, fs/exec/fetch shims,
 * require() pre-fetch) lives in `kernel/realm/js-realm-shared.ts`
 * — both the standalone DedicatedWorker realm
 * (`js-realm-worker.ts`) and the per-task sandbox iframe in
 * extension mode (`sandbox.html`) drive that same code path.
 *
 * The headline win: `node -e 'while(true){}'` and `python -c 'while True: pass'`
 * are now hard-killable via `kill -KILL <pid>` (exit 137 within
 * ~50 ms) because the realm runner's SIGKILL path calls
 * `worker.terminate()` / `iframe.remove()` synchronously.
 */

import type { CommandContext } from 'just-bash';
import { ProcessManager, type ProcessOwner } from '../kernel/process-manager.js';
import { runInRealm } from '../kernel/realm/realm-runner.js';
import type { RealmFactory } from '../kernel/realm/realm-runner.js';
import { createDefaultRealmFactory } from '../kernel/realm/realm-factory.js';
import { createInProcessJsRealmFactory } from '../kernel/realm/realm-inprocess.js';

export interface JshResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Process-tracking config. When supplied, every run registers a
 * `kind:'jsh'` process so `ps` / `kill` / `/proc` see it. The
 * realm runner threads this through automatically.
 */
export interface JshProcessConfig {
  processManager: ProcessManager;
  owner: ProcessOwner;
  getParentPid?: () => number | undefined;
}

export interface JshExecutorOptions {
  /**
   * Override the realm factory. Default: `createDefaultRealmFactory()`
   * — picks worker or iframe per runtime. Tests inject
   * `createInProcessJsRealmFactory()` so they can drive the same
   * code path without a real DedicatedWorker / DOM.
   *
   * Falls back to in-process when no Worker / DOM is available
   * (vitest in node) so callers that don't pass a factory still
   * succeed.
   */
  realmFactory?: RealmFactory;
}

/**
 * Execute a `.jsh` file with Node-like globals. File-existence
 * check happens here so the runner can stay generic.
 */
export async function executeJshFile(
  scriptPath: string,
  args: string[],
  ctx: CommandContext,
  pmConfig?: JshProcessConfig,
  options: JshExecutorOptions = {}
): Promise<JshResult> {
  if (!(await ctx.fs.exists(scriptPath))) {
    return {
      stdout: '',
      stderr: `jsh: cannot find script '${scriptPath}'\n`,
      exitCode: 127,
    };
  }
  const code = await ctx.fs.readFile(scriptPath);
  const argv = ['node', scriptPath, ...args];
  return executeJsCode(code, argv, ctx, pmConfig, { ...options, filename: scriptPath });
}

/**
 * Core JS execution entry. Runs `code` in a realm with `argv` /
 * `ctx.env` / `ctx.cwd` exposed as `process.argv` / `process.env`
 * / `process.cwd()`. Resolves with stdout, stderr, and the exit
 * code (0 on clean run, the script's `process.exit(N)` value, or
 * 1 on uncaught throw, or 137 on SIGKILL).
 */
export async function executeJsCode(
  code: string,
  argv: string[],
  ctx: CommandContext,
  pmConfig?: JshProcessConfig,
  options: JshExecutorOptions & { filename?: string } = {}
): Promise<JshResult> {
  const realmFactory = options.realmFactory ?? pickDefaultRealmFactory();
  // PM resolution:
  //   1. Caller-supplied (WasmShellHeadless threads it for .jsh scripts).
  //   2. globalThis.__slicc_pm (kernel host publishes this so `node -e`,
  //      panel `kill -KILL`, and `ps` all see the same table).
  //   3. Fresh ephemeral PM (vitest / standalone tools that haven't
  //      booted a kernel host).
  const pm = pmConfig?.processManager ?? lookupGlobalPm() ?? lazyEphemeralPm();
  const owner: ProcessOwner = pmConfig?.owner ?? { kind: 'system' };
  const filename = options.filename ?? argv[1] ?? '<eval>';

  const result = await runInRealm({
    pm,
    realmFactory,
    owner,
    kind: 'js',
    code,
    argv,
    env: Object.fromEntries(ctx.env.entries()),
    cwd: ctx.cwd,
    filename,
    // Forward the upstream pipeline's stdin (just-bash exposes it as a
    // string per `CommandContext.stdin`) so `.jsh` scripts and `node`/
    // `node -e` invocations can read piped input via `process.stdin.read()`
    // or the top-level `stdin` parameter.
    stdin: ctx.stdin,
    ctx,
    ppid: pmConfig?.getParentPid?.(),
  });
  return result;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Pick a realm factory based on what's available in the current
 * runtime. Production paths (WasmShellHeadless) thread the explicit
 * factory in via `WasmShellOptions`; this fallback is for ad-hoc
 * callers that didn't.
 */
function pickDefaultRealmFactory(): RealmFactory {
  // Real `Worker` available (standalone or extension offscreen
  // for Python) → DedicatedWorker realm. DOM available with
  // chrome.runtime → iframe realm. Otherwise (vitest in node) →
  // in-process realm with no hard-kill.
  if (typeof Worker !== 'undefined' || typeof document !== 'undefined') {
    return createDefaultRealmFactory();
  }
  return createInProcessJsRealmFactory();
}

let _ephemeralPm: ProcessManager | null = null;
function lazyEphemeralPm(): ProcessManager {
  if (!_ephemeralPm) {
    _ephemeralPm = new ProcessManager();
  }
  return _ephemeralPm;
}

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

// `ProcessManager` is referenced as a type via the `pmConfig`
// signature. The class import above lets the lazy-PM helper
// instantiate one for the back-compat (no-pmConfig) path.
export type { ProcessManager } from '../kernel/process-manager.js';
