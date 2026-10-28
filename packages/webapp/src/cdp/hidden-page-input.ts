/**
 * Pointer input on a hidden page.
 *
 * Chrome answers an `Input.dispatchMouseEvent` of type `mouseMoved` only once
 * the page draws its next frame, and a hidden page (a background tab, a
 * minimized or occluded window) draws none: each move took about 5 s, and a
 * `mouseWheel` was never answered, so it waited out the 30 s CDP timeout.
 * Clicks, keys and text are answered at once.
 *
 * `Emulation.setFocusEmulationEnabled` makes Chrome treat the page as visible
 * and focused, so it draws frames and answers in milliseconds, without raising
 * the tab or taking window focus. The page notices: `visibilityState` turns
 * `visible`, `visibilitychange` / `focus` / `blur` fire, `document.hasFocus()`
 * turns true, `:focus-visible` matches, a pending autofocus runs, and the tab
 * keeps rendering (and blocks real fullscreen) while it is on. So it is held
 * for one gesture at a time: from the first move or wheel of a `withTab` body
 * until that body ends (press and release in between run inside it), or, for
 * sends outside a body, until the pointer has been idle for a moment.
 *
 * Chrome keeps one capture count per CDP session but one focus flag per tab,
 * so holds are keyed by TARGET: every session on a tab shares one hold, and a
 * session whose caller manages emulation itself (a tray leader driving this
 * tab) is left alone. A page that reads visible only because such a caller
 * shows it still gets the gate's own emulation, so the caller turning its own
 * off cannot hide the page under the gesture. Another bridge's emulation (the
 * page and the kernel worker each own one) is invisible here: a page it shows
 * reads visible and is left alone.
 */

import type { CDPPayload } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';

const log = createLogger('hidden-page-input');

/** A session-scoped send on one transport, bypassing the facade. */
export type HiddenPageSend = (
  method: string,
  params: CDPPayload,
  sessionId: string,
  timeout?: number
) => Promise<CDPPayload>;

/** The transport a facade forwards to. */
export interface HiddenPageTransport {
  send(
    method: string,
    params?: CDPPayload,
    sessionId?: string,
    timeout?: number
  ): Promise<CDPPayload>;
}

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

/**
 * Chrome took a wheel on a hidden page under focus emulation, but the page
 * drew no frame to apply it. Not a success: the scroll may still land when the
 * tab next draws.
 */
export class HiddenPageWheelUnsettledError extends Error {
  override readonly name = 'HiddenPageWheelUnsettledError';
  constructor(detail: string) {
    super(
      `Chrome took the wheel event, but the background tab drew no frame to apply it ` +
        `(${detail}); the scroll may still land when the tab is next shown`
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

const PROBE_EXPRESSION = 'document.visibilityState';

/**
 * How long a wheel may wait for the frame that applies it. Chrome answers a
 * wheel before the page dispatches it, so the hold must last until that frame
 * is drawn; dropping it earlier parks the `wheel` event and its scroll.
 */
const SETTLE_BOUND_MS = 5_000;

/**
 * Two animation frames: input is dispatched at the start of a frame, so the
 * second callback runs after the frame that handled it.
 */
const SETTLE_EXPRESSION = `new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), ${SETTLE_BOUND_MS});
  requestAnimationFrame(() => requestAnimationFrame(() => {
    clearTimeout(timer);
    resolve(true);
  }));
})`;

/** How long a hold opened outside a `withTab` body outlives its last pointer send. */
const DEFAULT_LINGER_MS = 500;

/** What a hold found when it opened. */
interface HoldState {
  /** The gate turned focus emulation on for this hold. */
  emulated: boolean;
  /** A wheel can be sent: the page draws, or was probed visible. */
  wheel: boolean;
}

interface Hold {
  /** The session the probe and the enable went on; the restore goes there too. */
  sessionId: string;
  send: HiddenPageSend;
  /** Resolves once the hold has probed and enabled; never rejects. */
  state: Promise<HoldState>;
  /** Pointer sends currently running inside the hold. */
  inflight: number;
  linger: ReturnType<typeof setTimeout> | null;
}

interface TargetState {
  /** `withTab` bodies running on this target. */
  pins: number;
  hold: Hold | null;
  /** Sessions whose caller turned emulation on itself, with that send. */
  explicit: Map<string, Promise<unknown>>;
  /**
   * Sessions the gate turned emulation on for and has not turned off yet:
   * the current hold's, one deferred while a caller still wants emulation,
   * or one whose restore failed and is retried on the next hold.
   */
  owed: Map<string, HiddenPageSend>;
  /** The gate's own enable/restore sends, in order; a caller's enable lands after them. */
  queue: Promise<void>;
  queued: number;
}

export interface HiddenPageInputOptions {
  /** The target a session belongs to, when the bridge knows it. */
  targetOf(sessionId: string): string | undefined;
  /** Whether an error means the session is gone (and took its emulation with it). */
  isGone(err: unknown): boolean;
  lingerMs?: number;
}

/**
 * Focus emulation around pointer input, for every session one bridge drives.
 * One instance per `BrowserAPI`, shared by all its transport facades.
 */
export class HiddenPageInput {
  private readonly targets = new Map<string, TargetState>();
  /** Sessions attached through a facade (a tray leader's), by target. */
  private readonly learned = new Map<string, string>();
  private readonly lingerMs: number;

  constructor(private readonly opts: HiddenPageInputOptions) {
    this.lingerMs = opts.lingerMs ?? DEFAULT_LINGER_MS;
  }

  /** Route one facade send: pointer input, a caller's emulation, or anything else. */
  route(
    transport: HiddenPageTransport,
    method: string,
    params: CDPPayload | undefined,
    sessionId: string | undefined,
    forward: () => Promise<CDPPayload>
  ): Promise<CDPPayload> {
    if (method === 'Target.attachToTarget') return this.attach(params, forward);
    if (!sessionId) return forward();
    if (method === 'Emulation.setFocusEmulationEnabled') {
      return params?.['enabled'] === true
        ? this.callerEnable(sessionId, forward)
        : this.callerDisable(sessionId, forward);
    }
    const kind = hiddenPagePointerKind(method, params);
    return kind ? this.pointer(transport, sessionId, kind, forward) : forward();
  }

  /**
   * Keep a hold on `targetId` open while a `withTab` body runs. The returned
   * release turns emulation back off once the last body on the target ends;
   * it never rejects.
   */
  pin(targetId: string): () => Promise<void> {
    const t = this.target(targetId);
    t.pins += 1;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      t.pins -= 1;
      await this.idle(targetId, t, true);
    };
  }

  /** A session detached: Chrome dropped its emulation, so nothing is owed on it. */
  forgetSession(sessionId: string): void {
    const key = this.keyOf(sessionId);
    this.learned.delete(sessionId);
    const t = this.targets.get(key);
    if (!t) return;
    t.owed.delete(sessionId);
    const hold = t.hold;
    if (hold?.sessionId === sessionId) {
      this.cancelLinger(hold);
      t.hold = null;
    }
    if (t.explicit.delete(sessionId) || hold?.sessionId === sessionId) {
      void this.restoreOwed(key, t);
    }
    this.prune(key, t);
  }

  private async attach(
    params: CDPPayload | undefined,
    forward: () => Promise<CDPPayload>
  ): Promise<CDPPayload> {
    const result = await forward();
    const sessionId = result['sessionId'];
    const targetId = params?.['targetId'];
    if (typeof sessionId === 'string' && typeof targetId === 'string') {
      this.learned.set(sessionId, targetId);
    }
    return result;
  }

  private async pointer(
    transport: HiddenPageTransport,
    sessionId: string,
    kind: 'move' | 'wheel',
    forward: () => Promise<CDPPayload>
  ): Promise<CDPPayload> {
    const key = this.keyOf(sessionId);
    const t = this.target(key);
    const own = t.explicit.get(sessionId);
    if (own !== undefined) {
      // This session's caller shows the page itself (a tray leader's gate).
      await own.catch(() => undefined);
      if (t.explicit.has(sessionId)) return forward();
    }
    const send = sendVia(transport);
    const hold = t.hold ?? this.open(t, sessionId, send);
    hold.inflight += 1;
    this.cancelLinger(hold);
    try {
      const state = await hold.state;
      if (kind === 'wheel' && !state.wheel) throw new HiddenPageWheelError();
      const result = await forward();
      if (kind === 'wheel' && state.emulated) await this.settle(send, sessionId);
      return result;
    } finally {
      hold.inflight -= 1;
      void this.idle(key, t, false);
    }
  }

  private open(t: TargetState, sessionId: string, send: HiddenPageSend): Hold {
    const hold: Hold = {
      sessionId,
      send,
      inflight: 0,
      linger: null,
      state: Promise.resolve({ emulated: false, wheel: true }),
    };
    t.hold = hold;
    hold.state = this.serialize(t, async () => {
      // An enable whose restore failed earlier is retried here, before the
      // probe: it would make the page read visible and skip the hold.
      if (t.explicit.size === 0) await this.turnOffOwed(t);
    }).then(() => this.show(t, sessionId, send));
    return hold;
  }

  /** Probe the page and turn focus emulation on unless it already draws. Never rejects. */
  private async show(t: TargetState, sessionId: string, send: HiddenPageSend): Promise<HoldState> {
    let visible: boolean | null = null;
    try {
      const probe = await send(
        'Runtime.evaluate',
        { expression: PROBE_EXPRESSION, returnByValue: true },
        sessionId
      );
      const value = (probe['result'] as { value?: unknown } | undefined)?.value;
      if (typeof value === 'string') visible = value === 'visible';
    } catch (err) {
      // A destroyed context, a refused evaluate: the page may well be hidden.
      log.debug('Visibility probe failed; treating the page as hidden', {
        sessionId,
        error: errorText(err),
      });
    }
    // A caller on another session may be what shows the page, and may stop.
    const shownByOthers = [...t.explicit.keys()].some((other) => other !== sessionId);
    if (visible === true && !shownByOthers) return { emulated: false, wheel: true };
    try {
      await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
      t.owed.set(sessionId, send);
      return { emulated: true, wheel: visible !== null };
    } catch (err) {
      log.warn('No focus emulation on this connection; hidden-tab input goes out without it', {
        sessionId,
        error: errorText(err),
      });
      return { emulated: false, wheel: visible === true };
    }
  }

  /** Wait for the frame that applies a wheel; without it the wheel is not delivered. */
  private async settle(send: HiddenPageSend, sessionId: string): Promise<void> {
    let detail = `no frame within ${SETTLE_BOUND_MS / 1000} s`;
    try {
      const settled = await send(
        'Runtime.evaluate',
        { expression: SETTLE_EXPRESSION, awaitPromise: true, returnByValue: true },
        sessionId,
        SETTLE_BOUND_MS + 3_000
      );
      if ((settled['result'] as { value?: unknown } | undefined)?.value === true) return;
    } catch (err) {
      detail = errorText(err);
    }
    throw new HiddenPageWheelUnsettledError(detail);
  }

  private async idle(key: string, t: TargetState, unpinned: boolean): Promise<void> {
    const hold = t.hold;
    if (!hold) {
      this.prune(key, t);
      return;
    }
    if (hold.inflight > 0 || t.pins > 0) return;
    if (unpinned) {
      await this.close(key, t, hold);
      return;
    }
    this.cancelLinger(hold);
    hold.linger = setTimeout(() => {
      hold.linger = null;
      if (t.hold === hold && hold.inflight === 0 && t.pins === 0) void this.close(key, t, hold);
    }, this.lingerMs);
  }

  private async close(key: string, t: TargetState, hold: Hold): Promise<void> {
    if (t.hold !== hold) return;
    this.cancelLinger(hold);
    t.hold = null;
    await hold.state;
    await this.restoreOwed(key, t);
  }

  /** Turn off what the gate turned on, unless a hold or a caller still wants it on. */
  private async restoreOwed(key: string, t: TargetState): Promise<void> {
    await this.serialize(t, async () => {
      if (t.hold || t.explicit.size > 0) return;
      await this.turnOffOwed(t);
    });
    this.prune(key, t);
  }

  private async turnOffOwed(t: TargetState): Promise<void> {
    for (const [sessionId, send] of [...t.owed]) {
      try {
        await send('Emulation.setFocusEmulationEnabled', { enabled: false }, sessionId);
        t.owed.delete(sessionId);
      } catch (err) {
        if (this.opts.isGone(err)) {
          t.owed.delete(sessionId);
          continue;
        }
        // Still owed: the next hold on this tab sends it again.
        log.warn('Could not turn focus emulation back off; retrying on the next hold', {
          sessionId,
          error: errorText(err),
        });
      }
    }
  }

  /** A caller's own enable lands after the gate's restores, and the caller keeps it. */
  private async callerEnable(
    sessionId: string,
    forward: () => Promise<CDPPayload>
  ): Promise<CDPPayload> {
    const t = this.target(this.keyOf(sessionId));
    const sent = t.queue.then(forward);
    t.explicit.set(sessionId, sent);
    try {
      const result = await sent;
      t.owed.delete(sessionId);
      return result;
    } catch (err) {
      if (t.explicit.get(sessionId) === sent) t.explicit.delete(sessionId);
      throw err;
    }
  }

  /**
   * A caller turned emulation off. Chrome's focus flag is one per tab, so a
   * hold still running on another session shows the page again; with no hold
   * left, what the gate deferred for this caller is restored now.
   */
  private async callerDisable(
    sessionId: string,
    forward: () => Promise<CDPPayload>
  ): Promise<CDPPayload> {
    const key = this.keyOf(sessionId);
    const t = this.target(key);
    const result = await forward();
    t.explicit.delete(sessionId);
    t.owed.delete(sessionId);
    const hold = t.hold;
    if (hold && (await hold.state).emulated) {
      // Ordered with the gate's restores: a hold that closed meanwhile is
      // restored by its own close instead.
      await this.serialize(t, async () => {
        if (t.hold !== hold) return;
        try {
          await hold.send('Emulation.setFocusEmulationEnabled', { enabled: true }, hold.sessionId);
          t.owed.set(hold.sessionId, hold.send);
        } catch (err) {
          log.warn('Could not show the page again after a caller hid it', {
            sessionId: hold.sessionId,
            error: errorText(err),
          });
        }
      });
    } else {
      await this.restoreOwed(key, t);
    }
    return result;
  }

  private serialize(t: TargetState, fn: () => Promise<void>): Promise<void> {
    t.queued += 1;
    const run = t.queue.then(fn).finally(() => {
      t.queued -= 1;
    });
    t.queue = run.catch(() => undefined);
    return t.queue;
  }

  private cancelLinger(hold: Hold): void {
    if (hold.linger === null) return;
    clearTimeout(hold.linger);
    hold.linger = null;
  }

  private keyOf(sessionId: string): string {
    return this.opts.targetOf(sessionId) ?? this.learned.get(sessionId) ?? `session:${sessionId}`;
  }

  private target(key: string): TargetState {
    let t = this.targets.get(key);
    if (!t) {
      t = {
        pins: 0,
        hold: null,
        explicit: new Map(),
        owed: new Map(),
        queue: Promise.resolve(),
        queued: 0,
      };
      this.targets.set(key, t);
    }
    return t;
  }

  private prune(key: string, t: TargetState): void {
    const idle =
      t.pins === 0 && !t.hold && t.explicit.size === 0 && t.owed.size === 0 && t.queued === 0;
    if (idle && this.targets.get(key) === t) this.targets.delete(key);
  }
}

function sendVia(transport: HiddenPageTransport): HiddenPageSend {
  return (method, params, sessionId, timeout) =>
    timeout === undefined
      ? transport.send(method, params, sessionId)
      : transport.send(method, params, sessionId, timeout);
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
