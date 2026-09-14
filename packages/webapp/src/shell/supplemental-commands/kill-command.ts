import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { ProcessManager, Signal } from '../../kernel/process-manager.js';

export interface KillCommandOptions {
  processManager?: ProcessManager;
}

const SUPPORTED: Set<Signal> = new Set([
  'SIGINT',
  'SIGTERM',
  'SIGKILL',

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

    const parsed = parseKillArgs(args);
    if (!parsed.ok) {
      return { stdout: '', stderr: parsed.stderr, exitCode: parsed.exitCode };
    }

    const { allDelivered, errors } = deliverSignals(pm, parsed.pids, parsed.signal);
    return {
      stdout: '',
      stderr: errors.length ? `${errors.join('\n')}\n` : '',
      exitCode: allDelivered ? 0 : 1,
    };
  });
}

interface KernelGlobals {
  __slicc_pm?: unknown;
}

function lookupGlobalPm(): ProcessManager | null {
  const pm = (globalThis as KernelGlobals).__slicc_pm;
  return pm instanceof Object && typeof (pm as ProcessManager).signal === 'function'
    ? (pm as ProcessManager)
    : null;
}

type ParsedKillArgs =
  | { ok: true; signal: Signal; pids: number[] }
  | { ok: false; stderr: string; exitCode: number };

function parseKillArgs(args: string[]): ParsedKillArgs {
  let signal: Signal = 'SIGTERM';
  const pids: number[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-s' || a === '--signal') {
      const next = args[++i];
      if (!next) return { ok: false, stderr: 'kill: -s requires a signal name\n', exitCode: 2 };
      const parsed = parseSignal(next);
      if (parsed instanceof Error) {
        return { ok: false, stderr: `kill: ${parsed.message}\n`, exitCode: 2 };
      }
      signal = parsed;
      continue;
    }
    if (a.startsWith('-')) {
      const parsed = parseSignalShort(a);
      if (parsed instanceof Error) {
        return { ok: false, stderr: `kill: ${parsed.message}\n`, exitCode: 2 };
      }
      signal = parsed;
      continue;
    }

    const pid = Number.parseInt(a, 10);
    if (!Number.isFinite(pid) || String(pid) !== a) {
      return { ok: false, stderr: `kill: invalid pid '${a}'\n`, exitCode: 2 };
    }
    pids.push(pid);
  }

  if (pids.length === 0) return { ok: false, stderr: 'kill: no pids supplied\n', exitCode: 2 };
  if (!SUPPORTED.has(signal)) {
    return { ok: false, stderr: `kill: signal ${signal} not supported\n`, exitCode: 2 };
  }
  return { ok: true, signal, pids };
}

function deliverSignals(
  pm: ProcessManager,
  pids: number[],
  signal: Signal
): { allDelivered: boolean; errors: string[] } {
  let allDelivered = true;
  const errors: string[] = [];
  for (const pid of pids) {
    if (pm.signal(pid, signal)) continue;
    allDelivered = false;
    errors.push(
      pm.get(pid)
        ? `kill: (${pid}) - process already terminated`
        : `kill: (${pid}) - no such process`
    );
  }
  return { allDelivered, errors };
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
  if (arg === '-9') return 'SIGKILL';

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
                   hard-kills kind:'jsh' / kind:'py' realms
                   (worker.terminate())
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
