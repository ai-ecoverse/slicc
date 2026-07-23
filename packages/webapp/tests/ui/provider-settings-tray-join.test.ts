// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testOnlyDispatchTrayJoinWithFailureFeedback as dispatch } from '../../src/ui/provider-settings.js';

/**
 * Tests for `dispatchTrayJoinWithFailureFeedback` — the helper that
 * surfaces tray-join half-state failures to the dialog's status
 * element. This is the R11-fix the user found by hand; R12 adds
 * regression coverage.
 *
 * The helper:
 *   1. Dispatches a `slicc:tray-join` CustomEvent with a fresh
 *      `requestId` carried in `detail`.
 *   2. Wires a one-shot `slicc:tray-join-failed` listener that
 *      filters by `requestId` (so double-Connect doesn't bleed),
 *      cancels the optimistic dismiss timer (so the dialog stays
 *      visible with the error), and updates the status element.
 *   3. Returns a cancel function for proactive cleanup.
 *   4. Auto-removes the listener after 10s.
 *
 * Listener also handles the detached-element case (log + skip).
 */

function makeStatusEl(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function clearBody(): void {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
}

describe('dispatchTrayJoinWithFailureFeedback', () => {
  beforeEach(clearBody);
  afterEach(clearBody);

  it('dispatches slicc:tray-join with a requestId in detail', () => {
    const statusEl = makeStatusEl();
    const captured: CustomEventInit<{ joinUrl: string; requestId?: string }>[] = [];
    const onJoin = (e: Event) => {
      const ce = e as CustomEvent<{ joinUrl: string; requestId?: string }>;
      captured.push({ detail: ce.detail });
    };
    window.addEventListener('slicc:tray-join', onJoin);
    const cancel = dispatch('https://tray.example/join/token', statusEl);
    cancel();
    window.removeEventListener('slicc:tray-join', onJoin);

    expect(captured).toHaveLength(1);
    expect(captured[0].detail?.joinUrl).toBe('https://tray.example/join/token');
    expect(typeof captured[0].detail?.requestId).toBe('string');
    expect(captured[0].detail?.requestId).toMatch(/^tray-join-/);
  });

  it('cancels the optimistic dismiss timer when the failure event fires', () => {
    vi.useFakeTimers();
    try {
      const statusEl = makeStatusEl();
      // Caller-side optimistic dismiss timer that the helper should cancel
      const dismissCallback = vi.fn();
      const dismissTimer = setTimeout(dismissCallback, 800);
      statusEl.dataset.dismissTimer = String(dismissTimer);

      // Capture the requestId so we can echo it on failure
      let capturedRequestId: string | undefined;
      window.addEventListener('slicc:tray-join', (e) => {
        capturedRequestId = (e as CustomEvent<{ requestId: string }>).detail.requestId;
      });

      dispatch('https://tray.example/join/token', statusEl);

      // Fire the failure event with the matching requestId
      window.dispatchEvent(
        new CustomEvent('slicc:tray-join-failed', {
          detail: {
            joinUrl: 'https://tray.example/join/token',
            error: 'IMS auth failed',
            requestId: capturedRequestId,
          },
        })
      );

      // Advance past the 800ms timer — the dismiss should NOT fire
      vi.advanceTimersByTime(1_000);
      expect(dismissCallback).not.toHaveBeenCalled();
      // Status element should show the error
      expect(statusEl.textContent).toContain('IMS auth failed');
      expect(statusEl.textContent).toContain('Reload the page');
      // Dataset should be cleared
      expect(statusEl.dataset.dismissTimer).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a failure event with a non-matching requestId (double-Connect isolation)', () => {
    const statusEl = makeStatusEl();
    dispatch('https://tray.example/join/token', statusEl);

    // Fire a failure event with a DIFFERENT requestId — should NOT update statusEl
    window.dispatchEvent(
      new CustomEvent('slicc:tray-join-failed', {
        detail: {
          joinUrl: 'https://tray.example/join/token',
          error: 'belongs to other attempt',
          requestId: 'tray-join-other',
        },
      })
    );

    expect(statusEl.textContent).toBe('');
  });

  it('logs at error level when the failure event arrives after statusEl is detached', () => {
    const statusEl = makeStatusEl();
    // Detach BEFORE the failure event arrives — simulates the user
    // closing the dialog before the catch path reaches the dispatch.
    statusEl.remove();

    // Capture the requestId so we can echo it
    let capturedRequestId: string | undefined;
    window.addEventListener('slicc:tray-join', (e) => {
      capturedRequestId = (e as CustomEvent<{ requestId: string }>).detail.requestId;
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      dispatch('https://tray.example/join/token', statusEl);
      window.dispatchEvent(
        new CustomEvent('slicc:tray-join-failed', {
          detail: {
            joinUrl: 'https://tray.example/join/token',
            error: 'late failure',
            requestId: capturedRequestId,
          },
        })
      );

      // statusEl is detached, so we shouldn't have written to it.
      expect(statusEl.textContent).toBe('');
      // Error log should be present so the half-state is auditable.
      const matched = errorSpy.mock.calls.some((args) =>
        String(args[1] ?? '').includes('UX swallowed half-state')
      );
      expect(matched).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returned cancel function detaches the listener proactively', () => {
    const statusEl = makeStatusEl();
    let capturedRequestId: string | undefined;
    window.addEventListener('slicc:tray-join', (e) => {
      capturedRequestId = (e as CustomEvent<{ requestId: string }>).detail.requestId;
    });

    const cancel = dispatch('https://tray.example/join/token', statusEl);
    cancel();

    // After cancel, a matching failure event should NOT update statusEl
    window.dispatchEvent(
      new CustomEvent('slicc:tray-join-failed', {
        detail: {
          joinUrl: 'https://tray.example/join/token',
          error: 'after cancel',
          requestId: capturedRequestId,
        },
      })
    );

    expect(statusEl.textContent).toBe('');
  });

  it('auto-removes the listener after 10s', () => {
    vi.useFakeTimers();
    try {
      const statusEl = makeStatusEl();
      let capturedRequestId: string | undefined;
      window.addEventListener('slicc:tray-join', (e) => {
        capturedRequestId = (e as CustomEvent<{ requestId: string }>).detail.requestId;
      });

      dispatch('https://tray.example/join/token', statusEl);
      // Advance past the 10s auto-cleanup
      vi.advanceTimersByTime(10_001);

      // After auto-cleanup, the listener is gone — failure event should be ignored
      window.dispatchEvent(
        new CustomEvent('slicc:tray-join-failed', {
          detail: {
            joinUrl: 'https://tray.example/join/token',
            error: 'too late',
            requestId: capturedRequestId,
          },
        })
      );

      expect(statusEl.textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});
