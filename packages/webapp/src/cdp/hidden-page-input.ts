/**
 * Pointer input on a hidden page.
 *
 * Chrome answers an `Input.dispatchMouseEvent` of type `mouseMoved` only once
 * the page draws its next frame, and a hidden page (a background tab, a
 * minimized or occluded window) draws none: each move took about 5 s, and a
 * `mouseWheel` was never answered, so it waited out the 30 s CDP timeout.
 * Clicks, keys and text are answered at once and are not touched here.
 *
 * `Emulation.setFocusEmulationEnabled` makes Chrome treat the page as visible
 * and focused, so it draws frames and answers in milliseconds, without raising
 * the tab or taking window focus. The page notices: `visibilityState` turns
 * `visible`, `visibilitychange` / `focus` / `blur` fire, `document.hasFocus()`
 * turns true, `:focus-visible` matches, a pending autofocus runs, and the tab
 * keeps rendering (and breaks real fullscreen) for as long as it is on. So it is
 * held only around move and wheel input on a page that reports `hidden`, and
 * dropped as soon as the page has handled that input; never for the session.
 * It is per CDP session: no other tab, the user's visible one included, sees
 * it, and Chrome drops it when the session detaches.
 */

import type { CDPPayload } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';

const log = createLogger('hidden-page-input');

/** The transport send focus emulation is driven through (the real one, not a facade). */
export type HiddenPageSend = (
  method: string,
  params: CDPPayload,
  sessionId: string,
  timeout?: number
) => Promise<CDPPayload>;

/**
 * A wheel on a hidden page whose connection could not emulate focus: Chrome
 * would never answer it, so it was not sent. {@link pageScrollExpression} is
 * the fallback.
 */
export class HiddenPageWheelError extends Error {
  override readonly name = 'HiddenPageWheelError';
  constructor() {
    super(
      'The tab is hidden and this connection cannot emulate focus, so Chrome would not ' +
        'answer a wheel event'
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
 * How long to wait for the page to draw after its input was answered. A wheel
 * is answered before the page dispatches it, so dropping focus emulation at
 * once parks the `wheel` event and its scroll until the tab is next shown.
 */
const SETTLE_TIMEOUT_MS = 2_000;

/**
 * Two animation frames: input is dispatched at the start of a frame, so the
 * second callback runs after the frame that handled it. The timer covers a
 * page whose `requestAnimationFrame` never calls back.
 */
const SETTLE_EXPRESSION = `new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 500);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    clearTimeout(timer);
    resolve(true);
  }));
})`;

/** What a hold found: a page already drawing, one emulating focus, or a hidden one without it. */
type PageState = 'drawing' | 'emulated' | 'hidden';

interface Hold {
  holders: number;
  state: Promise<PageState>;
}

/**
 * Per-session focus emulation around pointer input, for one transport.
 * Concurrent input on one session shares a single enable and restore.
 */
export class HiddenPageInput {
  private readonly holds = new Map<string, Hold>();
  /** Restores still in flight; the next hold on the session waits for its own. */
  private readonly restoring = new Map<string, Promise<void>>();
  /** Sessions a caller put under focus emulation itself; left as they are. */
  private readonly explicit = new Set<string>();

  constructor(private readonly send: HiddenPageSend) {}

  /**
   * Record a caller's own `Emulation.setFocusEmulationEnabled` so a hold
   * neither duplicates nor undoes it.
   */
  noteExplicit(sessionId: string, enabled: boolean): void {
    if (enabled) this.explicit.add(sessionId);
    else this.explicit.delete(sessionId);
  }

  /**
   * Run `input` (one move or wheel dispatch) with focus emulation held when
   * the page is hidden, and restore it afterwards whether `input` resolves or
   * rejects. A wheel on a hidden page that cannot emulate focus throws
   * {@link HiddenPageWheelError} instead of being sent.
   */
  async run<T>(sessionId: string, kind: 'move' | 'wheel', input: () => Promise<T>): Promise<T> {
    if (this.explicit.has(sessionId)) return input();
    const hold = this.acquire(sessionId);
    try {
      const state = await hold.state;
      if (state === 'hidden' && kind === 'wheel') throw new HiddenPageWheelError();
      const result = await input();
      if (state === 'emulated') await this.settle(sessionId);
      return result;
    } finally {
      await this.release(sessionId, hold);
    }
  }

  private acquire(sessionId: string): Hold {
    let hold = this.holds.get(sessionId);
    if (!hold) {
      // Probing while the previous hold's restore is in flight would read the
      // page as visible and skip emulation that is about to be turned off.
      const prior = this.restoring.get(sessionId) ?? Promise.resolve();
      hold = { holders: 0, state: prior.then(() => this.open(sessionId)) };
      this.holds.set(sessionId, hold);
    }
    hold.holders += 1;
    return hold;
  }

  private release(sessionId: string, hold: Hold): Promise<void> {
    hold.holders -= 1;
    if (hold.holders > 0) return Promise.resolve();
    this.holds.delete(sessionId);
    const restored = hold.state.then((state) =>
      state === 'emulated' && !this.explicit.has(sessionId) ? this.restore(sessionId) : undefined
    );
    this.restoring.set(sessionId, restored);
    return restored.finally(() => {
      if (this.restoring.get(sessionId) === restored) this.restoring.delete(sessionId);
    });
  }

  /** Probe the page and turn focus emulation on when it is hidden. Never rejects. */
  private async open(sessionId: string): Promise<PageState> {
    let visibility: unknown;
    try {
      const probe = await this.send(
        'Runtime.evaluate',
        { expression: 'document.visibilityState', returnByValue: true },
        sessionId
      );
      visibility = (probe['result'] as { value?: unknown } | undefined)?.value;
    } catch (err) {
      // The input itself surfaces whatever broke (a stale session included).
      log.debug('Visibility probe failed; sending pointer input as is', {
        sessionId,
        error: errorText(err),
      });
      return 'drawing';
    }
    if (visibility !== 'hidden') return 'drawing';
    try {
      await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
      return 'emulated';
    } catch (err) {
      log.warn('No focus emulation on this connection; hidden-tab input goes out without it', {
        sessionId,
        error: errorText(err),
      });
      return 'hidden';
    }
  }

  /** Let the page draw the frame that handles the input before emulation goes. */
  private async settle(sessionId: string): Promise<void> {
    try {
      await this.send(
        'Runtime.evaluate',
        { expression: SETTLE_EXPRESSION, awaitPromise: true, returnByValue: true },
        sessionId,
        SETTLE_TIMEOUT_MS
      );
    } catch (err) {
      log.debug('Page did not settle after pointer input', { sessionId, error: errorText(err) });
    }
  }

  private async restore(sessionId: string): Promise<void> {
    try {
      await this.send('Emulation.setFocusEmulationEnabled', { enabled: false }, sessionId);
    } catch (err) {
      // A dead session took its emulation with it; anything else leaves the
      // tab rendering until the session detaches.
      log.warn('Could not turn focus emulation back off', { sessionId, error: errorText(err) });
    }
  }
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
