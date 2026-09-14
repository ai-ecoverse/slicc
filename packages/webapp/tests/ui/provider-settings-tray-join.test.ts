// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testOnlyDispatchTrayJoinWithFailureFeedback as dispatch } from '../../src/ui/provider-settings.js';

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

      const dismissCallback = vi.fn();
      const dismissTimer = setTimeout(dismissCallback, 800);
      statusEl.dataset.dismissTimer = String(dismissTimer);

      let capturedRequestId: string | undefined;
      window.addEventListener('slicc:tray-join', (e) => {
        capturedRequestId = (e as CustomEvent<{ requestId: string }>).detail.requestId;
      });

      dispatch('https://tray.example/join/token', statusEl);

      window.dispatchEvent(
        new CustomEvent('slicc:tray-join-failed', {
          detail: {
            joinUrl: 'https://tray.example/join/token',
            error: 'IMS auth failed',
            requestId: capturedRequestId,
          },
        })
      );

      vi.advanceTimersByTime(1_000);
      expect(dismissCallback).not.toHaveBeenCalled();

      expect(statusEl.textContent).toContain('IMS auth failed');
      expect(statusEl.textContent).toContain('Reload the page');

      expect(statusEl.dataset.dismissTimer).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a failure event with a non-matching requestId (double-Connect isolation)', () => {
    const statusEl = makeStatusEl();
    dispatch('https://tray.example/join/token', statusEl);

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

    statusEl.remove();

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

      expect(statusEl.textContent).toBe('');

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

      vi.advanceTimersByTime(10_001);

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
