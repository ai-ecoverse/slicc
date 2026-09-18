/**
 * Orchestrator wiring for reload recovery: the turn journal is snapshotted at
 * boot, threaded into every unit, and consumed exactly once by
 * `recoverInterruptedWork`. The recovery policy itself is covered in
 * `interrupted-work-recovery.test.ts`.
 */
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteScoop, getAllScoops, initDB, saveScoop } from '../../src/scoops/db.js';
import { Orchestrator } from '../../src/scoops/orchestrator.js';
import { TurnJournal } from '../../src/scoops/scoop-context/turn-journal.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

const cone: RegisteredScoop = {
  jid: 'cone_rr_1',
  name: 'cone',
  folder: 'cone',
  parentJid: null,
  requiresTrigger: false,
  assistantLabel: 'sliccy',
  addedAt: new Date().toISOString(),
};

function noopCallbacks() {
  return {
    onResponse: vi.fn(),
    onResponseDone: vi.fn(),
    onSendMessage: vi.fn(),
    onStatusChange: vi.fn(),
    onError: vi.fn(),
    getBrowserAPI: vi.fn(() => ({}) as never),
  };
}

describe('Orchestrator reload recovery wiring', () => {
  let orch: Orchestrator | undefined;
  let windowWasShimmed = false;

  beforeAll(() => {
    // TaskScheduler.start() calls window.setInterval; vitest runs in node.
    if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
      (globalThis as { window?: unknown }).window = globalThis;
      windowWasShimmed = true;
    }
  });

  afterAll(() => {
    if (windowWasShimmed) delete (globalThis as { window?: unknown }).window;
  });

  beforeEach(async () => {
    await initDB();
    for (const jid of Object.keys(await getAllScoops())) await deleteScoop(jid);
  });

  afterEach(async () => {
    await orch?.shutdown();
    orch = undefined;
  });

  it('recovers the turns the previous page life left running, once', async () => {
    await saveScoop(cone);
    // The previous page life: one turn on the cone, one on a unit since dropped.
    const previous = new TurnJournal();
    previous.begin(cone.jid, cone.folder);
    previous.begin('scoop_gone', 'gone');
    await previous.flush();

    orch = new Orchestrator({ appendChild: () => {} } as unknown as HTMLElement, noopCallbacks());
    await orch.init();

    // Every unit is handed the journal.
    const context = orch.getScoopContext(cone.jid) as unknown as { turnJournal: unknown };
    expect(context.turnJournal).toBeInstanceOf(TurnJournal);

    const emitLick = vi.fn();
    const outcomes = await orch.recoverInterruptedWork(emitLick);
    // No model is configured in the test, so the cone has no agent to resume
    // on; the dropped unit no longer exists. Both are skipped and cleared.
    expect(outcomes.map((o) => [o.jid, o.action]).sort()).toEqual([
      [cone.jid, 'skipped'],
      ['scoop_gone', 'skipped'],
    ]);
    expect(emitLick).not.toHaveBeenCalled();
    expect(await new TurnJournal().readAll()).toEqual([]);

    // Consumed: a second call has nothing left to do.
    expect(await orch.recoverInterruptedWork(emitLick)).toEqual([]);
  });

  it('does nothing when no turn was left running', async () => {
    await saveScoop(cone);
    orch = new Orchestrator({ appendChild: () => {} } as unknown as HTMLElement, noopCallbacks());
    await orch.init();
    expect(await orch.recoverInterruptedWork(vi.fn())).toEqual([]);
  });
});
