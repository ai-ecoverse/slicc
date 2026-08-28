// Pointer/drag lifecycle for `<slicc-launcher>` — the half of the element that
// only exists in real Chromium: pointer capture, the drag threshold, live
// clamping against the viewport, velocity-projected snapping, and the
// click-suppression that stops a drag-release from also toggling the sidebar.
//
// Synthetic `PointerEvent`s are dispatched directly at the shadow button (rather
// than driving the real mouse) so a test can pin the exact coordinates,
// timestamps, and pointer ids each handler branch needs — including the hostile
// ones (secondary pointer, right button, id mismatch, cancel) a real mouse can't
// easily produce.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LAUNCHER_DRAG_THRESHOLD_PX,
  LAUNCHER_OFFSET_PX,
  LAUNCHER_STORAGE_KEY,
} from '../src/launcher-state.js';
import { type LauncherMoveDetail, SliccLauncher } from '../src/slicc-launcher.js';

function mount(attrs: Record<string, string> = {}): SliccLauncher {
  const el = document.createElement('slicc-launcher') as SliccLauncher;
  expect(el).toBeInstanceOf(SliccLauncher);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

function buttonOf(el: SliccLauncher): HTMLButtonElement {
  return el.shadowRoot?.querySelector('button.launcher') as HTMLButtonElement;
}

interface PointerAt {
  x: number;
  y: number;
  pointerId?: number;
  isPrimary?: boolean;
  button?: number;
}

function pointerEvent(type: string, { x, y, pointerId = 1, ...rest }: PointerAt): PointerEvent {
  return new PointerEvent(type, {
    pointerId,
    isPrimary: rest.isPrimary ?? true,
    button: rest.button ?? 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
}

function send(el: SliccLauncher, type: string, at: PointerAt): PointerEvent {
  const event = pointerEvent(type, at);
  buttonOf(el).dispatchEvent(event);
  return event;
}

/** Let the clock advance so the next pointer event carries a distinct
 *  `timeStamp` — the velocity EMA divides by that delta. */
function tick(ms = 24): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drag from the button's current center to (x, y) and release there, coming to
 *  a stop first so the release velocity (and therefore the flick projection) is
 *  ~0 and the resulting corner is a pure function of the release position.
 *  Each stationary move decays the velocity EMA by 0.35, so a handful of them
 *  is the deterministic equivalent of a user pausing before letting go. */
async function dragTo(el: SliccLauncher, x: number, y: number): Promise<void> {
  const rect = buttonOf(el).getBoundingClientRect();
  const from = {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  };
  send(el, 'pointerdown', from);
  await tick();
  send(el, 'pointermove', { x, y });
  for (let i = 0; i < 8; i++) send(el, 'pointermove', { x, y });
  send(el, 'pointerup', { x, y });
}

describe('slicc-launcher pointer drag', () => {
  beforeEach(() => {
    localStorage.removeItem(LAUNCHER_STORAGE_KEY);
    document.querySelectorAll('slicc-launcher').forEach((n) => {
      n.remove();
    });
  });

  it('ignores a below-threshold nudge: no drag, no snap, the click still toggles', async () => {
    const el = mount({ corner: 'top-right' });
    const onMove = vi.fn();
    el.addEventListener('slicc-launcher-move', onMove);
    const rect = buttonOf(el).getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    send(el, 'pointerdown', { x, y });
    await tick();
    send(el, 'pointermove', { x: x + LAUNCHER_DRAG_THRESHOLD_PX - 1, y });
    await tick();
    send(el, 'pointerup', { x: x + LAUNCHER_DRAG_THRESHOLD_PX - 1, y });

    expect(el.hasAttribute('dragging')).toBe(false);
    expect(onMove).not.toHaveBeenCalled();
    expect(el.corner).toBe('top-right');
    // Click suppression is only armed by a snap, so the click still lands.
    buttonOf(el).click();
    expect(el.open).toBe(true);
  });

  it('marks the host [dragging] once past the threshold and clears it on release', async () => {
    const el = mount({ corner: 'top-right' });
    const rect = buttonOf(el).getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    send(el, 'pointerdown', { x, y });
    expect(el.hasAttribute('dragging')).toBe(false);
    await tick();
    send(el, 'pointermove', { x: x - 120, y: y + 120 });
    expect(el.hasAttribute('dragging')).toBe(true);
    await tick();
    send(el, 'pointerup', { x: x - 120, y: y + 120 });
    expect(el.hasAttribute('dragging')).toBe(false);
  });

  it('follows the pointer with inline left/top while dragging and clears them on release', async () => {
    const el = mount({ corner: 'top-right' });
    const button = buttonOf(el);
    const rect = button.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const targetX = Math.round(window.innerWidth / 2);
    const targetY = Math.round(window.innerHeight / 2);

    send(el, 'pointerdown', { x, y });
    await tick();
    send(el, 'pointermove', { x: targetX, y: targetY });

    expect(button.style.right).toBe('auto');
    expect(button.style.bottom).toBe('auto');
    const dragged = button.getBoundingClientRect();
    // The button center tracks the pointer (within a pixel of rounding).
    expect(Math.abs(dragged.left + dragged.width / 2 - targetX)).toBeLessThan(2);
    expect(Math.abs(dragged.top + dragged.height / 2 - targetY)).toBeLessThan(2);

    await tick();
    send(el, 'pointerup', { x: targetX, y: targetY });
    expect(button.style.left).toBe('');
    expect(button.style.top).toBe('');
    expect(button.style.right).toBe('');
    expect(button.style.bottom).toBe('');
  });

  it('clamps the dragged button inside the viewport margins', async () => {
    const el = mount({ corner: 'top-right' });
    const button = buttonOf(el);
    const rect = button.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    send(el, 'pointerdown', { x, y });
    await tick();
    // Way off the top-left corner of the viewport.
    send(el, 'pointermove', { x: -4000, y: -4000 });
    const atMin = button.getBoundingClientRect();
    expect(atMin.left).toBeCloseTo(LAUNCHER_OFFSET_PX, 0);
    expect(atMin.top).toBeCloseTo(LAUNCHER_OFFSET_PX, 0);

    // ...and way off the bottom-right.
    send(el, 'pointermove', { x: 8000, y: 8000 });
    const atMax = button.getBoundingClientRect();
    expect(atMax.right).toBeCloseTo(window.innerWidth - LAUNCHER_OFFSET_PX, 0);
    expect(atMax.bottom).toBeCloseTo(window.innerHeight - LAUNCHER_OFFSET_PX, 0);

    await tick();
    send(el, 'pointerup', { x: 8000, y: 8000 });
  });

  it('snaps to the released corner, emits slicc-launcher-move, and persists it', async () => {
    const el = mount({ corner: 'top-right' });
    const moves: LauncherMoveDetail[] = [];
    el.addEventListener('slicc-launcher-move', (e) => {
      moves.push((e as CustomEvent<LauncherMoveDetail>).detail);
    });

    await dragTo(el, 12, window.innerHeight - 12);

    expect(el.corner).toBe('bottom-left');
    expect(el.getAttribute('corner')).toBe('bottom-left');
    expect(moves).toEqual([{ corner: 'bottom-left' }]);
    expect(localStorage.getItem(LAUNCHER_STORAGE_KEY)).toBe('bottom-left');
  });

  it('snaps to an edge midpoint when released mid-edge', async () => {
    const el = mount({ corner: 'top-right' });
    await dragTo(el, Math.round(window.innerWidth / 2), window.innerHeight - 8);
    expect(el.corner).toBe('bottom');
  });

  it('swallows the click that follows a drag so the sidebar does not toggle', async () => {
    const el = mount({ corner: 'top-right' });
    const onToggle = vi.fn();
    el.addEventListener('slicc-launcher-toggle', onToggle);

    await dragTo(el, 12, window.innerHeight - 12);
    // Chromium fires a click after a same-element press/release pair; replay it.
    buttonOf(el).click();

    expect(el.open).toBe(false);
    expect(onToggle).not.toHaveBeenCalled();

    // Only the drag's own click is swallowed — the next one works.
    buttonOf(el).click();
    expect(el.open).toBe(true);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('snaps a short flick, using the projected release velocity', async () => {
    const el = mount({ corner: 'top-right' });
    const button = buttonOf(el);
    const rect = button.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const onMove = vi.fn();
    el.addEventListener('slicc-launcher-move', onMove);

    // Two fast moves below the drag threshold each, but ending past the flick
    // distance with a high downward velocity: the release projects downward.
    send(el, 'pointerdown', { x, y });
    send(el, 'pointermove', { x, y: y + 5 });
    send(el, 'pointerup', { x, y: y + 14 });

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(el.corner).toBe('bottom-right');
  });

  it('pointercancel abandons the drag without snapping', async () => {
    const el = mount({ corner: 'top-right' });
    const onMove = vi.fn();
    el.addEventListener('slicc-launcher-move', onMove);
    const button = buttonOf(el);
    const rect = button.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    send(el, 'pointerdown', { x, y });
    await tick();
    send(el, 'pointermove', { x: 20, y: window.innerHeight - 20 });
    expect(el.hasAttribute('dragging')).toBe(true);
    await tick();
    send(el, 'pointercancel', { x: 20, y: window.innerHeight - 20 });

    expect(onMove).not.toHaveBeenCalled();
    expect(el.corner).toBe('top-right');
    expect(el.hasAttribute('dragging')).toBe(false);
    expect(button.style.left).toBe('');
    // A cancelled drag must not swallow the user's next click.
    buttonOf(el).click();
    expect(el.open).toBe(true);
  });

  it('ignores a secondary pointer and a non-left button', async () => {
    const el = mount({ corner: 'top-right' });
    const onMove = vi.fn();
    el.addEventListener('slicc-launcher-move', onMove);
    const rect = buttonOf(el).getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    send(el, 'pointerdown', { x, y, isPrimary: false });
    send(el, 'pointermove', { x: 20, y: window.innerHeight - 20 });
    send(el, 'pointerup', { x: 20, y: window.innerHeight - 20 });
    expect(el.hasAttribute('dragging')).toBe(false);

    send(el, 'pointerdown', { x, y, button: 2 });
    send(el, 'pointermove', { x: 20, y: window.innerHeight - 20 });
    send(el, 'pointerup', { x: 20, y: window.innerHeight - 20 });
    expect(el.hasAttribute('dragging')).toBe(false);
    expect(onMove).not.toHaveBeenCalled();
    expect(el.corner).toBe('top-right');
  });

  it('ignores move/up events from a different pointer id mid-drag', async () => {
    const el = mount({ corner: 'top-right' });
    const onMove = vi.fn();
    el.addEventListener('slicc-launcher-move', onMove);
    const rect = buttonOf(el).getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    send(el, 'pointerdown', { x, y, pointerId: 7 });
    await tick();
    // A second finger's stream must not move or release the launcher.
    send(el, 'pointermove', { x: 20, y: window.innerHeight - 20, pointerId: 9 });
    expect(el.hasAttribute('dragging')).toBe(false);
    send(el, 'pointerup', { x: 20, y: window.innerHeight - 20, pointerId: 9 });
    expect(onMove).not.toHaveBeenCalled();

    // The original pointer still owns the drag.
    send(el, 'pointermove', { x: 20, y: window.innerHeight - 20, pointerId: 7 });
    expect(el.hasAttribute('dragging')).toBe(true);
    await tick();
    send(el, 'pointerup', { x: 20, y: window.innerHeight - 20, pointerId: 7 });
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it('still cleans up when the host page breaks pointer-capture release', async () => {
    const el = mount({ corner: 'top-right' });
    const button = buttonOf(el);
    const rect = button.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const original = Element.prototype.hasPointerCapture;
    Element.prototype.hasPointerCapture = () => {
      throw new Error('host page broke pointer capture');
    };
    try {
      send(el, 'pointerdown', { x, y });
      await tick();
      send(el, 'pointermove', { x: 20, y: window.innerHeight - 20 });
      send(el, 'pointerup', { x: 20, y: window.innerHeight - 20 });
    } finally {
      Element.prototype.hasPointerCapture = original;
    }
    // The drag still ended: no stuck [dragging], no stuck inline position.
    expect(el.hasAttribute('dragging')).toBe(false);
    expect(button.style.left).toBe('');
    expect(el.corner).toBe('bottom-left');
  });

  it('a stray pointerup with no drag in flight is a no-op', () => {
    const el = mount({ corner: 'top-right' });
    const onMove = vi.fn();
    el.addEventListener('slicc-launcher-move', onMove);
    send(el, 'pointerup', { x: 10, y: 10 });
    expect(onMove).not.toHaveBeenCalled();
    expect(el.corner).toBe('top-right');
  });

  it('does not re-snap when the drag ends on the corner it started from', async () => {
    const el = mount({ corner: 'top-right' });
    const moves: LauncherMoveDetail[] = [];
    el.addEventListener('slicc-launcher-move', (e) => {
      moves.push((e as CustomEvent<LauncherMoveDetail>).detail);
    });
    await dragTo(el, window.innerWidth - 12, 12);
    // Same corner: the move event still reports the snap target, and the
    // attribute is unchanged.
    expect(el.corner).toBe('top-right');
    expect(moves).toEqual([{ corner: 'top-right' }]);
  });
});
