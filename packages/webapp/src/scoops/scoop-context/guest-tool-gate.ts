import { createLogger } from '../../base/logger.js';
import { extractToolArg } from '../../core/index.js';
import type { SudoDecision, SudoRequest, TurnGuestGate } from '../../sudo/types.js';

const log = createLogger('guest-tool-gate');

export async function approveToolCallForGuests(
  gates: readonly TurnGuestGate[],
  toolName: string,
  params: unknown,
  approve: ((request: SudoRequest) => Promise<SudoDecision>) | undefined
): Promise<boolean> {
  if (!approve) {
    log.warn('Guest-caused turn with no approval route — refusing tool call', { tool: toolName });
    return false;
  }
  const detail = describeToolCall(toolName, params);
  for (const gate of gates) {
    const decision = await approve({
      kind: 'guest-tool',
      detail,
      requester: gate.requester,
      ...(gate.approver ? { approver: gate.approver } : {}),
    });
    if (decision.decision === 'deny') return false;
  }
  return true;
}

function describeToolCall(toolName: string, params: unknown): string {
  const [principal] = extractToolArg(params);
  if (!principal) return toolName;
  return `${toolName}: ${principal.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
}
