/**
 * `preemptive` — run JS code in a hard-killable child Worker.
 *
 * Phase 7.3. The user-facing surface for the preemptive runner.
 * Each invocation spawns a `kind:'preemptive'` process backed by
 * a fresh DedicatedWorker; SIGKILL via `kill -KILL <pid>` from
 * any other shell terminates the worker synchronously.
 *
 * Usage:
 *   preemptive 'CODE'              run inline code
 *   preemptive --help              usage
 *
 * The script runs inside an `AsyncFunction` with `console` and
 * `process` shims (argv, env, stdout/stderr, exit). It does NOT
 * have FS access (no VFS bridge yet) or DOM globals — Phase 7
 * minimum-viable focuses on demonstrating hard preemption; full
 * runtime parity with `node -e` is a follow-up.
 *
 * Phase 7's contract on signals:
 *   - SIGINT / SIGTERM record `terminatedBy` and abort the
 *     `Process.abort` controller, but do NOT terminate the worker
 *     — the running JS is opaque to us and there's no cooperative
 *     channel into it.
 *   - SIGKILL terminates the worker via `worker.terminate()` and
 *     sets exit code 137. Always works, even after SIGINT.
 *
 * Demo:
 *   $ preemptive 'while(true){}' &        # one terminal (when bg supported)
 *   $ ps                                  # find the pid
 *   $ kill -KILL <pid>                    # exit 137 within ~10ms
 */

import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { runPreemptiveJs, type PreemptiveWorkerFactory } from '../../kernel/preemptive-runner.js';
import type { ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';

export interface PreemptiveCommandOptions {
  /**
   * Inject a `ProcessManager`. When omitted, looks up
   * `globalThis.__slicc_pm` at exec time.
   */
  processManager?: ProcessManager;
  /**
   * Build a worker for the run. When omitted, uses the production
   * `createPreemptiveWorker` factory (Vite-bundled DedicatedWorker).
   * Tests inject a mock.
   */
  workerFactory?: PreemptiveWorkerFactory;
  /**
   * Default owner for spawned preemptive processes. Defaults to
   * `{ kind: 'system' }` — the panel terminal session in worker
   * mode runs as system; cone-driven invocations should pass
   * `{ kind: 'cone' }` (Phase 8 follow-up: thread the owner from
   * `WasmShellHeadless.processOwner`).
   */
  owner?: ProcessOwner;
}

export function createPreemptiveCommand(options: PreemptiveCommandOptions = {}): Command {
  return defineCommand('preemptive', async (args) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return preemptiveHelp();
    }

    const pm = options.processManager ?? lookupGlobalPm();
    if (!pm) {
      return {
        stdout: '',
        stderr: 'preemptive: no process manager available in this runtime\n',
        exitCode: 1,
      };
    }

    const factory = options.workerFactory ?? (await getDefaultFactory());
    if (!factory) {
      return {
        stdout: '',
        stderr: 'preemptive: cannot construct DedicatedWorker (not available in this runtime)\n',
        exitCode: 1,
      };
    }

    // The first positional arg is the code to run; remaining args
    // become `process.argv[2..]` to the script.
    const code = args[0];
    const scriptArgv = ['preemptive', ...args.slice(1)];
    const owner = options.owner ?? { kind: 'system' };

    try {
      const result = await runPreemptiveJs({
        pm,
        workerFactory: factory,
        owner,
        code,
        argv: scriptArgv,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: `preemptive: ${message}\n`, exitCode: 1 };
    }
  });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function lookupGlobalPm(): ProcessManager | null {
  const g = globalThis as Record<string, unknown>;
  const pm = g.__slicc_pm;
  return pm instanceof Object && typeof (pm as ProcessManager).spawn === 'function'
    ? (pm as ProcessManager)
    : null;
}

let cachedFactory: PreemptiveWorkerFactory | null | undefined;

async function getDefaultFactory(): Promise<PreemptiveWorkerFactory | null> {
  if (cachedFactory !== undefined) return cachedFactory;
  if (typeof Worker === 'undefined') {
    cachedFactory = null;
    return null;
  }
  try {
    const mod = await import('../../kernel/preemptive-runner.js');
    cachedFactory = mod.createPreemptiveWorker;
    return cachedFactory;
  } catch {
    cachedFactory = null;
    return null;
  }
}

function preemptiveHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `Usage: preemptive 'CODE' [ARGS…]

Run JS code in a hard-killable child Worker.

Each invocation spawns a kind:'preemptive' process. SIGKILL via
\`kill -KILL <pid>\` from another terminal terminates the worker
synchronously (worker.terminate()), exit 137.

Available globals inside the script:
  console.log/info/warn/error  → captured to stdout/stderr
  process.argv                 → ['preemptive', ARGS…]
  process.env                  → empty by default
  process.stdout.write(…)      → append to stdout
  process.stderr.write(…)      → append to stderr
  process.exit(N)              → exit with code N

Examples:
  preemptive 'console.log("hi")'
  preemptive 'while(true){}'             # then \`kill -KILL <pid>\`
  preemptive 'process.exit(7)'
`,
    stderr: '',
    exitCode: 0,
  };
}
