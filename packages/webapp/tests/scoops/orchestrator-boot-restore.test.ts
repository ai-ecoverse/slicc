/**
 * Boot must not wait on every scoop context.
 *
 * Measured shape: N contexts that each take `delayMs`. A sequential restore
 * holds `init()` for N * delayMs. After this change `init()` returns once the
 * root wave finishes (ceil(roots / SCOOP_BOOT_CONCURRENCY) * delayMs) and
 * child contexts settle in the background under the same cap.
 */
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteScoop, getAllScoops, initDB, saveScoop } from '../../src/scoops/db.js';
import { Orchestrator } from '../../src/scoops/orchestrator.js';
import { SCOOP_BOOT_CONCURRENCY } from '../../src/scoops/scoop-boot-restore.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

const DELAY_MS = 40;

function noopCallbacks() {
  return {
    onResponse: vi.fn(),
    onResponseDone: vi.fn(),
    onSendMessage: vi.fn(),
    onStatusChange: vi.fn(),
    onError: vi.fn(),
    getBrowserAPI: vi.fn(() => ({}) as any),
  };
}

function scoop(jid: string, isCone: boolean): RegisteredScoop {
  return {
    jid,
    name: isCone ? 'cone' : jid,
    folder: isCone ? jid : `${jid}-folder`,
    parentJid: isCone ? null : 'cone_boot_0',
    requiresTrigger: false,
    assistantLabel: isCone ? 'sliccy' : jid,
    addedAt: new Date().toISOString(),
  };
}

function lifecycleOf(orch: Orchestrator): {
  openTab(jid: string): Promise<void>;
  getTab(jid: string): { status: string; error?: string } | undefined;
} {
  return (
    orch as unknown as {
      lifecycle: {
        openTab(jid: string): Promise<void>;
        getTab(jid: string): { status: string; error?: string } | undefined;
      };
    }
  ).lifecycle;
}

describe('orchestrator boot restore is not proportional to scoop count', () => {
  let orch: Orchestrator | undefined;
  let windowWasShimmed = false;

  beforeAll(() => {
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
    vi.restoreAllMocks();
  });

  it('returns from init after the root wave and caps how many contexts run at once', async () => {
    const rootCount = 2;
    const childCount = 12;
    await saveScoop(scoop('cone_boot_0', true));
    await saveScoop(scoop('cone_boot_1', true));
    for (let i = 0; i < childCount; i += 1) await saveScoop(scoop(`scoop_boot_${i}`, false));

    const container = { appendChild: () => {} } as unknown as HTMLElement;
    orch = new Orchestrator(container, noopCallbacks());

    let inFlight = 0;
    let maxInFlight = 0;
    let restoreStarted = 0;
    const finished: string[] = [];
    vi.spyOn(lifecycleOf(orch), 'openTab').mockImplementation(async (jid: string) => {
      if (restoreStarted === 0) restoreStarted = performance.now();
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      inFlight -= 1;
      finished.push(jid);
    });

    const stages: string[] = [];
    await orch.init((stage) => stages.push(stage));
    const restoreMs = performance.now() - restoreStarted;

    // Sequential lower bound is (rootCount + childCount) * DELAY_MS.
    // init waits for the root wave only.
    expect(restoreMs).toBeLessThan(DELAY_MS * childCount);
    expect(finished).toHaveLength(rootCount);
    expect(finished.every((jid) => jid.startsWith('cone_boot_'))).toBe(true);
    expect(stages.filter((stage) => stage.startsWith('scoop-restored:'))).toEqual(
      finished.map((jid) => `scoop-restored:${jid}`)
    );

    await orch.whenBootRestoresSettled();
    expect(finished).toHaveLength(rootCount + childCount);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(SCOOP_BOOT_CONCURRENCY);
    expect(stages.filter((stage) => stage.startsWith('scoop-restored:scoop_boot_'))).toHaveLength(
      childCount
    );
  });

  it('skips a child whose context fails without holding init or dropping the others', async () => {
    await saveScoop(scoop('cone_boot_0', true));
    await saveScoop(scoop('scoop_boot_ok', false));
    await saveScoop(scoop('scoop_boot_bad', false));

    const container = { appendChild: () => {} } as unknown as HTMLElement;
    orch = new Orchestrator(container, noopCallbacks());
    const lifecycle = lifecycleOf(orch);
    vi.spyOn(lifecycle, 'openTab').mockImplementation(async (jid: string) => {
      if (jid === 'scoop_boot_bad') throw new Error('Unexpected mismatch in file data size');
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    });

    const stages: string[] = [];
    await expect(orch.init((stage) => stages.push(stage))).resolves.toBeUndefined();
    expect(stages).toContain('scoop-restored:cone_boot_0');
    // The healthy child is still inside its delay, so init did not wait for it.
    expect(stages).not.toContain('scoop-restored:scoop_boot_ok');

    await orch.whenBootRestoresSettled();
    expect(stages).toContain('scoop-restored:scoop_boot_ok');
    expect(stages).toContain('scoop-restored:scoop_boot_bad');
    expect(lifecycle.getTab('scoop_boot_bad')).toMatchObject({
      status: 'error',
      error: 'Unexpected mismatch in file data size',
    });
    expect(lifecycle.getTab('scoop_boot_ok')?.status).not.toBe('error');
  });

  it('joins an in-flight child create instead of starting a second one', async () => {
    await saveScoop(scoop('cone_boot_0', true));
    await saveScoop(scoop('scoop_boot_0', false));

    const container = { appendChild: () => {} } as unknown as HTMLElement;
    orch = new Orchestrator(container, noopCallbacks());
    const calls = new Map<string, number>();
    vi.spyOn(lifecycleOf(orch), 'openTab').mockImplementation(async (jid: string) => {
      calls.set(jid, (calls.get(jid) ?? 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    });

    await orch.init();
    expect(calls.get('scoop_boot_0')).toBe(1);
    await orch.createScoopTab('scoop_boot_0');
    await orch.whenBootRestoresSettled();
    expect(calls.get('scoop_boot_0')).toBe(1);
    expect(calls.get('cone_boot_0')).toBe(1);
  });
});
