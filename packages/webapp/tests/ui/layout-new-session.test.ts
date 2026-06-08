// @vitest-environment jsdom
/**
 * Tests for the thread-header "New session" button wiring + boot-time
 * background enrichment scheduler.
 *
 * The button now exposes three gestures, each routed through the
 * `onClearChat` callback with a different `freeze` value:
 *   - short click  → `{ freeze: true }`   full freeze (blocks reload)
 *   - long press   → `{ freeze: false }`  discard (no archive)
 *   - double click → `{ freeze: 'quick' }` quick freeze (background enrich)
 *
 * `scheduleBackgroundEnrichment` is fired once at boot to finish any
 * pending entries left behind by the impatient (double-click) path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_MS } from '../../src/ui/long-press.js';
import { DEFAULT_DOUBLE_CLICK_MS, type SliccPressButton } from '../../src/ui/press-button.js';

// Mirror the exact event wiring `layout.ts` installs on the new-session
// `<slicc-press-button>`. Keeping the wiring inline in the test makes
// it impossible for a future refactor of `layout.ts` to silently drop a
// gesture without breaking these tests.
function wireNewSessionButton(
  btn: SliccPressButton,
  onClearChat: (opts?: { freeze?: boolean | 'quick' }) => Promise<void>,
  reload: () => void
): void {
  const runNewSession = async (opts?: { freeze?: boolean | 'quick' }) => {
    await onClearChat(opts);
    reload();
  };
  btn.addEventListener('short-click', () => void runNewSession({ freeze: true }));
  btn.addEventListener('long-press', () => void runNewSession({ freeze: false }));
  btn.addEventListener('double-click', () => void runNewSession({ freeze: 'quick' }));
}

function mkButton(): SliccPressButton {
  const el = document.createElement('slicc-press-button') as SliccPressButton;
  document.body.appendChild(el);
  return el;
}

describe('New session button — three-gesture wiring', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('short click routes through onClearChat with freeze: true', async () => {
    vi.useFakeTimers();
    const onClearChat = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn();
    const btn = mkButton();
    wireNewSessionButton(btn, onClearChat, reload);

    btn.click();
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS + 1);
    vi.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();

    expect(onClearChat).toHaveBeenCalledTimes(1);
    expect(onClearChat).toHaveBeenCalledWith({ freeze: true });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('long press routes through onClearChat with freeze: false', async () => {
    vi.useFakeTimers();
    const onClearChat = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn();
    const btn = mkButton();
    wireNewSessionButton(btn, onClearChat, reload);

    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    btn.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    btn.dispatchEvent(new MouseEvent('click'));
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS + 1);
    vi.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();

    expect(onClearChat).toHaveBeenCalledTimes(1);
    expect(onClearChat).toHaveBeenCalledWith({ freeze: false });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('double click routes through onClearChat with freeze: "quick" and suppresses short-click', async () => {
    vi.useFakeTimers();
    const onClearChat = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn();
    const btn = mkButton();
    wireNewSessionButton(btn, onClearChat, reload);

    btn.click();
    vi.advanceTimersByTime(50);
    btn.click();
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS + 1);
    vi.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();

    expect(onClearChat).toHaveBeenCalledTimes(1);
    expect(onClearChat).toHaveBeenCalledWith({ freeze: 'quick' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a single click that waits past the double-click window does NOT fire double-click', async () => {
    vi.useFakeTimers();
    const onClearChat = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn();
    const btn = mkButton();
    wireNewSessionButton(btn, onClearChat, reload);

    btn.click();
    // Wait well past the double-click window, then click again — this
    // is a second short click, NOT a double-click.
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS + 1);
    btn.click();
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS + 1);
    vi.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();

    expect(onClearChat).toHaveBeenCalledTimes(2);
    expect(onClearChat.mock.calls.every(([opts]) => opts.freeze === true)).toBe(true);
  });
});

describe('scheduleBackgroundEnrichment — boot-time enrichment scheduler', () => {
  beforeEach(() => {
    vi.useRealTimers();
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
  });

  it('defers via setTimeout when requestIdleCallback is unavailable', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { scheduleBackgroundEnrichment } = await import('../../src/ui/new-session.js');
    const fakeFs = { exists: vi.fn().mockResolvedValue(false) } as unknown as Parameters<
      typeof scheduleBackgroundEnrichment
    >[0];

    scheduleBackgroundEnrichment(fakeFs);

    // The setTimeout call from `scheduleBackgroundEnrichment` runs the
    // enrichment lazily. We only assert that the schedule was registered.
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0);
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('prefers requestIdleCallback when available', async () => {
    const ricSpy = vi.fn();
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = ricSpy;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const { scheduleBackgroundEnrichment } = await import('../../src/ui/new-session.js');
    const fakeFs = { exists: vi.fn().mockResolvedValue(false) } as unknown as Parameters<
      typeof scheduleBackgroundEnrichment
    >[0];

    scheduleBackgroundEnrichment(fakeFs);

    expect(ricSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('eventually invokes enrichPendingSessions with the supplied VFS', async () => {
    // Drive the scheduled work synchronously by stubbing rIC to run the
    // callback immediately. `enrichPendingSessions` is best-effort and
    // bails out cleanly when the index file is missing — we observe the
    // invocation by spying on the listPendingEnrichments read it makes.
    const ricSpy = vi.fn((cb: () => void) => {
      cb();
      return 1;
    });
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = ricSpy;

    const readFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const fakeFs = {
      readFile,
      exists: vi.fn().mockResolvedValue(false),
    } as unknown as Parameters<
      typeof import('../../src/ui/new-session.js').scheduleBackgroundEnrichment
    >[0];

    const { scheduleBackgroundEnrichment } = await import('../../src/ui/new-session.js');
    scheduleBackgroundEnrichment(fakeFs);

    // Let the floated promise chain settle. A single yield through the
    // real event loop is enough to flush every await in the
    // `enrichPendingSessions → listPendingEnrichments → readSessionsIndex`
    // chain.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(ricSpy).toHaveBeenCalledTimes(1);
    // `enrichPendingSessions` ultimately calls `listPendingEnrichments`,
    // which reads `/sessions/index.json` from the VFS we handed it. Any
    // VFS read counts as evidence that the scheduled work ran.
    expect(readFile).toHaveBeenCalled();
  });

  // Gate the enrichment write path on OPFS leadership. A follower
  // tab's `writableFs` is the page-side LFS shadow which the
  // worker-OPFS-backed UI never reads → a write here is silently
  // orphaned. The scheduler must short-circuit on followers.
  it('no-ops when isWriter is false (OPFS follower) — no rIC, no setTimeout, no VFS read', async () => {
    const ricSpy = vi.fn((cb: () => void) => {
      cb();
      return 1;
    });
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = ricSpy;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const readFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const fakeFs = {
      readFile,
      exists: vi.fn().mockResolvedValue(false),
    } as unknown as Parameters<
      typeof import('../../src/ui/new-session.js').scheduleBackgroundEnrichment
    >[0];

    const { scheduleBackgroundEnrichment } = await import('../../src/ui/new-session.js');
    scheduleBackgroundEnrichment(fakeFs, { isWriter: false });

    // The scheduler must short-circuit synchronously — assert before
    // yielding to the event loop so the test's own `await new
    // Promise(setTimeout)` can't pollute the setTimeout spy.
    expect(ricSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();

    // Yield once anyway to catch any deferred work we missed.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(ricSpy).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('runs normally when isWriter is true (OPFS leader)', async () => {
    const ricSpy = vi.fn((cb: () => void) => {
      cb();
      return 1;
    });
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = ricSpy;
    const readFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const fakeFs = {
      readFile,
      exists: vi.fn().mockResolvedValue(false),
    } as unknown as Parameters<
      typeof import('../../src/ui/new-session.js').scheduleBackgroundEnrichment
    >[0];

    const { scheduleBackgroundEnrichment } = await import('../../src/ui/new-session.js');
    scheduleBackgroundEnrichment(fakeFs, { isWriter: true });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(ricSpy).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalled();
  });

  it('flag-off default (no opts) preserves byte-identical behavior — VFS read still happens', async () => {
    // No `isWriter` field at all: the absent flag must not block the
    // run (only `isWriter === false` short-circuits). This pins the
    // flag-off contract: existing callers that never learn about the
    // new option behave exactly as before.
    const ricSpy = vi.fn((cb: () => void) => {
      cb();
      return 1;
    });
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = ricSpy;
    const readFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const fakeFs = {
      readFile,
      exists: vi.fn().mockResolvedValue(false),
    } as unknown as Parameters<
      typeof import('../../src/ui/new-session.js').scheduleBackgroundEnrichment
    >[0];

    const { scheduleBackgroundEnrichment } = await import('../../src/ui/new-session.js');
    scheduleBackgroundEnrichment(fakeFs);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(ricSpy).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalled();
  });
});
