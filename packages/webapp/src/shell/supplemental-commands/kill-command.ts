/**
 * `kill` — send a signal to a process tracked by the kernel
 * `ProcessManager`.
 *
 * Supports SIGSTOP / SIGCONT pause-and-resume alongside SIGINT /
 * SIGTERM / SIGKILL. Default signal (no flag) is `SIGTERM`,
 * mirroring POSIX `kill(1)`. SIGSTOP and SIGCONT only affect the
 * kernel's cooperative `Gate` — they don't suspend already-running
 * JavaScript code. The terminal output emitter is the most-visible
 * consumer.
 *
 * Argument forms:
 *   kill PID [PID …]               default SIGTERM
 *   kill -s SIGINT PID …           explicit signal name
 *   kill -INT PID …                short form
 *   kill -TERM PID …
 *   kill -KILL PID …
 *   kill -9 PID …                  numeric (SIGKILL only — POSIX
 *                                  compatibility shorthand)
 *
 * Exit codes:
 *   0  — every signal delivered (process exists + not already
 *        terminated — matches `kill(2)` non-zero return).
 *   1  — at least one pid was unknown / already exited.
 *   2  — argument parse error.
 */

import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import type { ProcessManager, Signal } from '../../kernel/process-manager.js';

export interface KillCommandOptions {
  /**
   * Inject a `ProcessManager` directly. When omitted, looks up
   * `globalThis.__slicc_pm` at exec time. Tests pass an explicit
   * instance.
   */
  processManager?: ProcessManager;
}

const SUPPORTED: Set<Signal> = new Set([
  'SIGINT',
  'SIGTERM',
  'SIGKILL',
  // pause/resume gate.
  'SIGSTOP',
  'SIGCONT',
]);

export function createKillCommand(options: KillCommandOptions = {}): Command {
  return defineCommand('kill', async (args) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return killHelp();
    }

    const pm = options.processManager ?? lookupGlobalPm();
    if (!pm) {
      return {
        stdout: '',
        stderr: 'kill: no process manager available in this runtime\n',
        exitCode: 1,
      };
    }

    let signal: Signal = 'SIGTERM';
    const pids: number[] = [];

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-s' || a === '--signal') {
        const next = args[++i];
        if (!next) {
          return { stdout: '', stderr: 'kill: -s requires a signal name\n', exitCode: 2 };
        }
        const parsed = parseSignal(next);
        if (parsed instanceof Error) {
          return { stdout: '', stderr: `kill: ${parsed.message}\n`, exitCode: 2 };
        }
        signal = parsed;
        continue;
      }
      if (a.startsWith('-')) {
        // Could be a `-NAME` short form (e.g. -INT) or `-9`.
        const parsed = parseSignalShort(a);
        if (parsed instanceof Error) {
          return { stdout: '', stderr: `kill: ${parsed.message}\n`, exitCode: 2 };
        }
        signal = parsed;
        continue;
      }
      // Treat as a pid.
      const pid = Number.parseInt(a, 10);
      if (!Number.isFinite(pid) || String(pid) !== a) {
        return { stdout: '', stderr: `kill: invalid pid '${a}'\n`, exitCode: 2 };
      }
      pids.push(pid);
    }

    if (pids.length === 0) {
      return { stdout: '', stderr: 'kill: no pids supplied\n', exitCode: 2 };
    }

    if (!SUPPORTED.has(signal)) {
      return {
        stdout: '',
        stderr: `kill: signal ${signal} not supported\n`,
        exitCode: 2,
      };
    }

    let allDelivered = true;
    const errors: string[] = [];
    for (const pid of pids) {
      const ok = pm.signal(pid, signal);
      if (!ok) {
        allDelivered = false;
        const proc = pm.get(pid);
        if (!proc) {
          errors.push(`kill: (${pid}) - no such process`);
        } else {
          errors.push(`kill: (${pid}) - process already terminated`);
        }
      }
    }

    return {
      stdout: '',
      stderr: errors.length ? errors.join('\n') + '\n' : '',
      exitCode: allDelivered ? 0 : 1,
    };
  });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function lookupGlobalPm(): ProcessManager | null {
  const g = globalThis as Record<string, unknown>;
  const pm = g.__slicc_pm;
  return pm instanceof Object && typeof (pm as ProcessManager).signal === 'function'
    ? (pm as ProcessManager)
    : null;
}

function parseSignal(name: string): Signal | Error {
  const upper = name.toUpperCase();
  const withSig = upper.startsWith('SIG') ? upper : `SIG${upper}`;
  if (
    withSig === 'SIGINT' ||
    withSig === 'SIGTERM' ||
    withSig === 'SIGKILL' ||
    withSig === 'SIGSTOP' ||
    withSig === 'SIGCONT'
  ) {
    return withSig as Signal;
  }
  return new Error(`unknown signal '${name}'`);
}

function parseSignalShort(arg: string): Signal | Error {
  // `-9` → SIGKILL. The full POSIX numeric table isn't supported;
  // SIGSTOP=19 / SIGCONT=18 could be added here as a follow-up.
  if (arg === '-9') return 'SIGKILL';
  // `-INT`, `-TERM`, `-KILL`, `-SIGINT`, `-SIGTERM`, `-SIGKILL`.
  const tail = arg.slice(1);
  return parseSignal(tail);
}

function killHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `Usage: kill [-s SIGNAL | -INT | -TERM | -KILL | -STOP | -CONT | -9] PID [PID …]

Send a signal to one or more processes tracked by the kernel.

Default signal: SIGTERM.

Supported signals:
  SIGINT (-INT)    cooperative cancel — exit 130
  SIGTERM (-TERM)  cooperative cancel — exit 143 (default)
  SIGKILL (-KILL)  cooperative cancel for cooperative procs;
                   actually preempts kind:'preemptive' procs
  SIGSTOP (-STOP)  pause the process's kernel Gate.
                   Subsequent IO boundaries (terminal output, …)
                   block until SIGCONT.
  SIGCONT (-CONT)  resume the gate.

Examples:
  kill 1024              SIGTERM the process with pid 1024
  kill -INT 1024 1025    SIGINT both
  kill -STOP 1024        pause; \`kill -CONT 1024\` resumes
  kill -s SIGKILL 1024   explicit signal name
`,
    stderr: '',
    exitCode: 0,
  };
}
