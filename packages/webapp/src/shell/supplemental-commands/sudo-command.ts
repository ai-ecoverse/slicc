import type { Command, ExecResult } from 'just-bash';
import { defineCommand } from 'just-bash';
import { sudoRefusalMessage } from '../../sudo/approval-timeout.js';
import type { SudoBroker, SudoDecision } from '../../sudo/types.js';
import { commandSudoSubject } from '../sudo/command-guard.js';
import { SUDO_REASON_ENV } from '../sudo/command-reason.js';

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

/**
 * Result for a `deny`, distinguishing a real refusal from a prompt the human
 * never answered — an absent user is not a "no", and the agent must not
 * re-request the action on the next turn.
 */
function refusalResult(decision: SudoDecision): ExecResult {
  return { stdout: '', stderr: `${sudoRefusalMessage('sudo', decision)}\n`, exitCode: 1 };
}

/** Options accepted by {@link createSudoCommand}. */
export interface SudoCommandOptions {
  /**
   * Trusted-realm approval broker. The agent can only *request* an approval;
   * the broker decides. Absent in environments without sudo support — the
   * command then exits 1 with a clean "not configured" message.
   */
  broker?: SudoBroker;
  /**
   * Persist a human-confirmed `NOPASSWD Cmnd` grant for a pattern. Called only
   * when the human chose "Always". Absent broker / sink combinations are
   * tolerated — the inner command still runs, the grant is just not stored.
   */
  persistGrant?: (pattern: string) => Promise<void>;
  /**
   * Suppress the transparent `Cmnd` gate for the NEXT dispatch matching
   * `subject` (`name + ' ' + args.join(' ')`). One-shot — consumed on first
   * use. Lets `sudo` run the inner command without triggering a second prompt
   * when the inner command is itself policy-gated.
   */
  suppressNextGate?: (subject: string) => void;
}

/**
 * Create the `sudo <cmd...>` supplemental command.
 *
 * Reconstructs the inner subject from `args`, requests human approval via the
 * broker, then either runs the inner command (allow / always) or returns a
 * denial result (deny). On "always" the persist sink is called with
 * `decision.pattern` (or the inner subject as a fall-back).
 *
 * Single-prompt invariant: before dispatching the inner command via
 * `ctx.exec`, the command tells the shell to suppress the transparent
 * `Cmnd` gate for that one dispatch (`suppressNextGate(subject)`). The shell
 * registers a one-shot bypass keyed by canonical subject, so a nested
 * inner-command that itself runs a separately-gated subject still prompts
 * once on its own.
 *
 * `ctx.exec` is called with `args: args.slice(1)` so the inner argv bypasses
 * shell re-parsing — args that contain spaces or globbing characters are
 * forwarded verbatim, matching the bash-builtin `sudo` semantics.
 */
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

    // Canonical subject must match the transparent gate, including shared-
    // runtime aliases such as `jsh` -> `node`, so its one-shot bypass lines up.
    const subject = commandSudoSubject(args[0], args.slice(1));

    // Same run-scoped reason the transparent gate uses, read from THIS
    // command's own env so concurrent runs cannot borrow each other's —
    // see `shell/sudo/command-reason.ts`. An explicit `sudo` and a gate that
    // fired on its own should show the approver the same explanation.
    const reason = ctx.env?.get(SUDO_REASON_ENV);

    const decision = await broker.requestApproval({
      kind: 'command',
      detail: subject,
      ...(reason ? { reason } : {}),
    });

    if (decision.decision === 'deny') {
      return refusalResult(decision);
    }
    if (decision.decision === 'always') {
      const pattern = decision.pattern?.trim() || subject;
      if (persistGrant) {
        try {
          await persistGrant(pattern);
        } catch {
          /* best-effort: a failed grant write must not block an approved command */
        }
      }
    }

    if (suppressNextGate) {
      suppressNextGate(subject);
    }

    return ctx.exec(args[0], { cwd: ctx.cwd, args: args.slice(1) });
  });
}
