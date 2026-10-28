/**
 * A fake Chrome tab that is hidden, as a background tab is, for the
 * focus-emulation tests. It models what Chrome does with pointer input there:
 *
 * - The page draws only while some session emulates focus (one capture count
 *   per session) or it is really visible. Focus is one flag per tab, as in
 *   Chrome, so any session's `setFocusEmulationEnabled` flips it.
 * - A `mouseMoved` on a page that does not draw is answered late (Chrome: about
 *   5 s); it counts in `slowMoves`. A `mouseWheel` there is never answered,
 *   modelled as a rejection so a regression fails fast.
 * - A wheel is answered before it is applied: its scroll lands on the next
 *   frame, which the gate's settle (two `requestAnimationFrame`s) stands for.
 *
 * Commands can be paused on the wire (`pause`) to order them the way a slow
 * connection would, and failed once (`failNext`).
 */

import type { CDPPayload } from '@slicc/shared-ts';
import { vi } from 'vitest';
import type { CDPTransport } from '../../src/cdp/transport.js';

export interface FakeHiddenTabOptions {
  /** The connection has `Emulation.setFocusEmulationEnabled` (default true). */
  emulation?: boolean;
  /** The page is really visible (a foreground tab). */
  visible?: boolean;
  /** The page has focus of its own. */
  focused?: boolean;
  /** The visibility probe throws this message. */
  probeError?: string;
  /** The page draws no frame even while shown. */
  framesStall?: boolean;
  /** What the page-scroll fallback's evaluate returns. */
  scroll?: CDPPayload;
  /** `window.devicePixelRatio`. */
  dpr?: number;
  /** Pages `Target.getTargets` lists. */
  targets?: Array<{ targetId: string; url: string; title?: string }>;
}

export interface FakeCall {
  method: string;
  params: CDPPayload;
  sessionId?: string;
  /** A short name: `probe`, `settle`, `page-scroll`, `emulate:true`, `mouseMoved`, … */
  step: string;
}

function stepName(method: string, params: CDPPayload): string {
  if (method === 'Emulation.setFocusEmulationEnabled') return `emulate:${params['enabled']}`;
  if (method === 'Input.dispatchMouseEvent') return String(params['type']);
  if (method === 'Runtime.evaluate') {
    const expression = String(params['expression']);
    if (expression.includes('visibilityState')) return 'probe';
    if (expression.includes('requestAnimationFrame')) return 'settle';
    if (expression.includes('scrollBy')) return 'page-scroll';
    return 'evaluate';
  }
  return method;
}

export function fakeHiddenTab(opts: FakeHiddenTabOptions = {}) {
  const calls: FakeCall[] = [];
  /** Input steps and page events in the order the page saw them. */
  const timeline: string[] = [];
  const page = {
    capturers: new Set<string>(),
    focusFlag: false,
    scrollY: 0,
    pendingWheel: 0,
    slowMoves: 0,
  };
  const pauses: Array<{
    step: string;
    sessionId?: string;
    release: Promise<void>;
    reached(): void;
  }> = [];
  const failures = new Map<string, string>();
  let sessions = 0;

  const shown = (): boolean => opts.visible === true || page.capturers.size > 0;
  const focused = (): boolean => opts.focused === true || page.focusFlag;

  const emulate = (sessionId: string, enabled: boolean): void => {
    const wasShown = shown();
    const wasFocused = focused();
    page.focusFlag = enabled;
    if (enabled) page.capturers.add(sessionId);
    else page.capturers.delete(sessionId);
    if (wasShown !== shown()) timeline.push(shown() ? 'visible' : 'hidden');
    if (wasFocused !== focused()) timeline.push(focused() ? 'focus' : 'blur');
  };

  const evaluate = (expression: string): CDPPayload => {
    if (expression.includes('visibilityState')) {
      if (opts.probeError) throw new Error(opts.probeError);
      return { result: { value: shown() ? 'visible' : 'hidden' } };
    }
    if (expression.includes('requestAnimationFrame')) {
      if (!shown() || opts.framesStall) return { result: { value: false } };
      page.scrollY += page.pendingWheel;
      page.pendingWheel = 0;
      return { result: { value: true } };
    }
    if (expression.includes('scrollBy')) return opts.scroll ?? { result: { value: true } };
    if (expression === 'window.devicePixelRatio') return { result: { value: opts.dpr ?? 1 } };
    return { result: { value: true } };
  };

  const dispatchMouse = (params: CDPPayload): CDPPayload => {
    const type = params['type'];
    timeline.push(String(type));
    if (type === 'mouseMoved' && !shown()) page.slowMoves += 1;
    if (type === 'mouseWheel') {
      if (!shown())
        throw new Error('CDP command timed out after 30000ms: Input.dispatchMouseEvent');
      page.pendingWheel += Number(params['deltaY'] ?? 0);
    }
    return {};
  };

  const answer = async (
    method: string,
    params: CDPPayload,
    sessionId?: string
  ): Promise<CDPPayload> => {
    switch (method) {
      case 'Target.attachToTarget':
        return { sessionId: `sess-${++sessions}` };
      case 'Target.getTargets':
        return {
          targetInfos: (opts.targets ?? []).map((t) => ({ type: 'page', title: '', ...t })),
        };
      case 'Emulation.setFocusEmulationEnabled':
        if (opts.emulation === false) {
          throw new Error("'Emulation.setFocusEmulationEnabled' wasn't found");
        }
        emulate(sessionId ?? '', params['enabled'] === true);
        return {};
      case 'Runtime.evaluate':
        return evaluate(String(params['expression']));
      case 'Input.dispatchMouseEvent':
        return dispatchMouse(params);
      default:
        return {};
    }
  };

  const send = vi.fn(
    async (method: string, params: CDPPayload = {}, sessionId?: string): Promise<CDPPayload> => {
      const step = stepName(method, params);
      calls.push({ method, params, step, ...(sessionId ? { sessionId } : {}) });
      const paused = pauses.findIndex(
        (p) => p.step === step && (p.sessionId === undefined || p.sessionId === sessionId)
      );
      if (paused >= 0) {
        const [hold] = pauses.splice(paused, 1);
        hold.reached();
        await hold.release;
      }
      const failure = failures.get(step);
      if (failure !== undefined) {
        failures.delete(step);
        throw new Error(failure);
      }
      return answer(method, params, sessionId);
    }
  );

  const listeners = new Map<string, Set<(params: CDPPayload) => void>>();
  const client = {
    state: 'connected' as const,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    send,
    on: vi.fn((event: string, listener: (params: CDPPayload) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    }),
    off: vi.fn((event: string, listener: (params: CDPPayload) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    once: vi.fn(async () => ({})),
  } as unknown as CDPTransport;

  return {
    client,
    calls,
    timeline,
    page,
    /** Session-scoped steps after attach, optionally `session:step`. */
    steps(opts?: { withSession?: boolean }): string[] {
      return calls
        .filter((c) => c.sessionId && c.method !== 'Page.enable')
        .map((c) => (opts?.withSession ? `${c.sessionId}:${c.step}` : c.step));
    },
    /**
     * Hold the next `step` (on `sessionId`, if given) on the wire. `reached`
     * resolves when it is sent; it lands and is answered on `release()`.
     */
    pause(step: string, sessionId?: string) {
      let release!: () => void;
      let reached!: () => void;
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      pauses.push({ step, ...(sessionId ? { sessionId } : {}), release: released, reached });
      return { reached: arrived, release };
    },
    /** Detach a session: Chrome drops its emulation and says so. */
    detach(sessionId: string): void {
      if (page.capturers.has(sessionId)) emulate(sessionId, false);
      for (const listener of listeners.get('Target.detachedFromTarget') ?? []) {
        listener({ sessionId });
      }
    },
    /** Fail the next `step` with `message`. */
    failNext(step: string, message: string): void {
      failures.set(step, message);
    },
    shown,
  };
}
