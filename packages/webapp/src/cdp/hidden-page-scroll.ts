/**
 * The eager half of hidden-page input: what `TabHandle` and the transport
 * facade need on every send. The focus-emulation gate itself
 * (`hidden-page-input.ts`) is loaded on the first pointer send, so it stays
 * off the boot graph.
 */

import type { CDPPayload } from '@slicc/shared-ts';

/**
 * A wheel on a hidden page that could not be shown (no focus emulation on this
 * connection, or the page could not be probed): Chrome would not answer it, so
 * it was not sent. {@link pageScrollExpression} is the fallback.
 */
export class HiddenPageWheelError extends Error {
  override readonly name = 'HiddenPageWheelError';
  constructor() {
    super(
      'The tab is hidden (or could not be checked) and focus emulation is not available, ' +
        'so Chrome would not answer a wheel event'
    );
  }
}

/** The pointer input that needs a page drawing frames, or `null` for any other send. */
export function hiddenPagePointerKind(
  method: string,
  params: CDPPayload | undefined
): 'move' | 'wheel' | null {
  if (method !== 'Input.dispatchMouseEvent') return null;
  if (params?.['type'] === 'mouseMoved') return 'move';
  if (params?.['type'] === 'mouseWheel') return 'wheel';
  return null;
}

/**
 * Scroll the way a wheel at (x, y) would: the innermost scrollable element under the point
 * that can move in the requested direction, else the document. A point with no element under
 * it (off the viewport, or content that has since moved) scrolls the document too, where a
 * real wheel would hit-test against the rendered layout. No `wheel` event fires.
 */
export function pageScrollExpression(x: number, y: number, dx: number, dy: number): string {
  return `(() => {
  const dx = ${JSON.stringify(dx)}, dy = ${JSON.stringify(dy)};
  const canScroll = (el) => {
    const style = getComputedStyle(el);
    const y = /(auto|scroll|overlay)/.test(style.overflowY) &&
      (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight : dy < 0 && el.scrollTop > 0);
    const x = /(auto|scroll|overlay)/.test(style.overflowX) &&
      (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth : dx < 0 && el.scrollLeft > 0);
    return y || x;
  };
  let el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
  while (el && el !== document.body && el !== document.documentElement && !canScroll(el)) {
    el = el.parentElement;
  }
  const target = el && el !== document.body && el !== document.documentElement
    ? el
    : (document.scrollingElement || document.documentElement);
  target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return true;
})()`;
}
