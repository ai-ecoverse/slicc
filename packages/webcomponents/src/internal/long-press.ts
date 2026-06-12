/**
 * Reusable click-and-hold gesture, lifted verbatim from the webapp
 * (`packages/webapp/src/ui/long-press.ts`): a short primary-button click
 * fires `onShortClick`, holding past `LONG_PRESS_MS` (or clicking with any
 * modifier key) fires `onLongPress` instead and suppresses the trailing
 * click event.
 *
 * Kept as an `internal/` helper so `<slicc-press-button>` (and any future
 * gesture host) can share the exact same press contract without re-deriving
 * it. No DOM-structure assumptions — it only attaches listeners to the host
 * element it is given.
 */

/** Default long-press threshold. */
export const LONG_PRESS_MS = 1000;

export interface LongPressOptions {
  /** Plain click handler. Receives the original click event. */
  onShortClick: (e: MouseEvent) => void;
  /** Long-press / modifier-click handler. */
  onLongPress: () => void;
  /** Threshold in ms. Defaults to {@link LONG_PRESS_MS}. */
  longPressMs?: number;
  /** Optional ripple-paint hook called on mousedown. */
  onPressStart?: (e: MouseEvent) => void;
  /** Optional ripple-cleanup hook called on cancel/fire. */
  onPressEnd?: () => void;
  /**
   * Treat clicks held with a modifier key (cmd/ctrl/shift/alt) as an
   * instant long-press. Defaults to true so keyboard users can reach
   * the secondary action without holding a real-time timer.
   */
  modifierClickAsLongPress?: boolean;
}

export interface LongPressHandle {
  /** Detach all listeners. */
  destroy: () => void;
}

/**
 * Attach the gesture to an element. The contract matches the original
 * webapp wiring exactly: mousedown without modifiers starts a timer,
 * mouseup/leave/blur/contextmenu cancels it, the click event after a fired
 * long-press is swallowed.
 */
export function attachLongPressGesture(el: HTMLElement, opts: LongPressOptions): LongPressHandle {
  const threshold = opts.longPressMs ?? LONG_PRESS_MS;
  const modifierClickAsLongPress = opts.modifierClickAsLongPress ?? true;

  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let firedLongPress = false;

  const cleanupPressVisual = () => {
    opts.onPressEnd?.();
  };

  const clearTimer = () => {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    cleanupPressVisual();
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    // Modifier-clicks are an instant trigger — no press animation.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    firedLongPress = false;
    clearTimer();
    opts.onPressStart?.(e);
    pressTimer = setTimeout(() => {
      firedLongPress = true;
      cleanupPressVisual();
      pressTimer = null;
      opts.onLongPress();
    }, threshold);
  };

  const onMouseUp = () => clearTimer();
  const onMouseLeave = () => clearTimer();
  const onBlur = () => clearTimer();
  const onContextMenu = () => clearTimer();

  const onClick = (e: MouseEvent) => {
    // Skip the click that the long-press already handled.
    if (firedLongPress) {
      firedLongPress = false;
      e.preventDefault();
      return;
    }
    const modifierClick = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
    if (modifierClick && modifierClickAsLongPress) {
      e.preventDefault();
      opts.onLongPress();
      return;
    }
    opts.onShortClick(e);
  };

  el.addEventListener('mousedown', onMouseDown);
  el.addEventListener('mouseup', onMouseUp);
  el.addEventListener('mouseleave', onMouseLeave);
  el.addEventListener('blur', onBlur);
  el.addEventListener('contextmenu', onContextMenu);
  el.addEventListener('click', onClick);

  return {
    destroy: () => {
      clearTimer();
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('mouseup', onMouseUp);
      el.removeEventListener('mouseleave', onMouseLeave);
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('click', onClick);
    },
  };
}
