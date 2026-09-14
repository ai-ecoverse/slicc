// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNestedInAnotherFrame, nudgeIframeRepaint } from '../src/iframe-repaint.js';

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

      flushFrame();
      flushFrame();
      expect(iframe.style.display).toBe('block');

      vi.advanceTimersByTime(500);

      expect(iframe.style.display).toBe('block');
    });

    it('retries at 500ms when rAF was starved and setTimeout fallback restored', () => {
      const iframe = makeIframe('block');
      nudgeIframeRepaint(iframe);
      expect(iframe.style.display).toBe('none');

      vi.advanceTimersByTime(100);
      expect(iframe.style.display).toBe('block');

      vi.advanceTimersByTime(400);
      expect(iframe.style.display).toBe('none');

      flushFrame();
      flushFrame();
      expect(iframe.style.display).toBe('block');
    });

    it('is a no-op when iframe is disconnected before retry fires', () => {
      const iframe = makeIframe('block');
      nudgeIframeRepaint(iframe);

      vi.advanceTimersByTime(100);
      expect(iframe.style.display).toBe('block');

      iframe.remove();
      vi.advanceTimersByTime(400);

      expect(iframe.style.display).toBe('block');
    });

    it('does not schedule further retries from the retry itself', () => {
      const iframe = makeIframe('block');
      nudgeIframeRepaint(iframe);

      vi.advanceTimersByTime(100);
      expect(iframe.style.display).toBe('block');

      vi.advanceTimersByTime(400);
      expect(iframe.style.display).toBe('none');

      flushFrame();
      flushFrame();
      expect(iframe.style.display).toBe('block');

      vi.advanceTimersByTime(500);
      expect(iframe.style.display).toBe('block');
    });
  });

  describe('setTimeout(100ms) rAF fallback', () => {
    it('restores display when rAF is starved', () => {
      const iframe = makeIframe('flex');
      nudgeIframeRepaint(iframe);
      expect(iframe.style.display).toBe('none');

      vi.advanceTimersByTime(100);
      expect(iframe.style.display).toBe('flex');
    });

    it('onDone fires exactly once even when both rAF and setTimeout resolve', () => {
      const iframe = makeIframe('block');
      const onDone = vi.fn();
      nudgeIframeRepaint(iframe, onDone);

      vi.advanceTimersByTime(100);
      expect(onDone).toHaveBeenCalledTimes(1);

      flushFrame();
      flushFrame();
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  describe('missing requestAnimationFrame (regression: #1603 merge-queue flake)', () => {
    it('does not throw and restores via the setTimeout ceiling when rAF is unavailable', () => {
      vi.stubGlobal('requestAnimationFrame', undefined);
      const iframe = makeIframe('block');

      expect(() => nudgeIframeRepaint(iframe)).not.toThrow();
      expect(iframe.style.display).toBe('none');

      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
      expect(iframe.style.display).toBe('block');

      expect(() => vi.advanceTimersByTime(400)).not.toThrow();
      expect(iframe.style.display).toBe('none');
      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
      expect(iframe.style.display).toBe('block');
    });
  });
});
