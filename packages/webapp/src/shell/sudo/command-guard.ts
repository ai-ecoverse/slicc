/**
 * Command-level sudo enforcement.
 *
 * Pure, framework-free matcher run at the just-bash DISPATCH chokepoint: the
 * shell decorates every registered command's `execute(args, ctx)` so this
 * check fires when a command actually dispatches, not on a pre-parse of the
 * raw command line. The decorated subject is the already-tokenized
 * `name + ' ' + args.join(' ')`, so command substitution `$(...)`, backticks,
 * and pipelines — which just-bash routes back through the command registry —
 * are gated for free, with no string parsing here. A `require-approval` match
 * routes through the trusted-realm {@link SudoBroker}; a deny blocks the
 * single dispatch; an "Always" grant is persisted as a `NOPASSWD Cmnd` rule
 * via the injected `persistGrant` sink.
 *
 * Coverage note: interpreter builtins (`cd`, `export`, `eval`, `source`, etc.)
 * bypass the command registry, so a `Cmnd` rule never matches them directly.
 * That is acceptable — those builtins either only mutate shell state (not
 * `Cmnd`-matchable) or, like `eval`/`source`, re-dispatch their sub-commands
 * back through the registry, where the real gated command (`git`, `rm`, …) is
 * still caught at its own dispatch.
 *
 * No FS, no shell wiring — the shell injects the policy, broker, and grant
 * sink so this module stays unit-testable in isolation.
 */

import type { SudoBroker } from '../../sudo/types.js';
import { matchCommand, type SudoersPolicy } from './sudoers.js';

/** stderr message emitted (and shown to the agent) when approval is denied. */
export const COMMAND_DENIED_MESSAGE = 'sudo: approval denied';

/** Dependencies injected by the shell for one enforcement pass. */
export interface CommandSudoDeps {
  /** The current (live-reloadable) policy to match against. */
  policy: SudoersPolicy;
  /** Trusted-realm approval surface. */
  broker: SudoBroker;
  /**
   * Persist a human-confirmed `NOPASSWD Cmnd` grant for `pattern`. Called only
   * when the human chose "Always". Errors propagate to the caller.
   */
  persistGrant: (pattern: string) => Promise<void>;
}

/** Outcome of an enforcement pass. */
export interface CommandSudoResult {
  /** True when the subject was approved (or was not gated). */
  allowed: boolean;
  /** stderr message to emit when `allowed` is false. */
  message?: string;
}

/**
 * Evaluate a single already-tokenized command `subject`
 * (`name + ' ' + args.join(' ')`) against the policy. A gated subject triggers
 * one native approval prompt; a deny blocks this dispatch. A subject matching a
 * `NOPASSWD` grant (or no rule) runs with no prompt. No splitting happens here —
 * chained/nested/piped commands are each dispatched (and so each gated)
 * separately by just-bash.
 */
export async function enforceCommandSudo(
  subject: string,
  deps: CommandSudoDeps
): Promise<CommandSudoResult> {
  const trimmed = subject.trim();
  if (!trimmed) return { allowed: true };

  if (matchCommand(deps.policy, trimmed) !== 'require-approval') {
    return { allowed: true };
  }

  const decision = await deps.broker.requestApproval({ kind: 'command', detail: trimmed });

  if (decision.decision === 'deny') {
    return { allowed: false, message: COMMAND_DENIED_MESSAGE };
  }
  if (decision.decision === 'always') {
    const pattern = decision.pattern?.trim() || trimmed;
    await deps.persistGrant(pattern);
  }

  return { allowed: true };
}
