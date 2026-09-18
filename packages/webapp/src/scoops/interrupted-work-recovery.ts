import type { AgentMessage } from '../core/index.js';
import { createLogger } from '../core/index.js';
import type { TurnGuestGate } from '../sudo/types.js';
import type { LickEvent } from './lick-manager.js';
import { type InFlightTurn, previewArgs, type TurnJournal } from './scoop-context/turn-journal.js';

const log = createLogger('interrupted-work-recovery');

export const MAX_AUTO_RESUMES = 2;

export const TOOL_CALL_INTERRUPTED_REASON = 'tool-call-interrupted';

export interface InterruptedToolCall {
  toolCallId: string;
  toolName: string;
  argsPreview: string;

  inHistory: boolean;
}

export type Interruption =
  | { kind: 'none' }
  | { kind: 'turn' }
  | { kind: 'tools'; calls: InterruptedToolCall[] };

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

export interface RecoverableUnit {
  readonly isBusy: boolean;

  hasAgent(): boolean;
  getAgentMessages(): AgentMessage[];

  settleInterruptedToolCalls(
    calls: ReadonlyArray<{ toolCallId: string; toolName: string; text: string }>
  ): void;

  reportError(message: string): void;
}

export interface RecoveryDeps {
  journal: Pick<TurnJournal, 'clear' | 'isLive'>;
  getScoop(jid: string): { jid: string; folder: string } | undefined;
  getUnit(jid: string): RecoverableUnit | undefined;

  resumeTurn(jid: string, resumeCount: number, guestGates: TurnGuestGate[]): Promise<void>;
  emitLick(event: LickEvent): void;
}

export type RecoveryOutcome =
  | { jid: string; action: 'resumed'; resumeCount: number }
  | { jid: string; action: 'tools-reported'; calls: InterruptedToolCall[] }
  | { jid: string; action: 'gave-up'; resumeCount: number }
  | { jid: string; action: 'none' | 'superseded' | 'skipped' };

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
    if (!deps.journal.isLive(jid)) await deps.journal.clear(jid);
    return { jid, action: 'skipped' };
  }

  const interruption = classifyInterruption(unit.getAgentMessages(), turn);

  if (unit.isBusy) {
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
