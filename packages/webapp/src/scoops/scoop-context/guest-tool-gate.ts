/**
 * The per-tool-call approval gate for a guest-caused turn.
 *
 * Split out of `tools.ts` and imported ON FIRST USE because `tools.ts` is in
 * the kernel worker's boot-critical graph, and the overwhelming majority of
 * turns have no guest gate at all — this machinery has no business being
 * downloaded before the terminal opens (see `packages/webapp/first-load-budget.json`).
 *
 * The sync `currentGate()` check stays in `tools.ts`; only the part that runs
 * once a gate actually exists lives here.
 */

import { createLogger } from '../../base/logger.js';
import { extractToolArg } from '../../core/index.js';
import type { SudoDecision, SudoRequest, TurnGuestGate } from '../../sudo/types.js';

const log = createLogger('guest-tool-gate');

/**
 * Ask every approver on the turn. ALL must clear: when a batch merged messages
 * from several seats, one seat's approval is not consent from the others.
 * Sequential and short-circuiting, so a refused call does not go on to bother
 * the rest.
 */
export async function approveToolCallForGuests(
  gates: readonly TurnGuestGate[],
  toolName: string,
  params: unknown,
  approve: ((request: SudoRequest) => Promise<SudoDecision>) | undefined
): Promise<boolean> {
  if (!approve) {
    // No approval route means nobody CAN say yes. Allowing here would run a
    // guest's turn ungated on a leader whose wiring is simply missing.
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

/**
 * One line describing what is about to run, for the approval prompt.
 *
 * Bounded, because a reviewer cannot meaningfully consent to a wall of JSON —
 * and an unbounded argument bag is attacker-influenced text on a security
 * prompt, which is how a prompt gets pushed off screen.
 */
function describeToolCall(toolName: string, params: unknown): string {
  const [principal] = extractToolArg(params);
  if (!principal) return toolName;
  return `${toolName}: ${principal.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
}
