import type { Command, ExecResult } from 'just-bash';
import { defineCommand } from 'just-bash';
import { sudoRefusalMessage } from '../../sudo/approval-timeout.js';
import type { SudoBroker, SudoDecision } from '../../sudo/types.js';

const SUDO_HELP = `usage: sudo <command> [args...]

Request human approval to run <command> with elevation. If approved, the
inner command runs verbatim and its result is returned as-is. If denied,
the inner command does NOT run.

Choosing "Always" persists a NOPASSWD grant so future runs of the same
pattern don't re-prompt.

Options:
  -h, --help    Show this help message and exit.
`;

const SUDO_USAGE_ERROR = 'sudo: usage: sudo <command> [args...]';
const SUDO_UNSUPPORTED_MESSAGE = 'sudo: command-level approval is not configured';
const SUDO_NO_EXEC_MESSAGE = 'sudo: cannot dispatch inner command in this context';

function refusalResult(decision: SudoDecision): ExecResult {
  return { stdout: '', stderr: `${sudoRefusalMessage('sudo', decision)}\n`, exitCode: 1 };
}

export interface SudoCommandOptions {
  broker?: SudoBroker;

  persistGrant?: (pattern: string) => Promise<void>;

  suppressNextGate?: (subject: string) => void;
}

export function createSudoCommand(options: SudoCommandOptions = {}): Command {
  const { broker, persistGrant, suppressNextGate } = options;
  return defineCommand('sudo', async (args, ctx): Promise<ExecResult> => {
    if (args.length === 0) {
      return { stdout: '', stderr: `${SUDO_USAGE_ERROR}\n`, exitCode: 1 };
    }
    if (args[0] === '--help' || args[0] === '-h') {
      return { stdout: SUDO_HELP, stderr: '', exitCode: 0 };
    }

    if (!broker) {
      return { stdout: '', stderr: `${SUDO_UNSUPPORTED_MESSAGE}\n`, exitCode: 1 };
    }
    if (!ctx.exec) {
      return { stdout: '', stderr: `${SUDO_NO_EXEC_MESSAGE}\n`, exitCode: 1 };
    }

    const subject = args.join(' ').trim();

    const decision = await broker.requestApproval({ kind: 'command', detail: subject });

    if (decision.decision === 'deny') {
      return refusalResult(decision);
    }
    if (decision.decision === 'always') {
      const pattern = decision.pattern?.trim() || subject;
      if (persistGrant) {
        try {
          await persistGrant(pattern);
        } catch {}
      }
    }

    if (suppressNextGate) {
      suppressNextGate(subject);
    }

    return ctx.exec(args[0], { cwd: ctx.cwd, args: args.slice(1) });
  });
}
