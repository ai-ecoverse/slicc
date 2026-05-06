/**
 * Reusable click-and-hold gesture: a short primary-button click fires
 * `onShortClick`, holding past `LONG_PRESS_MS` (or clicking with any
 * modifier key) fires `onLongPress` instead and suppresses the
 * trailing click event.
 *
 * Originally lived inline in `rail-zone.ts`. Hoisted into its own
 * module so the chat copy-chat button (short = copy last response,
 * long = copy whole chat) can re-use the exact same gesture.
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
 * Attach the gesture to a button. The contract matches the original
 * rail-zone wiring exactly: mousedown without modifiers starts a
 * timer, mouseup/leave/blur/contextmenu cancels it, the click event
 * after a fired long-press is swallowed.
 */
export function attachLongPressGesture(btn: HTMLElement, opts: LongPressOptions): LongPressHandle {
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

  btn.addEventListener('mousedown', onMouseDown);
  btn.addEventListener('mouseup', onMouseUp);
  btn.addEventListener('mouseleave', onMouseLeave);
  btn.addEventListener('blur', onBlur);
  btn.addEventListener('contextmenu', onContextMenu);
  btn.addEventListener('click', onClick);

  return {
    destroy: () => {
      clearTimer();
      btn.removeEventListener('mousedown', onMouseDown);
      btn.removeEventListener('mouseup', onMouseUp);
      btn.removeEventListener('mouseleave', onMouseLeave);
      btn.removeEventListener('blur', onBlur);
      btn.removeEventListener('contextmenu', onContextMenu);
      btn.removeEventListener('click', onClick);
    },
  };
}
