/**
 * Command-level sudo enforcement.
 *
 * Pure, framework-free guard run at the shell dispatch chokepoint
 * (`WasmShell.runCommand`). It splits a command line into top-level segments,
 * matches each against the sudoers `Cmnd` policy, and routes any
 * `require-approval` match through the trusted-realm {@link SudoBroker}. A deny
 * blocks the whole command line; an "Always" grant is persisted as a
 * `NOPASSWD Cmnd` rule via the injected `persistGrant` sink.
 *
 * No FS, no shell wiring — the shell injects the policy, broker, and grant
 * sink so this module stays unit-testable in isolation.
 */

import type { SudoBroker } from '../../sudo/types.js';
import { splitCommandSegments } from '../../tools/bash-tool.js';
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
  /** True when every gated segment was approved (or none were gated). */
  allowed: boolean;
  /** stderr message to emit when `allowed` is false. */
  message?: string;
}

/**
 * Evaluate `command` against the policy. Each gated segment triggers one native
 * approval prompt; a single deny short-circuits and blocks the command line.
 * Segments matching a `NOPASSWD` grant (or no rule) run with no prompt.
 */
export async function enforceCommandSudo(
  command: string,
  deps: CommandSudoDeps
): Promise<CommandSudoResult> {
  const segments = splitCommandSegments(command)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const segment of segments) {
    if (matchCommand(deps.policy, segment) !== 'require-approval') continue;

    const decision = await deps.broker.requestApproval({ kind: 'command', detail: segment });

    if (decision.decision === 'deny') {
      return { allowed: false, message: COMMAND_DENIED_MESSAGE };
    }
    if (decision.decision === 'always') {
      const pattern = decision.pattern?.trim() || segment;
      await deps.persistGrant(pattern);
    }
  }

  return { allowed: true };
}
