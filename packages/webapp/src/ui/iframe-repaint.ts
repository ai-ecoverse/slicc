/**
 * Whether this page itself is running inside another frame (e.g. a cherry
 * follower embedded in a third-party host page's iframe). A sprinkle's or
 * dip's own render iframe is then nested two levels deep instead of one,
 * which hits a Chromium first-paint bug: the innermost iframe's content
 * loads and executes correctly but the compositor never rasterizes it,
 * leaving the panel blank until something forces a full frame-tree repaint
 * (DevTools attaching, or a page reload). `nudgeIframeRepaint` works around
 * it without either of those.
 */
export function isNestedInAnotherFrame(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin access to `window.top` throws — that itself means we're
    // framed by a different origin, which is the case this guards against.
    return true;
  }
}

/** Iframes with a repaint nudge currently in flight (display toggled off,
 *  restore pending). Guards against overlapping nudges corrupting the restore
 *  value — see {@link nudgeIframeRepaint}. */
const nudgeInFlight = new WeakSet<HTMLIFrameElement>();

/**
 * Force the browser to redo the render/compositing pass for `iframe` by
 * toggling `display` off and back on across two animation frames. A resize
 * event or explicit layout read (`getBoundingClientRect`) does NOT trigger
 * the missing repaint for this bug — only a `display` toggle (or an
 * out-of-band event like DevTools attaching) does.
 *
 * In nested cross-origin frames (cherry follower inside a host page), the
 * single nudge on load can race with the compositor's frame-tree commit.
 * A safety-net retry fires after 500ms, but ONLY when the first nudge was
 * restored by the setTimeout fallback (indicating rAF was throttled and the
 * compositor likely didn't commit). When rAF fires normally the retry is
 * skipped — the compositor was responsive and the nudge almost certainly
 * took effect.
 *
 * Re-entrancy-safe: the dip mount fires this from BOTH the iframe `load`
 * handler AND an IntersectionObserver, which can overlap. A second call that
 * landed mid-nudge would read the transient `display:'none'` as
 * `previousDisplay` and "restore" the iframe to hidden — leaving dips
 * permanently invisible in nested followers (the extension side panel). When a
 * nudge is already pending we skip: the in-flight one will restore the correct
 * display, so we just run the callback.
 */
export function nudgeIframeRepaint(iframe: HTMLIFrameElement, onDone?: () => void): void {
  if (nudgeInFlight.has(iframe)) {
    onDone?.();
    return;
  }

  // Track whether rAF restored (compositor responsive) vs setTimeout fallback.
  let rafRestored = false;
  performNudge(iframe, onDone, () => {
    rafRestored = true;
  });

  // Safety-net retry: fires only when the first nudge fell back to setTimeout
  // (rAF was throttled), meaning the compositor likely didn't commit the frame
  // tree in time for the first toggle to take effect.
  setTimeout(() => {
    if (rafRestored) return;
    if (!iframe.isConnected) return;
    performNudge(iframe);
  }, 500);
}

function performNudge(
  iframe: HTMLIFrameElement,
  onDone?: () => void,
  onRafRestore?: () => void
): void {
  if (nudgeInFlight.has(iframe)) {
    onDone?.();
    return;
  }
  nudgeInFlight.add(iframe);
  const previousDisplay = iframe.style.display;
  iframe.style.display = 'none';

  // In cross-origin iframes, rAF can be throttled. Use setTimeout as a
  // fallback ceiling so the restore always fires within a bounded time.
  let restored = false;
  const restore = (viaRaf: boolean) => {
    if (restored) return;
    restored = true;
    iframe.style.display = previousDisplay;
    nudgeInFlight.delete(iframe);
    if (viaRaf) onRafRestore?.();
    onDone?.();
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(() => restore(true));
  });
  setTimeout(() => restore(false), 100);
}
