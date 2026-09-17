/**
 * Last pointer position for a computer backend. xdotool omits coordinates
 * on click/button/scroll after `mousemove`, so adapters must remember them.
 */

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
