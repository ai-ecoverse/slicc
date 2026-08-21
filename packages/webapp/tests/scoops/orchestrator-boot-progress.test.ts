/**
 * Regression coverage for the boot-progress heartbeat (#2007).
 *
 * `orchestrator.init(onBootProgress)` fires the callback once per restored
 * scoop (success OR context-init skip), so the page's kernel-ready watchdog
 * re-arms through a slow multi-scoop restore instead of firing mid-progress.
 * Kept in its own file so it doesn't touch `orchestrator.test.ts`, which is
 * still on the floating-promise debt list.
 */
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteScoop, getAllScoops, initDB, saveScoop } from '../../src/scoops/db.js';
import { Orchestrator } from '../../src/scoops/orchestrator.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

function noopCallbacks() {
  return {
    onResponse: vi.fn(),
    onResponseDone: vi.fn(),
    onSendMessage: vi.fn(),
    onStatusChange: vi.fn(),
    onError: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
    getBrowserAPI: vi.fn(() => ({}) as any),
  };
}

function scoop(jid: string, isCone: boolean): RegisteredScoop {
  return {
    jid,
    name: isCone ? 'cone' : jid,
    folder: isCone ? 'cone' : `${jid}-folder`,
    isCone,
    parentJid: isCone ? null : 'cone',
    type: isCone ? 'cone' : 'scoop',
    requiresTrigger: false,
    assistantLabel: isCone ? 'sliccy' : jid,
    addedAt: new Date().toISOString(),
  };
}

describe('orchestrator boot-progress heartbeat (#2007)', () => {
  let orch: Orchestrator | undefined;
  let priorWindow: unknown;
  let windowWasShimmed = false;

  beforeAll(() => {
    // TaskScheduler.start() calls window.setInterval; vitest runs in node.
    if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
      priorWindow = (globalThis as { window?: unknown }).window;
      (globalThis as { window?: unknown }).window = globalThis;
      windowWasShimmed = true;
    }
  });

  afterAll(() => {
    if (windowWasShimmed) {
      if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = priorWindow;
    }
  });

  beforeEach(async () => {
    await initDB();
    for (const jid of Object.keys(await getAllScoops())) await deleteScoop(jid);
  });

  afterEach(async () => {
    await orch?.shutdown();
    orch = undefined;
  });

  it('fires onBootProgress once per restored scoop', async () => {
    await saveScoop(scoop('cone_bp_1', true));
    await saveScoop(scoop('scoop_bp_1', false));

    const container = { appendChild: () => {} } as unknown as HTMLElement;
    orch = new Orchestrator(container, noopCallbacks());
    const stages: string[] = [];
    await orch.init((stage) => stages.push(stage));

    expect(stages).toContain('scoop-restored:cone_bp_1');
    expect(stages).toContain('scoop-restored:scoop_bp_1');
  });

  it('emits the shared-fs mount start beat (2026-08-18 cold-boot brick)', async () => {
    const container = { appendChild: () => {} } as unknown as HTMLElement;
    orch = new Orchestrator(container, noopCallbacks());
    const stages: string[] = [];
    await orch.init((stage) => stages.push(stage));
    // The mount phase is the boot's silent O(tree) stretch — the heartbeat
    // must announce it so the kernel-ready watchdog re-arms (#2007).
    expect(stages).toContain('shared-fs-mount:start');
  });

  it('is optional — init() with no callback still boots', async () => {
    await saveScoop(scoop('cone_bp_2', true));
    const container = { appendChild: () => {} } as unknown as HTMLElement;
    orch = new Orchestrator(container, noopCallbacks());
    await expect(orch.init()).resolves.toBeUndefined();
  });
});
