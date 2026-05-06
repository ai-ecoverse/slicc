// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachLongPressGesture, LONG_PRESS_MS } from '../../src/ui/long-press.js';

describe('attachLongPressGesture', () => {
  let btn: HTMLButtonElement;

  beforeEach(() => {
    btn = document.createElement('button');
    document.body.appendChild(btn);
  });

  afterEach(() => {
    btn.remove();
    vi.useRealTimers();
  });

  it('plain quick click fires onShortClick, not onLongPress', () => {
    vi.useFakeTimers();
    const onShortClick = vi.fn();
    const onLongPress = vi.fn();
    attachLongPressGesture(btn, { onShortClick, onLongPress });

    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    vi.advanceTimersByTime(LONG_PRESS_MS - 100);
    btn.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    btn.dispatchEvent(new MouseEvent('click'));

    expect(onShortClick).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('holding past the threshold fires onLongPress and swallows the click', () => {
    vi.useFakeTimers();
    const onShortClick = vi.fn();
    const onLongPress = vi.fn();
    attachLongPressGesture(btn, { onShortClick, onLongPress });

    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onShortClick).not.toHaveBeenCalled();

    // The click that follows mouseup must be suppressed.
    btn.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    btn.dispatchEvent(new MouseEvent('click'));
    expect(onShortClick).not.toHaveBeenCalled();
  });

  it('mouseup before threshold cancels the long-press timer', () => {
    vi.useFakeTimers();
    const onShortClick = vi.fn();
    const onLongPress = vi.fn();
    attachLongPressGesture(btn, { onShortClick, onLongPress });

    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    vi.advanceTimersByTime(500);
    btn.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('mouseleave cancels the timer (drag-out gesture)', () => {
    vi.useFakeTimers();
    const onShortClick = vi.fn();
    const onLongPress = vi.fn();
    attachLongPressGesture(btn, { onShortClick, onLongPress });

    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    btn.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('modifier-click triggers onLongPress immediately and skips onShortClick', () => {
    const onShortClick = vi.fn();
    const onLongPress = vi.fn();
    attachLongPressGesture(btn, { onShortClick, onLongPress });

    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0, metaKey: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', { button: 0, metaKey: true }));
    btn.dispatchEvent(new MouseEvent('click', { metaKey: true }));

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onShortClick).not.toHaveBeenCalled();
  });

  it('respects modifierClickAsLongPress=false', () => {
    const onShortClick = vi.fn();
    const onLongPress = vi.fn();
    attachLongPressGesture(btn, {
      onShortClick,
      onLongPress,
      modifierClickAsLongPress: false,
    });

    btn.dispatchEvent(new MouseEvent('click', { metaKey: true }));

    expect(onShortClick).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('non-primary buttons (right-click) do not start the timer', () => {
    vi.useFakeTimers();
    const onShortClick = vi.fn();
    const onLongPress = vi.fn();
    attachLongPressGesture(btn, { onShortClick, onLongPress });

    btn.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('calls onPressStart on mousedown and onPressEnd on cancel', () => {
    const onPressStart = vi.fn();
    const onPressEnd = vi.fn();
    attachLongPressGesture(btn, {
      onShortClick: () => {},
      onLongPress: () => {},
      onPressStart,
      onPressEnd,
    });

    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    expect(onPressStart).toHaveBeenCalledTimes(1);

    btn.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    expect(onPressEnd).toHaveBeenCalled();
  });

  it('calls onPressEnd when the long-press fires', () => {
    vi.useFakeTimers();
    const onPressEnd = vi.fn();
    const onLongPress = vi.fn();
    attachLongPressGesture(btn, {
      onShortClick: () => {},
      onLongPress,
      onPressEnd,
    });

    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onPressEnd).toHaveBeenCalled();
  });

  it('destroy() removes listeners', () => {
    vi.useFakeTimers();
    const onShortClick = vi.fn();
    const onLongPress = vi.fn();
    const handle = attachLongPressGesture(btn, { onShortClick, onLongPress });

    handle.destroy();

    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    btn.dispatchEvent(new MouseEvent('click'));

    expect(onShortClick).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
