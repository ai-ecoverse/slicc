import {
  applyDefaultDisposition,
  type DefaultDisposition,
  matchCommand,
  type SudoersPolicy,
} from '../../base/sudoers.js';
import { sudoRefusalMessage } from '../../sudo/approval-timeout.js';
import type { SudoBroker, SudoDecision } from '../../sudo/types.js';

export const COMMAND_DENIED_MESSAGE = 'sudo: approval denied';

export function commandSudoMessage(decision: SudoDecision): string {
  return sudoRefusalMessage('sudo', decision);
}

export interface CommandSudoDeps {
  policy: SudoersPolicy;

  broker: SudoBroker;

  persistGrant: (pattern: string) => Promise<void>;

  defaultDisposition?: DefaultDisposition;
}

export interface CommandSudoResult {
  allowed: boolean;

  message?: string;
}

export async function enforceCommandSudo(
  subject: string,
  deps: CommandSudoDeps
): Promise<CommandSudoResult> {
  const trimmed = subject.trim();
  if (!trimmed) return { allowed: true };

  if (
    applyDefaultDisposition(
      matchCommand(deps.policy, trimmed),
      deps.defaultDisposition ?? 'allow'
    ) !== 'require-approval'
  ) {
    return { allowed: true };
  }

  const decision = await deps.broker.requestApproval({ kind: 'command', detail: trimmed });

  if (decision.decision === 'deny') {
    return { allowed: false, message: commandSudoMessage(decision) };
  }
  if (decision.decision === 'always') {
    const pattern = decision.pattern?.trim() || trimmed;
    await deps.persistGrant(pattern);
  }

  return { allowed: true };
}
