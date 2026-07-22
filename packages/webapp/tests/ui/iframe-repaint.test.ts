// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNestedInAnotherFrame, nudgeIframeRepaint } from '../../src/ui/iframe-repaint.js';

describe('isNestedInAnotherFrame', () => {
  it('is false at the top level (jsdom: self === top)', () => {
    expect(isNestedInAnotherFrame()).toBe(false);
  });
});

describe('nudgeIframeRepaint', () => {
  let rafQueue: FrameRequestCallback[];
  beforeEach(() => {
    vi.useFakeTimers();
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const flushFrame = () => {
    const batch = rafQueue;
    rafQueue = [];
    for (const cb of batch) cb(0);
  };

  function makeIframe(display = 'block'): HTMLIFrameElement {
    const el = document.createElement('iframe');
    el.style.display = display;
    document.body.append(el);
    return el;
  }

  it('toggles display off then restores the original across two frames', () => {
    const iframe = makeIframe('block');
    nudgeIframeRepaint(iframe);
    expect(iframe.style.display).toBe('none');
    flushFrame();
    expect(iframe.style.display).toBe('none');
    flushFrame();
    expect(iframe.style.display).toBe('block');
  });

  it('runs onDone after the restore', () => {
    const iframe = makeIframe('block');
    const onDone = vi.fn();
    nudgeIframeRepaint(iframe, onDone);
    flushFrame();
    expect(onDone).not.toHaveBeenCalled();
    flushFrame();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('is re-entrancy-safe: an overlapping nudge does NOT capture the transient none (regression)', () => {
    const iframe = makeIframe('block');
    nudgeIframeRepaint(iframe);
    expect(iframe.style.display).toBe('none');
    const onDone2 = vi.fn();
    nudgeIframeRepaint(iframe, onDone2);
    expect(onDone2).toHaveBeenCalledTimes(1);
    flushFrame();
    flushFrame();
    expect(iframe.style.display).toBe('block');
  });

  it('can nudge again after the previous nudge completes', () => {
    const iframe = makeIframe('block');
    nudgeIframeRepaint(iframe);
    flushFrame();
    flushFrame();
    expect(iframe.style.display).toBe('block');
    nudgeIframeRepaint(iframe);
    expect(iframe.style.display).toBe('none');
    flushFrame();
    flushFrame();
    expect(iframe.style.display).toBe('block');
  });

  describe('safety-net retry (500ms)', () => {
    it('does NOT retry when rAF restored successfully (compositor responsive)', () => {
      const iframe = makeIframe('block');
      nudgeIframeRepaint(iframe);
      // rAF restores normally
      flushFrame();
      flushFrame();
      expect(iframe.style.display).toBe('block');
      // Advance past the 500ms retry window
      vi.advanceTimersByTime(500);
      // No second nudge — display should still be block (not toggled to none)
      expect(iframe.style.display).toBe('block');
    });

    it('retries at 500ms when rAF was starved and setTimeout fallback restored', () => {
      const iframe = makeIframe('block');
      nudgeIframeRepaint(iframe);
      expect(iframe.style.display).toBe('none');
      // Don't flush rAF — let the 100ms setTimeout fallback restore
      vi.advanceTimersByTime(100);
      expect(iframe.style.display).toBe('block');
      // Now at 500ms the retry fires since rAF didn't restore
      vi.advanceTimersByTime(400);
      expect(iframe.style.display).toBe('none'); // retry toggled it
      // Flush retry's rAF to restore
      flushFrame();
      flushFrame();
      expect(iframe.style.display).toBe('block');
    });

    it('is a no-op when iframe is disconnected before retry fires', () => {
      const iframe = makeIframe('block');
      nudgeIframeRepaint(iframe);
      // setTimeout fallback restores (rAF starved)
      vi.advanceTimersByTime(100);
      expect(iframe.style.display).toBe('block');
      // Detach the iframe before the retry
      iframe.remove();
      vi.advanceTimersByTime(400);
      // No crash, no toggle
      expect(iframe.style.display).toBe('block');
    });

    it('does not schedule further retries from the retry itself', () => {
      const iframe = makeIframe('block');
      nudgeIframeRepaint(iframe);
      // setTimeout fallback restores
      vi.advanceTimersByTime(100);
      expect(iframe.style.display).toBe('block');
      // 500ms retry fires
      vi.advanceTimersByTime(400);
      expect(iframe.style.display).toBe('none');
      // Restore via rAF
      flushFrame();
      flushFrame();
      expect(iframe.style.display).toBe('block');
      // Advance another 500ms — no third nudge
      vi.advanceTimersByTime(500);
      expect(iframe.style.display).toBe('block');
    });
  });

  describe('setTimeout(100ms) rAF fallback', () => {
    it('restores display when rAF is starved', () => {
      const iframe = makeIframe('flex');
      nudgeIframeRepaint(iframe);
      expect(iframe.style.display).toBe('none');
      // Don't flush rAF at all — advance time to trigger the 100ms fallback
      vi.advanceTimersByTime(100);
      expect(iframe.style.display).toBe('flex');
    });

    it('onDone fires exactly once even when both rAF and setTimeout resolve', () => {
      const iframe = makeIframe('block');
      const onDone = vi.fn();
      nudgeIframeRepaint(iframe, onDone);
      // Let setTimeout fire first
      vi.advanceTimersByTime(100);
      expect(onDone).toHaveBeenCalledTimes(1);
      // Now flush rAF — onDone must NOT fire again
      flushFrame();
      flushFrame();
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  describe('missing requestAnimationFrame (regression: #1603 merge-queue flake)', () => {
    it('does not throw and restores via the setTimeout ceiling when rAF is unavailable', () => {
      // The real flake: the 500ms safety-net setTimeout fired AFTER a test tore
      // down its jsdom global, so `performNudge` hit an undefined
      // `requestAnimationFrame` and threw an unhandled error that failed the
      // whole vitest run. Simulate rAF being absent throughout — both the direct
      // performNudge and the 500ms safety-net retry must fall back to the
      // setTimeout ceiling without throwing.
      vi.stubGlobal('requestAnimationFrame', undefined);
      const iframe = makeIframe('block');

      expect(() => nudgeIframeRepaint(iframe)).not.toThrow();
      expect(iframe.style.display).toBe('none'); // toggled off, rAF skipped
      // No rAF → the 100ms setTimeout ceiling restores it.
      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
      expect(iframe.style.display).toBe('block');
      // The 500ms safety-net retry re-enters performNudge with rAF still absent —
      // the exact path that threw in the flake. It must not throw.
      expect(() => vi.advanceTimersByTime(400)).not.toThrow();
      expect(iframe.style.display).toBe('none'); // retry toggled off
      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
      expect(iframe.style.display).toBe('block'); // retry's ceiling restored it
    });
  });
});
