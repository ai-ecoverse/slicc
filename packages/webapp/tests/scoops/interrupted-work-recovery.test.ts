import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../../src/core/index.js';
import {
  classifyInterruption,
  INTERRUPTED_TOOL_RESULT_TEXT,
  MAX_AUTO_RESUMES,
  type RecoverableUnit,
  type RecoveryDeps,
  recoverInterruptedWork,
  TOOL_CALL_INTERRUPTED_REASON,
} from '../../src/scoops/interrupted-work-recovery.js';
import type { InFlightTurn } from '../../src/scoops/scoop-context/turn-journal.js';

const user = (text: string): AgentMessage =>
  ({ role: 'user', content: text, timestamp: 1 }) as AgentMessage;
const assistant = (
  text: string,
  calls: Array<{ id: string; name: string; arguments?: unknown }> = []
): AgentMessage =>
  ({
    role: 'assistant',
    content: [
      { type: 'text', text },
      ...calls.map((c) => ({ type: 'toolCall', arguments: {}, ...c })),
    ],
    stopReason: calls.length ? 'toolUse' : 'stop',
    timestamp: 2,
  }) as unknown as AgentMessage;
const toolResult = (id: string): AgentMessage =>
  ({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'bash',
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    timestamp: 3,
  }) as AgentMessage;

function turnRecord(overrides: Partial<InFlightTurn> = {}): InFlightTurn {
  return {
    jid: 'cone_1',
    folder: 'cone',
    startedAt: 1,
    updatedAt: Date.parse('2026-09-18T10:00:00Z'),
    resumeCount: 0,
    tools: [],
    guestGates: [],
    ...overrides,
  };
}

describe('classifyInterruption', () => {
  it('a history ending in the user message means the model request was lost', () => {
    expect(classifyInterruption([user('hi')], turnRecord())).toEqual({ kind: 'turn' });
  });

  it('a history ending in a tool result means the follow-up request was lost', () => {
    const messages = [user('go'), assistant('', [{ id: 'a', name: 'bash' }]), toolResult('a')];
    expect(classifyInterruption(messages, turnRecord())).toEqual({ kind: 'turn' });
  });

  it('a finished answer means nothing was lost', () => {
    expect(classifyInterruption([user('hi'), assistant('hello')], turnRecord())).toEqual({
      kind: 'none',
    });
    expect(classifyInterruption([], turnRecord())).toEqual({ kind: 'none' });
  });

  it('unanswered tool calls in the history are interrupted tools, never a replay', () => {
    const messages = [
      user('go'),
      assistant('', [
        { id: 'a', name: 'bash', arguments: { command: 'ls' } },
        { id: 'b', name: 'bash', arguments: { command: 'sleep 60' } },
      ]),
      toolResult('a'),
    ];
    const journal = turnRecord({
      tools: [{ toolCallId: 'b', toolName: 'bash', argsPreview: 'journaled', startedAt: 1 }],
    });
    expect(classifyInterruption(messages, journal)).toEqual({
      kind: 'tools',
      calls: [{ toolCallId: 'b', toolName: 'bash', argsPreview: 'journaled', inHistory: true }],
    });

    expect(classifyInterruption(messages, turnRecord())).toMatchObject({
      kind: 'tools',
      calls: [{ toolCallId: 'b', argsPreview: '{"command":"sleep 60"}' }],
    });
  });

  it('a journaled tool call whose message never reached the history is still a tool', () => {
    const journal = turnRecord({
      tools: [{ toolCallId: 'z', toolName: 'bash', argsPreview: '{}', startedAt: 1 }],
    });
    expect(classifyInterruption([user('go')], journal)).toEqual({
      kind: 'tools',
      calls: [{ toolCallId: 'z', toolName: 'bash', argsPreview: '{}', inHistory: false }],
    });
  });

  it('a journaled tool call that already has a result is not interrupted', () => {
    const messages = [user('go'), assistant('', [{ id: 'a', name: 'bash' }]), toolResult('a')];
    const journal = turnRecord({
      tools: [{ toolCallId: 'a', toolName: 'bash', argsPreview: '{}', startedAt: 1 }],
    });
    expect(classifyInterruption(messages, journal)).toEqual({ kind: 'turn' });
  });

  it('ignores orphaned calls a later user message already superseded', () => {
    const messages = [user('go'), assistant('', [{ id: 'a', name: 'bash' }]), user('again')];
    expect(classifyInterruption(messages, turnRecord())).toEqual({ kind: 'turn' });
  });
});

function unitStub(messages: AgentMessage[], overrides: Partial<RecoverableUnit> = {}) {
  return {
    isBusy: false,
    hasAgent: vi.fn(() => true),
    getAgentMessages: vi.fn(() => messages),
    settleInterruptedToolCalls: vi.fn(),
    reportError: vi.fn(),
    ...overrides,
  } satisfies RecoverableUnit;
}

function depsFor(unit: RecoverableUnit | undefined, overrides: Partial<RecoveryDeps> = {}) {
  const deps = {
    journal: { clear: vi.fn(async () => {}), isLive: vi.fn(() => false) },
    getScoop: vi.fn((jid: string) => ({ jid, folder: 'cone' })),
    getUnit: vi.fn(() => unit),
    resumeTurn: vi.fn(async () => {}),
    emitLick: vi.fn(),
    ...overrides,
  };
  return deps;
}

describe('recoverInterruptedWork', () => {
  it('resumes a lost model request with the next resume count and the journaled gates', async () => {
    const unit = unitStub([user('hi')]);
    const deps = depsFor(unit);
    const gates = [{ requester: 'guest-1' }];
    const outcomes = await recoverInterruptedWork([turnRecord({ guestGates: gates })], deps);
    expect(outcomes).toEqual([{ jid: 'cone_1', action: 'resumed', resumeCount: 1 }]);
    expect(deps.journal.clear).toHaveBeenCalledWith('cone_1');
    expect(deps.resumeTurn).toHaveBeenCalledWith('cone_1', 1, gates);
    expect(deps.emitLick).not.toHaveBeenCalled();
  });

  it('stops replaying a turn that keeps getting cut off', async () => {
    const unit = unitStub([user('hi')]);
    const deps = depsFor(unit);
    const outcomes = await recoverInterruptedWork(
      [turnRecord({ resumeCount: MAX_AUTO_RESUMES })],
      deps
    );
    expect(outcomes[0]).toMatchObject({ action: 'gave-up' });
    expect(deps.resumeTurn).not.toHaveBeenCalled();
    expect(unit.reportError).toHaveBeenCalledWith(expect.stringContaining('not retried again'));
  });

  it('a failing resume is logged, never thrown', async () => {
    const unit = unitStub([user('hi')]);
    const deps = depsFor(unit, { resumeTurn: vi.fn(async () => Promise.reject(new Error('x'))) });
    await expect(recoverInterruptedWork([turnRecord()], deps)).resolves.toHaveLength(1);
  });

  it('settles interrupted tool calls and hands them to the agent as a lick', async () => {
    const messages = [
      user('go'),
      assistant('', [{ id: 'b', name: 'bash', arguments: { command: 'sleep 60' } }]),
    ];
    const journal = turnRecord({
      tools: [
        { toolCallId: 'b', toolName: 'bash', argsPreview: '{"command":"sleep 60"}', startedAt: 1 },
        { toolCallId: 'z', toolName: 'read_file', argsPreview: '{}', startedAt: 1 },
      ],
    });
    const unit = unitStub(messages);
    const deps = depsFor(unit);
    const outcomes = await recoverInterruptedWork([journal], deps);

    expect(outcomes[0]).toMatchObject({ action: 'tools-reported' });
    expect(deps.resumeTurn).not.toHaveBeenCalled();

    expect(unit.settleInterruptedToolCalls).toHaveBeenCalledWith([
      expect.objectContaining({
        toolCallId: 'b',
        toolName: 'bash',
        text: INTERRUPTED_TOOL_RESULT_TEXT,
      }),
    ]);
    expect(deps.emitLick).toHaveBeenCalledWith({
      type: 'session-reload',
      targetScoop: 'cone',
      timestamp: expect.any(String),
      body: {
        reason: TOOL_CALL_INTERRUPTED_REASON,
        interruptedAt: '2026-09-18T10:00:00.000Z',
        tools: [
          { toolName: 'bash', toolCallId: 'b', args: '{"command":"sleep 60"}' },
          { toolName: 'read_file', toolCallId: 'z', args: '{}' },
        ],
      },
    });
  });

  it("a guest's interrupted tool calls get an error notice, not an owner-authority lick", async () => {
    const unit = unitStub([user('go'), assistant('', [{ id: 'b', name: 'bash' }])]);
    const deps = depsFor(unit);
    await recoverInterruptedWork([turnRecord({ guestGates: [{ requester: 'guest-1' }] })], deps);
    expect(deps.emitLick).not.toHaveBeenCalled();
    expect(unit.settleInterruptedToolCalls).toHaveBeenCalled();
    expect(unit.reportError).toHaveBeenCalledWith(expect.stringContaining('bash was running'));
  });

  it('pluralizes the guest notice for several calls', async () => {
    const unit = unitStub([
      user('go'),
      assistant('', [
        { id: 'a', name: 'bash' },
        { id: 'b', name: 'read_file' },
      ]),
    ]);
    await recoverInterruptedWork([turnRecord({ guestGates: [{ requester: 'g' }] })], depsFor(unit));
    expect(unit.reportError).toHaveBeenCalledWith(
      expect.stringContaining('bash, read_file were running')
    );
  });

  it('a unit already busy again only gets its lost tool calls reported', async () => {
    const busyTools = unitStub([user('go'), assistant('', [{ id: 'b', name: 'bash' }])], {
      isBusy: true,
    });
    const deps = depsFor(busyTools);
    expect((await recoverInterruptedWork([turnRecord()], deps))[0]).toMatchObject({
      action: 'tools-reported',
    });
    expect(deps.journal.clear).not.toHaveBeenCalled();
    expect(busyTools.settleInterruptedToolCalls).not.toHaveBeenCalled();
    expect(deps.emitLick).toHaveBeenCalledTimes(1);

    const busyTurn = unitStub([user('hi')], { isBusy: true });
    const deps2 = depsFor(busyTurn);
    expect((await recoverInterruptedWork([turnRecord()], deps2))[0]).toMatchObject({
      action: 'superseded',
    });
    expect(deps2.resumeTurn).not.toHaveBeenCalled();
  });

  it('clears a record whose turn actually finished', async () => {
    const deps = depsFor(unitStub([user('hi'), assistant('done')]));
    expect((await recoverInterruptedWork([turnRecord()], deps))[0]).toMatchObject({
      action: 'none',
    });
    expect(deps.journal.clear).toHaveBeenCalledWith('cone_1');
  });

  it('skips (and clears) units that are gone or cannot run', async () => {
    const gone = depsFor(undefined);
    expect((await recoverInterruptedWork([turnRecord()], gone))[0]).toMatchObject({
      action: 'skipped',
    });
    expect(gone.journal.clear).toHaveBeenCalled();

    const noAgent = depsFor(unitStub([user('hi')], { hasAgent: () => false }));
    expect((await recoverInterruptedWork([turnRecord()], noAgent))[0]).toMatchObject({
      action: 'skipped',
    });

    const journal = { clear: vi.fn(async () => {}), isLive: vi.fn(() => true) };
    await recoverInterruptedWork([turnRecord()], depsFor(undefined, { journal }));
    expect(journal.clear).not.toHaveBeenCalled();
  });

  it('one failing unit does not stop the others', async () => {
    const getUnit = vi
      .fn<(jid: string) => RecoverableUnit | undefined>()
      .mockImplementationOnce(() => {
        throw new Error('boom');
      })
      .mockImplementation(() => unitStub([user('hi')]));
    const outcomes = await recoverInterruptedWork(
      [turnRecord({ jid: 'a' }), turnRecord({ jid: 'b' })],
      depsFor(undefined, { getUnit })
    );
    expect(outcomes.map((o) => o.action)).toEqual(['skipped', 'resumed']);
  });
});
