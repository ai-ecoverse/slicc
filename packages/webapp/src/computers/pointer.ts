/**
 * Last pointer position for a computer backend. xdotool omits coordinates
 * on click/button/scroll after `mousemove`, so adapters must remember them.
 */

import type { ComputerInputEvent } from '@slicc/shared-ts';

export interface Pointer {
  x: number;
  y: number;
}

export function createPointer(initial: Pointer = { x: 0, y: 0 }): Pointer {
  return { x: initial.x, y: initial.y };
}

export function rememberPointer(pointer: Pointer, coords: { x?: number; y?: number }): Pointer {
  if (coords.x !== undefined && coords.y !== undefined) {
    pointer.x = coords.x;
    pointer.y = coords.y;
  }
  return pointer;
}

export function resolvePointer(pointer: Pointer, coords: { x?: number; y?: number }): Pointer {
  if (coords.x !== undefined && coords.y !== undefined) {
    pointer.x = coords.x;
    pointer.y = coords.y;
    return { x: coords.x, y: coords.y };
  }
  return { x: pointer.x, y: pointer.y };
}

/** Fill omitted x/y on click/button/scroll from the last known pointer. */
export function applyPointerToEvents(
  pointer: Pointer,
  events: ComputerInputEvent[]
): ComputerInputEvent[] {
  return events.map((event) => {
    if (
      event.type === 'mousemove' ||
      event.type === 'click' ||
      event.type === 'button' ||
      event.type === 'scroll'
    ) {
      const p = resolvePointer(pointer, event);
      return { ...event, x: p.x, y: p.y };
    }
    if (event.type === 'drag') {
      rememberPointer(pointer, { x: event.x2, y: event.y2 });
    }
    return event;
  });
}
