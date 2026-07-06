// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNestedInAnotherFrame, nudgeIframeRepaint } from '../../src/ui/iframe-repaint.js';

describe('isNestedInAnotherFrame', () => {
  it('is false at the top level (jsdom: self === top)', () => {
    expect(isNestedInAnotherFrame()).toBe(false);
  });
});

describe('nudgeIframeRepaint', () => {
  // Manual rAF queue so we control when the two-frame restore runs.
  let rafQueue: FrameRequestCallback[];
  beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
  });
  afterEach(() => vi.unstubAllGlobals());
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
    expect(iframe.style.display).toBe('none'); // hidden immediately
    flushFrame();
    expect(iframe.style.display).toBe('none'); // still hidden after 1 frame
    flushFrame();
    expect(iframe.style.display).toBe('block'); // restored after 2 frames
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
    // First nudge — display is now 'none', restore pending.
    nudgeIframeRepaint(iframe);
    expect(iframe.style.display).toBe('none');
    // A second nudge lands mid-flight (the dip mount fires from both the load
    // handler and an IntersectionObserver). It must NOT read 'none' as the
    // restore value, and its onDone still runs.
    const onDone2 = vi.fn();
    nudgeIframeRepaint(iframe, onDone2);
    expect(onDone2).toHaveBeenCalledTimes(1); // skipped → callback ran synchronously
    // Flush the first nudge's two frames → restored to the ORIGINAL 'block',
    // not stuck at 'none'.
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
    // A fresh nudge works (the in-flight guard cleared).
    nudgeIframeRepaint(iframe);
    expect(iframe.style.display).toBe('none');
    flushFrame();
    flushFrame();
    expect(iframe.style.display).toBe('block');
  });
});
