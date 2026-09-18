import {
  applyDefaultDisposition,
  type DefaultDisposition,
  matchCommand,
  type SudoersPolicy,
} from '../../base/sudoers.js';
import { sudoRefusalMessage } from '../../sudo/approval-timeout.js';
import type { SudoBroker, SudoDecision } from '../../sudo/types.js';

export const COMMAND_DENIED_MESSAGE = 'sudo: approval denied';

const COMMAND_POLICY_ALIASES = new Map([['jsh', 'node']]);

export function commandSudoSubject(name: string, args: readonly string[]): string {
  const policyName = COMMAND_POLICY_ALIASES.get(name) ?? name;
  return `${policyName} ${args.join(' ')}`.trim();
}

export function commandSudoMessage(decision: SudoDecision): string {
  return sudoRefusalMessage('sudo', decision);
}

export interface CommandSudoDeps {
  policy: SudoersPolicy;

  broker: SudoBroker;

  persistGrant: (pattern: string) => Promise<void>;

  defaultDisposition?: DefaultDisposition;

  reason?: string;
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

  const decision = await deps.broker.requestApproval({
    kind: 'command',
    detail: trimmed,
    ...(deps.reason ? { reason: deps.reason } : {}),
  });

  if (decision.decision === 'deny') {
    return { allowed: false, message: commandSudoMessage(decision) };
  }
  if (decision.decision === 'always') {
    const pattern = decision.pattern?.trim() || trimmed;
    await deps.persistGrant(pattern);
  }

  return { allowed: true };
}
