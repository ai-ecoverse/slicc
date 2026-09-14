export const LONG_PRESS_MS = 1000;

export interface LongPressOptions {
  onShortClick: (e: MouseEvent) => void;

  onLongPress: () => void;

  longPressMs?: number;

  onPressStart?: (e: MouseEvent) => void;

  onPressEnd?: () => void;

  modifierClickAsLongPress?: boolean;
}

export interface LongPressHandle {
  destroy: () => void;
}

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
