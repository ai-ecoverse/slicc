/**
 * Boot-time recovery of turns a reload cut off.
 *
 * Owns: reading what a unit was doing when the previous page life ended (the
 * {@link TurnJournal} snapshot taken at boot) against what its restored
 * conversation actually holds, and deciding what to do about it:
 *
 * - **A model request was in flight** (the history ends in a user message or
 *   a tool result): nothing irreversible happened, so the request is simply
 *   repeated — the unit resumes the turn from its restored history.
 * - **Tool calls were in flight** (started, no result): tool calls can have
 *   side effects, so they are NEVER re-run automatically. Each gets a
 *   synthetic error result (so the history stays well-formed), and the unit
 *   receives a `session-reload` lick (`reason: 'tool-call-interrupted'`)
 *   naming the calls, so the agent can check the world and decide.
 * - **Nothing was actually lost** (the turn finished, only the journal's
 *   final delete never landed): the record is cleared and nothing happens.
 *
 * Changes when the recovery policy changes. The journal itself (when records
 * are written) lives in `scoop-context/turn-journal.ts`.
 *
 * Lazy-imported by the kernel host after cone bootstrap — it is not on the
 * boot critical path.
 */

import type { AgentMessage } from '../core/index.js';
import { createLogger } from '../core/index.js';
import type { TurnGuestGate } from '../sudo/types.js';
import type { LickEvent } from './lick-manager.js';
import { type InFlightTurn, previewArgs, type TurnJournal } from './scoop-context/turn-journal.js';

const log = createLogger('interrupted-work-recovery');

/**
 * How many times in a row one turn is automatically resumed. A turn whose
 * resume itself keeps dying (a request that crashes the tab, a reload loop)
 * must not be replayed forever; past the cap the unit is told instead.
 */
export const MAX_AUTO_RESUMES = 2;

/** The lick `body.reason` for interrupted tool calls. */
export const TOOL_CALL_INTERRUPTED_REASON = 'tool-call-interrupted';

/** One tool call that started before the reload and never reported back. */
export interface InterruptedToolCall {
  toolCallId: string;
  toolName: string;
  argsPreview: string;
  /**
   * The call is in the restored history (its assistant message was
   * persisted), so it needs a synthetic result to keep the history valid.
   * `false` when only the journal knew about it.
   */
  inHistory: boolean;
}

export type Interruption =
  | { kind: 'none' }
  | { kind: 'turn' }
  | { kind: 'tools'; calls: InterruptedToolCall[] };

/**
 * What a restored history plus a surviving journal record mean.
 *
 * Tool calls win over the model request: a history that ends in an assistant
 * message with unanswered tool calls was cut off DURING tool execution, and a
 * journaled tool call with no result anywhere in the history was cut off
 * before its assistant message was even persisted — in both cases repeating
 * the model request would re-issue calls that may already have had effects.
 */
export function classifyInterruption(messages: AgentMessage[], turn: InFlightTurn): Interruption {
  const resultIds = new Set<string>();
  const callIds = new Set<string>();
  for (const message of messages) {
    if (isRole(message, 'toolResult')) resultIds.add(message.toolCallId);
    if (isRole(message, 'assistant')) {
      for (const call of toolCallsOf(message)) callIds.add(call.id);
    }
  }

  const calls: InterruptedToolCall[] = [];
  const last = messages[messages.length - 1];
  const lastAssistantIdx = findLastIndex(messages, (m) => isRole(m, 'assistant'));
  const userAfterAssistant =
    lastAssistantIdx >= 0 &&
    messages.slice(lastAssistantIdx + 1).some((message) => isRole(message, 'user'));
  if (lastAssistantIdx >= 0 && !userAfterAssistant) {
    const journaled = new Map(turn.tools.map((t) => [t.toolCallId, t]));
    for (const call of toolCallsOf(messages[lastAssistantIdx])) {
      if (resultIds.has(call.id)) continue;
      calls.push({
        toolCallId: call.id,
        toolName: call.name,
        argsPreview: journaled.get(call.id)?.argsPreview ?? previewArgs(call.arguments),
        inHistory: true,
      });
    }
  }
  for (const tool of turn.tools) {
    if (callIds.has(tool.toolCallId) || resultIds.has(tool.toolCallId)) continue;
    calls.push({
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      argsPreview: tool.argsPreview,
      inHistory: false,
    });
  }
  if (calls.length > 0) return { kind: 'tools', calls };

  if (last && (isRole(last, 'user') || isRole(last, 'toolResult'))) return { kind: 'turn' };
  return { kind: 'none' };
}

/** The slice of a live unit recovery needs. */
export interface RecoverableUnit {
  readonly isBusy: boolean;
  /** False when the unit has no agent (no model / key) — nothing can run. */
  hasAgent(): boolean;
  getAgentMessages(): AgentMessage[];
  /** Append these error results for the interrupted calls and persist. */
  settleInterruptedToolCalls(
    calls: ReadonlyArray<{ toolCallId: string; toolName: string; text: string }>
  ): void;
  /** Surface a message on the unit's error channel. */
  reportError(message: string): void;
}

export interface RecoveryDeps {
  journal: Pick<TurnJournal, 'clear' | 'isLive'>;
  getScoop(jid: string): { jid: string; folder: string } | undefined;
  getUnit(jid: string): RecoverableUnit | undefined;
  /** Re-issue the unit's model request from its restored history, gated as before. */
  resumeTurn(jid: string, resumeCount: number, guestGates: TurnGuestGate[]): Promise<void>;
  emitLick(event: LickEvent): void;
}

export type RecoveryOutcome =
  | { jid: string; action: 'resumed'; resumeCount: number }
  | { jid: string; action: 'tools-reported'; calls: InterruptedToolCall[] }
  | { jid: string; action: 'gave-up'; resumeCount: number }
  | { jid: string; action: 'none' | 'superseded' | 'skipped' };

/**
 * Act on every turn the previous page life left running. `turns` is the
 * journal as read at boot — BEFORE any unit started a new turn, so a boot-time
 * lick that already put a unit to work cannot have overwritten the evidence.
 */
export async function recoverInterruptedWork(
  turns: readonly InFlightTurn[],
  deps: RecoveryDeps
): Promise<RecoveryOutcome[]> {
  const outcomes: RecoveryOutcome[] = [];
  for (const turn of turns) {
    try {
      outcomes.push(await recoverOne(turn, deps));
    } catch (err) {
      log.warn('Recovering an interrupted turn failed', {
        jid: turn.jid,
        error: err instanceof Error ? err.message : String(err),
      });
      outcomes.push({ jid: turn.jid, action: 'skipped' });
    }
  }
  return outcomes;
}

async function recoverOne(turn: InFlightTurn, deps: RecoveryDeps): Promise<RecoveryOutcome> {
  const { jid } = turn;
  const scoop = deps.getScoop(jid);
  const unit = deps.getUnit(jid);
  if (!scoop || !unit?.hasAgent()) {
    // Dropped since, failed to boot, or has no model to run on.
    if (!deps.journal.isLive(jid)) await deps.journal.clear(jid);
    return { jid, action: 'skipped' };
  }

  const interruption = classifyInterruption(unit.getAgentMessages(), turn);

  if (unit.isBusy) {
    // Something (a boot-time lick, the user) already started a new turn on
    // this unit; its record is that turn's now. The model request is moot —
    // the unit moved on — but lost tool calls are still worth telling the
    // agent about: nobody else will.
    if (interruption.kind === 'tools') {
      reportInterruptedTools(scoop.folder, turn, interruption.calls, unit, deps);
      return { jid, action: 'tools-reported', calls: interruption.calls };
    }
    return { jid, action: 'superseded' };
  }

  await deps.journal.clear(jid);

  switch (interruption.kind) {
    case 'none':
      return { jid, action: 'none' };
    case 'tools': {
      unit.settleInterruptedToolCalls(
        interruption.calls
          .filter((c) => c.inHistory)
          .map((c) => ({ ...c, text: INTERRUPTED_TOOL_RESULT_TEXT }))
      );
      reportInterruptedTools(scoop.folder, turn, interruption.calls, unit, deps);
      log.info('Reported tool calls interrupted by a reload', {
        folder: scoop.folder,
        tools: interruption.calls.map((c) => c.toolName),
      });
      return { jid, action: 'tools-reported', calls: interruption.calls };
    }
    case 'turn': {
      if (turn.resumeCount >= MAX_AUTO_RESUMES) {
        log.warn('Interrupted turn not resumed again', {
          folder: scoop.folder,
          resumeCount: turn.resumeCount,
        });
        unit.reportError(
          `The page reloaded ${turn.resumeCount + 1} times while this turn was running; ` +
            'it was not retried again. Send a message to continue.'
        );
        return { jid, action: 'gave-up', resumeCount: turn.resumeCount };
      }
      const resumeCount = turn.resumeCount + 1;
      log.info('Resuming a turn interrupted by a reload', { folder: scoop.folder, resumeCount });
      // Not awaited: the resumed turn runs as long as the model takes.
      void deps.resumeTurn(jid, resumeCount, turn.guestGates).catch((err: unknown) => {
        log.warn('Resumed turn failed', {
          folder: scoop.folder,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return { jid, action: 'resumed', resumeCount };
    }
  }
}

/**
 * Tell the unit its tool calls were cut off. Normally a lick, which starts a
 * turn so the agent can inspect the world and decide. A GUEST-gated turn gets
 * an error notice instead: a lick turn runs with the owner's authority, and
 * handing it a guest's half-finished tool calls to "decide about" would let a
 * reload launder the guest's request past its gate.
 */
function reportInterruptedTools(
  folder: string,
  turn: InFlightTurn,
  calls: readonly InterruptedToolCall[],
  unit: RecoverableUnit,
  deps: RecoveryDeps
): void {
  if (turn.guestGates.length > 0) {
    unit.reportError(
      `The page reloaded while ${calls.map((c) => c.toolName).join(', ')} ` +
        `${calls.length === 1 ? 'was' : 'were'} running for a guest; ` +
        'the result was lost and the call was not re-run.'
    );
    return;
  }
  deps.emitLick(toolCallInterruptedLick(folder, turn, calls));
}

/** The lick a unit receives for tool calls a reload cut off. */
export function toolCallInterruptedLick(
  folder: string,
  turn: InFlightTurn,
  calls: readonly InterruptedToolCall[]
): LickEvent {
  return {
    type: 'session-reload',
    targetScoop: folder,
    timestamp: new Date().toISOString(),
    body: {
      reason: TOOL_CALL_INTERRUPTED_REASON,
      interruptedAt: new Date(turn.updatedAt).toISOString(),
      tools: calls.map((c) => ({
        toolName: c.toolName,
        toolCallId: c.toolCallId,
        args: c.argsPreview,
      })),
    },
  };
}

/** The text of the synthetic result an interrupted tool call is given. */
export const INTERRUPTED_TOOL_RESULT_TEXT =
  'Interrupted: the page reloaded while this tool call was running, so its result was lost. ' +
  'It may or may not have completed, and it was not re-run.';

interface ToolCallPart {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: unknown;
}

function toolCallsOf(message: AgentMessage): ToolCallPart[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is ToolCallPart =>
      !!part &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'toolCall' &&
      typeof (part as { id?: unknown }).id === 'string'
  );
}

function isRole<R extends 'user' | 'assistant' | 'toolResult'>(
  message: AgentMessage | undefined,
  role: R
): message is Extract<AgentMessage, { role: R }> {
  return (message as { role?: unknown } | undefined)?.role === role;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i;
  return -1;
}
