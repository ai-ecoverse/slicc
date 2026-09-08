/**
 * `TabHandle` — the session-explicit page API.
 *
 * Every operation that drives a PAGE lives here, bound at construction to one
 * tab: its `targetId`, the CDP `sessionId` attached to it, and the transport
 * that session lives on. Nothing here reads a bridge-wide "current tab"
 * cursor, which is what lets `BrowserAPI.withTab` run commands on distinct
 * tabs concurrently instead of serializing them behind one bridge-wide lock
 * (issue #2417 follow-up).
 *
 * A handle is minted by `withTab` and handed to its callback. It is valid for
 * as long as the session it names is: a stale session is healed by re-attaching
 * and re-running the callback with a FRESH handle, never by mutating this one.
 *
 * The `transport` a handle carries is the accounted facade from
 * `BrowserAPI.getTransport()`-style wrapping, so every session-scoped `send`
 * — including raw ones a caller issues as `tab.transport.send(m, p,
 * tab.sessionId)` — is credited to the replay guard.
 */

import { createLogger } from '../base/logger.js';
import { abortableDelay, abortWaiter, throwIfAborted } from './command-abort.js';
import { INJECTED_ARIA_SNAPSHOT_SCRIPT } from './injected-aria-snapshot.js';
import { normalizeAccessibilityText } from './normalize-accessibility-text.js';
import { type AbortWaiter, waitForEvent } from './pending-request-table.js';
import type { CDPTransport } from './transport.js';
import type {
  AccessibilityNode,
  BoundingBox,
  EvaluateOptions,
  FrameEvaluateOptions,
  FrameInfo,
  WaitForSelectorOptions,
} from './types.js';

const log = createLogger('tab-handle');

/**
 * A CDP message payload (params or result) — a protocol-defined JSON object
 * probed key by key at each use site. Named so the shape is stated once
 * instead of an untyped string-keyed bag per site.
 */
export type CdpPayload = { [key: string]: unknown };

/** Bound for the session-scoped `Page.loadEventFired` wait in {@link TabHandle.navigate}. */
const NAVIGATE_LOAD_TIMEOUT_MS = 30000;

/**
 * Per-target emulation override, re-applied on every fresh attach so a
 * sibling driver switching tabs cannot reset it (see
 * {@link TabHandle.setViewportOverride}).
 */
export interface ViewportOverride {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  /** Set for mobile emulation so sites serve their mobile layout. */
  userAgent?: string;
}

/** Which JS world a frame's cached execution context belongs to. */
export type ExecutionWorld = 'main' | 'isolated';

/**
 * The slice of the bridge a page operation still needs.
 *
 * Deliberately tiny: everything else a handle does is session-scoped and goes
 * straight down its own transport. What is left is genuinely bridge-global —
 * window focus, the per-target viewport record, and the execution-context
 * caches the bridge fills from `Runtime.executionContext*` events.
 */
export interface TabHost {
  /**
   * Run `fn` holding the bridge-wide lock. Reserved for operations that touch
   * state shared by every tab (window focus).
   */
  runGlobal<T>(targetId: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Foreground-fallback capture: wake the tab's renderer with
   * `Page.bringToFront`, capture, and give window focus back. Global (it walks
   * other tabs), so the bridge owns it.
   */
  wakeCapture(tab: TabHandle, params: CdpPayload): Promise<CdpPayload>;
  /** The override recorded for a target, if any. */
  viewportOverride(targetId: string): ViewportOverride | undefined;
  /** Remember an override so a fresh attach re-applies it. */
  recordViewportOverride(targetId: string, vp: ViewportOverride): void;
  /**
   * The live frameId → executionContextId cache for one session and world.
   * Keyed by SESSION, not by the bridge cursor: a sibling tab attaching must
   * not invalidate this tab's contexts.
   */
  frameContexts(sessionId: string, world: ExecutionWorld): Map<string, number>;
}

/**
 * Read PNG width from IHDR (bytes 16–19 after the 8-byte signature).
 * Returns 0 for non-PNG data — without the signature check, JPEG/WebP bytes
 * at the same offsets decode to a garbage "width" and --max-width would
 * compute a nonsensical rescale.
 */
function pngWidth(base64: string): number {
  try {
    const bin = atob(base64.slice(0, 48));
    if (!bin.startsWith('\x89PNG\r\n\x1a\n')) return 0;
    return (
      ((bin.charCodeAt(16) << 24) |
        (bin.charCodeAt(17) << 16) |
        (bin.charCodeAt(18) << 8) |
        bin.charCodeAt(19)) >>>
      0
    );
  } catch {
    return 0;
  }
}

/**
 * Wait for one CDP event **belonging to a given session**.
 *
 * `CDPTransport.once()` resolves on the first matching event from ANY session,
 * which is only safe while a single session exists at a time. Layered on top
 * of `on`/`off` here rather than changed in the transports so every other
 * `once()` caller keeps its semantics.
 *
 * Events that carry no `sessionId` still match: transports that synthesize CDP
 * (cherry, the extension bridge) do not always stamp one, and dropping those
 * would hang the wait instead of fixing a bleed.
 */
export function onceForSession(
  transport: CDPTransport,
  event: string,
  sessionId: string,
  timeoutMs: number,
  abort?: AbortWaiter
): Promise<CdpPayload> {
  return waitForEvent<CdpPayload>(
    (deliver) => {
      const listener = (params: CdpPayload): void => {
        const eventSession = params['sessionId'];
        if (typeof eventSession === 'string' && eventSession !== sessionId) return;
        deliver(params);
      };
      transport.on(event, listener);
      return () => transport.off(event, listener);
    },
    timeoutMs,
    `Timed out waiting for event: ${event}`,
    abort
  );
}

/** Options accepted by {@link TabHandle.screenshot}. */
export interface ScreenshotOptions {
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  maxWidth?: number;
  /**
   * Whether a failed capture may retry after `Page.bringToFront` (wakes a
   * suspended renderer but STEALS WINDOW FOCUS). Default true — background
   * thumbnailing passes false so capturing never yanks focus from SLICC.
   */
  foregroundFallback?: boolean;
}

/** Options accepted by {@link TabHandle.setViewportOverride}. */
export interface ViewportOptions {
  deviceScaleFactor?: number;
  mobile?: boolean;
  userAgent?: string;
}

/**
 * The page API a `withTab` callback receives: {@link TabHandle} with its
 * private wiring dropped.
 *
 * A mapped type over `keyof TabHandle`, which lists only PUBLIC members — so a
 * duck-typed double (a test, or a shell-layer module that must not import
 * `cdp/`) can satisfy it structurally, while the class stays the one
 * implementation.
 */
export type TabPage = { [K in keyof TabHandle]: TabHandle[K] };

/**
 * One tab's page API, bound to one CDP session.
 *
 * Obtain one from `BrowserAPI.withTab(targetId, (tab) => …)`. Holding a handle
 * past the end of that callback is allowed but not protected: the session may
 * have been evicted or replaced by then, and its sends will fail as stale.
 */
export class TabHandle {
  constructor(
    private readonly host: TabHost,
    /** The tab this handle drives. */
    readonly targetId: string,
    /** The CDP session attached to {@link targetId}. */
    readonly sessionId: string,
    /**
     * The channel {@link sessionId} lives on — the accounted facade, so raw
     * sends made through it count toward the replay guard.
     */
    readonly transport: CDPTransport,
    /**
     * Cooperative cancellation for the command this handle was minted for —
     * the `signal` its `withTab` caller passed. PRIVATE on purpose: it is the
     * handle's own business, and {@link TabPage} maps over public members, so
     * keeping it private leaves the duck-typed doubles in tests and the shell
     * layer unchanged.
     *
     * Every page operation funnels through {@link send}, so parking it here
     * covers the whole surface at one seam. See `CommandAbortedError` for
     * where cancellation lands and what it cannot cancel.
     */
    private readonly signal?: AbortSignal | undefined
  ) {}

  /**
   * Send a session-scoped CDP command on this tab.
   * The raw escape hatch behind every method below.
   */
  send(method: string, params: CdpPayload = {}): Promise<CdpPayload> {
    // The cancellation boundary BETWEEN round trips, and the reason it is here
    // rather than in each method: a multi-step operation (`evaluate` enables
    // `Runtime` then evaluates, `type` sends a pair of events per key) stops at
    // its next step once its caller has given up. The request already on the
    // wire is not cancellable — CDP has no verb for it.
    throwIfAborted(this.signal, `about to send ${method}`);
    return this.transport.send(method, params, this.sessionId);
  }

  // ---------------------------------------------------------------------
  // Navigation and capture
  // ---------------------------------------------------------------------

  /**
   * Navigate this page to a URL and wait for THIS page's load event.
   *
   * The wait is session-scoped: with several tabs attached, an unfiltered
   * `once('Page.loadEventFired')` resolved on whichever tab loaded first, so
   * `goto` returned while its own page was still `interactive` and the next
   * snapshot showed the previous document (issue #2417). Nothing bridge-wide
   * is held across it, so a page that never fires `load` stalls only this tab
   * for the 30 s bound — its own per-tab lock, which is the point.
   */
  async navigate(url: string): Promise<void> {
    // Enable Page domain for lifecycle events
    await this.send('Page.enable');

    const loadPromise = onceForSession(
      this.transport,
      'Page.loadEventFired',
      this.sessionId,
      NAVIGATE_LOAD_TIMEOUT_MS,
      // A caller that gave up gets the wait rejected now, rather than paying
      // the full 30 s bound for a page nobody is going to read.
      abortWaiter(this.signal, `waiting for ${url} to fire its load event`)
    );
    // Observe it before `Page.navigate` can throw: an unobserved rejection
    // from the timeout would surface as an unhandled promise rejection long
    // after the caller gave up. Awaiting `loadPromise` below still sees it.
    void loadPromise.catch(() => undefined);

    // `Page.navigate` itself does not return until the navigation commits, so
    // a URL that never responds hangs HERE, not in the load wait.
    await this.send('Page.navigate', { url });
    await loadPromise;
  }

  /**
   * Foreground this page (a local tab raise, or the follower's tab over the
   * remote transport).
   *
   * Window focus is browser-GLOBAL state, not tab state: two tabs raising
   * themselves concurrently would fight, so this is one of the few operations
   * that still takes the bridge-wide lock.
   */
  async bringToFront(): Promise<void> {
    await this.host.runGlobal(this.targetId, async () => {
      await this.send('Page.bringToFront');
    });
  }

  /** Take a screenshot of this page. Returns a base64-encoded image. */
  async screenshot(options?: ScreenshotOptions): Promise<string> {
    const params: CdpPayload = {
      format: options?.format ?? 'png',
      // Only capture beyond viewport when fullPage or a clip is requested.
      // Default viewport screenshots should respect the viewport boundary.
      captureBeyondViewport: !!(options?.clip || options?.fullPage),
    };
    if (options?.quality !== undefined) params['quality'] = options.quality;
    if (options?.clip || options?.fullPage) {
      params['clip'] = await this.captureClip(options);
    }
    // No clip/fullPage = viewport screenshot (Chrome's default behavior)

    let result: CdpPayload;
    try {
      result = await this.send('Page.captureScreenshot', params);
    } catch (err: unknown) {
      // Background/throttled tabs have a suspended renderer — wake it and
      // retry once. Foregrounding steals window focus, so callers that
      // capture in the background opt out and accept the failure instead.
      if (options?.foregroundFallback === false) throw err;
      result = await this.host.wakeCapture(this, params);
    }
    const base64 = result['data'] as string;
    if (options?.maxWidth) return await this.applyMaxWidth(base64, options.maxWidth, params);
    return base64;
  }

  /** The `clip` for a `--full-page` / explicit-clip capture, in CSS pixels. */
  private async captureClip(
    options: ScreenshotOptions
  ): Promise<{ x: number; y: number; width: number; height: number; scale: number }> {
    if (options.clip) return { ...options.clip, scale: options.clip.scale ?? 1 };
    // Full-page: CSS viewport width + CSS scroll height
    let cssWidth = 0;
    let cssScrollHeight = 0;
    try {
      await this.send('Runtime.enable');
      const evalResult = await this.send('Runtime.evaluate', {
        expression:
          'JSON.stringify({ w: window.innerWidth, h: document.documentElement.scrollHeight })',
        returnByValue: true,
      });
      const val = JSON.parse((evalResult['result'] as { value?: string })?.value ?? '{}');
      cssWidth = val.w ?? 0;
      cssScrollHeight = val.h ?? 0;
    } catch (e) {
      log.warn('fullPage: failed to evaluate scroll dimensions, falling back to viewport', e);
    }
    return { x: 0, y: 0, width: cssWidth || 1280, height: cssScrollHeight || 800, scale: 1 };
  }

  /**
   * Re-capture with a downscaled clip if the image exceeds maxWidth.
   * Reads the width from the PNG IHDR and applies clip.scale to shrink.
   */
  private async applyMaxWidth(
    base64: string,
    maxWidth: number,
    params: CdpPayload
  ): Promise<string> {
    const peekWidth = pngWidth(base64);
    if (!peekWidth || peekWidth <= maxWidth) return base64;

    const scale = maxWidth / peekWidth;
    const existingClip = params['clip'] as
      | { x: number; y: number; width: number; height: number; scale?: number }
      | undefined;

    if (existingClip) {
      // `peekWidth` is the ENCODED width, which already includes the clip's
      // own scale (e.g. --hires sets scale=DPR). Replacing the scale would
      // shrink relative to CSS pixels instead — a 2560px hires capture asked
      // to fit 1280 would come back at 640. Compose the ratios instead.
      existingClip.scale = (existingClip.scale ?? 1) * scale;
    } else {
      let vw = 1280;
      let vh = 800;
      try {
        await this.send('Runtime.enable');
        const dim = await this.send('Runtime.evaluate', {
          expression: 'JSON.stringify({w:window.innerWidth,h:window.innerHeight})',
          returnByValue: true,
        });
        const v = JSON.parse((dim['result'] as { value?: string })?.value ?? '{}');
        vw = v.w || 1280;
        vh = v.h || 800;
      } catch {
        /* use defaults */
      }
      params['clip'] = { x: 0, y: 0, width: vw, height: vh, scale };
    }
    params['captureBeyondViewport'] = true;

    try {
      const resized = await this.send('Page.captureScreenshot', params);
      return resized['data'] as string;
    } catch (err) {
      log.warn('maxWidth re-capture failed, returning original', err);
      return base64;
    }
  }

  // ---------------------------------------------------------------------
  // Viewport emulation
  // ---------------------------------------------------------------------

  /**
   * Apply a viewport emulation override to this tab and remember it per
   * target.
   *
   * CDP device-metrics overrides live on the CDP *session*, but the bridge
   * creates a fresh session whenever a tab is re-attached after its own was
   * invalidated — so with concurrent drivers a plain
   * `Emulation.setDeviceMetricsOverride` silently evaporates and screenshots
   * get captured at whatever width the window happens to have. Recording the
   * override per target lets every fresh attach re-apply it, making a tab's
   * viewport stable no matter which driver measured it last.
   */
  async setViewportOverride(
    width: number,
    height: number,
    options?: ViewportOptions
  ): Promise<void> {
    // Omitted options inherit the target's existing override: `resize` on a
    // tab opened with mobile emulation must change only the dimensions, not
    // silently strip the device identity (DPR / mobile layout / UA).
    const prev = this.host.viewportOverride(this.targetId);
    const vp: ViewportOverride = {
      width,
      height,
      deviceScaleFactor: options?.deviceScaleFactor ?? prev?.deviceScaleFactor ?? 1,
      mobile: options?.mobile ?? prev?.mobile ?? false,
      ...((options?.userAgent ?? prev?.userAgent) !== undefined && {
        userAgent: options?.userAgent ?? prev?.userAgent,
      }),
    };
    await this.applyViewportOverride(vp);
    this.host.recordViewportOverride(this.targetId, vp);
  }

  /** Send the recorded metrics (and UA + touch, for mobile emulation) to this session. */
  async applyViewportOverride(vp: ViewportOverride): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.deviceScaleFactor,
      mobile: vp.mobile,
    });
    if (vp.mobile) {
      // Sites that feature-detect touch (navigator.maxTouchPoints) rather
      // than sniffing width/UA won't switch layouts without this.
      await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    if (vp.userAgent !== undefined) {
      await this.send('Emulation.setUserAgentOverride', { userAgent: vp.userAgent });
    }
  }

  // ---------------------------------------------------------------------
  // Evaluation
  // ---------------------------------------------------------------------

  /** Evaluate a JavaScript expression in this page. Returns the result value. */
  async evaluate(expression: string, options?: EvaluateOptions): Promise<unknown> {
    await this.send('Runtime.enable');
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: options?.awaitPromise ?? true,
      returnByValue: options?.returnByValue ?? true,
    });
    return readEvaluateResult(result, 'Evaluation failed');
  }

  /**
   * Evaluate a JavaScript expression in a specific frame.
   * Uses an isolated world by default; callers may explicitly request the
   * page's main world.
   */
  async evaluateInFrame(
    frameId: string,
    expression: string,
    options?: FrameEvaluateOptions
  ): Promise<unknown> {
    const world: ExecutionWorld = options?.world === 'main' ? 'main' : 'isolated';

    let contextId: number;
    try {
      contextId = await this.resolveFrameContext(frameId, world);
    } catch (err) {
      const label = world === 'main' ? 'main world' : 'isolated world';
      throw new Error(
        `Failed to resolve ${label} for frame ${frameId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (world === 'isolated') await this.send('Runtime.enable');

    const evaluateParams = {
      expression,
      contextId,
      awaitPromise: options?.awaitPromise ?? true,
      returnByValue: options?.returnByValue ?? true,
    };

    let result: CdpPayload;
    try {
      result = await this.send('Runtime.evaluate', evaluateParams);
    } catch (err) {
      if (!isDestroyedContextError(err)) throw err;
      this.host.frameContexts(this.sessionId, world).delete(frameId);
      contextId = await this.resolveFrameContext(frameId, world);
      result = await this.send('Runtime.evaluate', { ...evaluateParams, contextId });
    }

    const failure = evaluationFailure(result);
    if (failure === null) return (result['result'] as { value?: unknown })?.value;

    // The frame may have navigated between resolving the context and using
    // it — invalidate and try once with a fresh one.
    this.host.frameContexts(this.sessionId, world).delete(frameId);
    if (!isDestroyedContextError(new Error(failure))) {
      throw new Error(`Evaluation in frame ${frameId} failed: ${failure}`);
    }
    contextId = await this.resolveFrameContext(frameId, world);
    const retry = await this.send('Runtime.evaluate', { ...evaluateParams, contextId });
    const retryFailure = evaluationFailure(retry);
    if (retryFailure !== null) {
      throw new Error(`Evaluation in frame ${frameId} failed: ${retryFailure}`);
    }
    return (retry['result'] as { value?: unknown })?.value;
  }

  /** The execution context id for a frame + world, creating/re-reading it as needed. */
  private async resolveFrameContext(frameId: string, world: ExecutionWorld): Promise<number> {
    const cache = this.host.frameContexts(this.sessionId, world);
    const cached = cache.get(frameId);
    if (cached !== undefined) return cached;

    if (world === 'isolated') {
      const worldResult = await this.send('Page.createIsolatedWorld', {
        frameId,
        worldName: '__slicc_iframe',
      });
      const id = worldResult['executionContextId'] as number;
      cache.set(frameId, id);
      return id;
    }

    // Main world: contexts are announced by `Runtime.executionContextCreated`,
    // which the bridge routes into this cache. A disable/enable cycle makes
    // Chrome re-announce them for a frame we have not seen yet.
    await this.send('Runtime.enable');
    let id = cache.get(frameId);
    if (id === undefined) {
      await this.send('Runtime.disable');
      await this.send('Runtime.enable');
      id = cache.get(frameId);
    }
    if (id === undefined) {
      throw new Error(`Failed to find main world execution context for frame ${frameId}`);
    }
    return id;
  }

  // ---------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------

  /** Click an element matching a CSS selector. */
  async click(selector: string, modifiers = 0): Promise<void> {
    const box = await this.boundingBox(selector);
    if (!box) throw new Error(`Element not found: ${selector}`);
    await this.clickAt(box.x + box.width / 2, box.y + box.height / 2, modifiers);
  }

  /** Type text into the currently focused element, one key event per character. */
  async type(text: string): Promise<void> {
    for (const char of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: char });
    }
  }

  /**
   * Insert text into the currently focused element as a single composition
   * event (`Input.insertText`). Unlike {@link type}, this delivers the whole
   * string in one CDP frame, which is what the per-frame whole-token unmask
   * gate in the node-server proxy keys on — a multi-keystroke
   * `Input.dispatchKeyEvent` loop fragments masked tokens across many frames
   * and cannot be unmasked.
   */
  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  /** Wait for a CSS selector to appear in the DOM. */
  async waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<void> {
    const timeout = options?.timeout ?? 30000;
    const interval = options?.interval ?? 100;
    const start = Date.now();
    const step = `polling for selector ${selector}`;

    while (Date.now() - start < timeout) {
      throwIfAborted(this.signal, step);
      const found = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return;
      // A poll interval is this tab waiting on the page. Nothing bridge-wide
      // is held across it, so sibling tabs run at full speed meanwhile — and
      // an abandoned wait stops sleeping instead of re-probing a page nobody
      // is reading.
      await abortableDelay(interval, this.signal, step);
    }

    throw new Error(`waitForSelector timed out after ${timeout}ms: ${selector}`);
  }

  /** Click an element by its CDP backend node ID. */
  async clickByBackendNodeId(backendNodeId: number, modifiers = 0): Promise<void> {
    const objectId = await this.resolveNodeObjectId(backendNodeId);
    const box = await this.nodeBox(objectId);
    if (!box || box.width === 0 || box.height === 0) {
      // Element has no dimensions — fall back to programmatic click
      await this.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function() { this.click(); }',
      });
      return;
    }
    await this.clickAt(box.x + box.width / 2, box.y + box.height / 2, modifiers);
  }

  /** Double-click an element by its CDP backend node ID. */
  async dblclickByBackendNodeId(
    backendNodeId: number,
    button: 'left' | 'right' | 'middle' = 'left',
    modifiers = 0
  ): Promise<void> {
    const { x, y } = await this.resolveNodeCenter(backendNodeId);
    for (const clickCount of [1, 2]) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        clickCount,
        modifiers,
      });
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button,
        clickCount,
        modifiers,
      });
    }
  }

  /** Hover over an element by its CDP backend node ID. */
  async hoverByBackendNodeId(backendNodeId: number): Promise<void> {
    const { x, y } = await this.resolveNodeCenter(backendNodeId);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }

  /** Select a value on a `<select>` element by its CDP backend node ID. */
  async selectByBackendNodeId(backendNodeId: number, value: string): Promise<void> {
    const objectId = await this.resolveNodeObjectId(backendNodeId);
    await this.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(val) { this.value = val; this.dispatchEvent(new Event('change', { bubbles: true })); }`,
      arguments: [{ value }],
      returnByValue: true,
    });
  }

  /**
   * Check or uncheck a checkbox/radio element by its CDP backend node ID.
   * Only clicks if the current state differs from the desired state.
   */
  async setCheckedByBackendNodeId(
    backendNodeId: number,
    checked: boolean
  ): Promise<'toggled' | 'already'> {
    const objectId = await this.resolveNodeObjectId(backendNodeId);
    const stateResult = await this.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() { return this.checked; }`,
      returnByValue: true,
    });
    if ((stateResult['result'] as { value?: boolean })?.value === checked) return 'already';
    await this.clickByBackendNodeId(backendNodeId);
    return 'toggled';
  }

  /** Drag from one element to another by their CDP backend node IDs. */
  async dragByBackendNodeIds(startBackendNodeId: number, endBackendNodeId: number): Promise<void> {
    const start = await this.resolveNodeCenter(startBackendNodeId);
    const end = await this.resolveNodeCenter(endBackendNodeId);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: start.x,
      y: start.y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: end.x, y: end.y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: end.x,
      y: end.y,
      button: 'left',
      clickCount: 1,
    });
  }

  // ---------------------------------------------------------------------
  // Frames and accessibility
  // ---------------------------------------------------------------------

  /** The frame tree of this page as a flat list. */
  async getFrameTree(): Promise<FrameInfo[]> {
    await this.send('Page.enable');
    const result = await this.send('Page.getFrameTree');
    const frames: FrameInfo[] = [];
    flattenFrameTree(result['frameTree'] as CdpFrameTreeNode, frames);
    return frames;
  }

  /**
   * The accessibility tree of this page.
   *
   * Uses an injected JavaScript approach (ported from Playwright's
   * ariaSnapshot.ts) instead of CDP's Accessibility domain, so it works on any
   * browser engine (Chrome, WebKit, etc.).
   */
  async getAccessibilityTree(): Promise<AccessibilityNode> {
    const rawResult = await this.evaluate(INJECTED_ARIA_SNAPSHOT_SCRIPT, {
      awaitPromise: false,
      returnByValue: true,
    });
    if (!rawResult || typeof rawResult !== 'object') return { role: 'RootWebArea', name: '' };

    const tree = normalizeInjectedTree(rawResult as CdpPayload);

    // Annotate the tree with backendNodeId values from the CDP Accessibility
    // domain. The injected script runs in page context and cannot access CDP
    // backendNodeIds, so we fetch them separately and match by role+name.
    try {
      const axResult = await this.send('Accessibility.getFullAXTree');
      const nodes = axResult['nodes'] as Array<CdpPayload> | undefined;
      if (Array.isArray(nodes)) annotateTreeWithBackendNodeIds(tree, buildAxNodeIndex(nodes));
    } catch {
      // Accessibility domain not available in this context (e.g. WebKit, some
      // extension targets). Fall through — the CSS selector fallback works.
    }

    return tree;
  }

  /**
   * The accessibility tree for a specific frame.
   * With no `frameId`, delegates to {@link getAccessibilityTree}.
   */
  async getAccessibilityTreeForFrame(frameId?: string): Promise<AccessibilityNode> {
    if (!frameId) return this.getAccessibilityTree();
    const rawResult = await this.evaluateInFrame(frameId, INJECTED_ARIA_SNAPSHOT_SCRIPT, {
      awaitPromise: false,
      returnByValue: true,
    });
    if (!rawResult || typeof rawResult !== 'object') return { role: 'RootWebArea', name: '' };
    return normalizeInjectedTree(rawResult as CdpPayload);
  }

  // ---------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------

  /** Dispatch a full left/other-button click at viewport coordinates. */
  private async clickAt(x: number, y: number, modifiers: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
      modifiers,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
      modifiers,
    });
  }

  /** Resolve a backend node ID to a remote object ID. */
  private async resolveNodeObjectId(backendNodeId: number): Promise<string> {
    await this.send('DOM.enable');
    await this.send('Runtime.enable');
    const resolveResult = await this.send('DOM.resolveNode', { backendNodeId });
    const object = resolveResult['object'] as { objectId?: string } | undefined;
    if (!object?.objectId) {
      throw new Error(`Could not resolve backend node ${backendNodeId} to a DOM element`);
    }
    return object.objectId;
  }

  /** Scroll a resolved node into view and read its bounding box. */
  private async nodeBox(objectId: string): Promise<BoundingBox | undefined> {
    const boxResult = await this.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
          this.scrollIntoView({ block: 'center', inline: 'center' });
          const r = this.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }`,
      returnByValue: true,
    });
    return (boxResult['result'] as { value?: BoundingBox })?.value;
  }

  /**
   * Resolve a backend node ID to the center point of its bounding box.
   * Scrolls the element into view first.
   */
  private async resolveNodeCenter(backendNodeId: number): Promise<{ x: number; y: number }> {
    const objectId = await this.resolveNodeObjectId(backendNodeId);
    const box = await this.nodeBox(objectId);
    if (!box || box.width === 0 || box.height === 0) {
      throw new Error(`Element with backend node ${backendNodeId} has no dimensions`);
    }
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /** Get the bounding box of an element by CSS selector. */
  private async boundingBox(selector: string): Promise<BoundingBox | null> {
    await this.send('DOM.enable');
    const docResult = await this.send('DOM.getDocument', { depth: 0 });
    const rootNodeId = (docResult['root'] as { nodeId: number }).nodeId;

    let nodeId: number;
    try {
      const queryResult = await this.send('DOM.querySelector', { nodeId: rootNodeId, selector });
      nodeId = queryResult['nodeId'] as number;
    } catch {
      return null;
    }
    if (!nodeId) return null;

    const boxModel = await this.send('DOM.getBoxModel', { nodeId });
    const model = boxModel['model'] as { content: number[]; width: number; height: number };
    if (!model) return null;

    // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
    const quad = model.content;
    return { x: quad[0], y: quad[1], width: model.width, height: model.height };
  }
}

/** The recursive `Page.getFrameTree` result node. */
interface CdpFrameTreeNode {
  frame: { id: string; parentId?: string; url: string; name?: string; securityOrigin?: string };
  childFrames?: unknown[];
}

function flattenFrameTree(node: CdpFrameTreeNode, out: FrameInfo[]): void {
  out.push({
    frameId: node.frame.id,
    parentFrameId: node.frame.parentId,
    url: node.frame.url,
    name: node.frame.name ?? '',
    securityOrigin: node.frame.securityOrigin,
  });
  if (!Array.isArray(node.childFrames)) return;
  for (const child of node.childFrames) flattenFrameTree(child as CdpFrameTreeNode, out);
}

/** The message of a `Runtime.evaluate` exception, or `null` when it succeeded. */
function evaluationFailure(result: CdpPayload): string | null {
  const details = result['exceptionDetails'] as
    | { text: string; exception?: { description?: string } }
    | undefined;
  if (!details) return null;
  return details.exception?.description ?? details.text;
}

/** Unwrap a `Runtime.evaluate` result, turning a page exception into a throw. */
function readEvaluateResult(result: CdpPayload, label: string): unknown {
  const failure = evaluationFailure(result);
  if (failure !== null) throw new Error(`${label}: ${failure}`);
  return (result['result'] as { value?: unknown })?.value;
}

function isDestroyedContextError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('Cannot find context with specified id') ||
    message.includes('Execution context was destroyed')
  );
}

/**
 * Build a lookup map from (role, name) → backendDOMNodeId from the flat
 * CDP Accessibility.getFullAXTree node list.
 *
 * Keys are `${role}|${name}`. When the same role+name appears more than once
 * (e.g. two "Cancel" buttons), the first occurrence wins — that's the same
 * ambiguity the CSS selector fallback faces, so consistency matters more than
 * perfect accuracy.
 */
function buildAxNodeIndex(nodes: Array<CdpPayload>): Map<string, number> {
  const index = new Map<string, number>();
  for (const n of nodes) {
    const backendNodeId = typeof n['backendDOMNodeId'] === 'number' ? n['backendDOMNodeId'] : null;
    if (backendNodeId === null) continue;
    const roleObj = n['role'] as CdpPayload | undefined;
    const nameObj = n['name'] as CdpPayload | undefined;
    const role = typeof roleObj?.['value'] === 'string' ? roleObj['value'].toLowerCase() : '';
    const name = typeof nameObj?.['value'] === 'string' ? nameObj['value'] : '';
    if (!role) continue;
    const key = `${role}|${name}`;
    if (!index.has(key)) index.set(key, backendNodeId);
  }
  return index;
}

/**
 * Walk the injected ARIA tree and stamp each node with the backendNodeId
 * from the CDP Accessibility index (matched by role + accessible name).
 */
function annotateTreeWithBackendNodeIds(node: AccessibilityNode, index: Map<string, number>): void {
  const key = `${node.role.toLowerCase()}|${node.name}`;
  const id = index.get(key);
  if (id !== undefined) node.backendNodeId = id;
  if (node.children) {
    for (const child of node.children) annotateTreeWithBackendNodeIds(child, index);
  }
}

/**
 * Normalize the raw tree returned by the injected aria snapshot script
 * into the AccessibilityNode format expected by SLICC consumers.
 */
function normalizeInjectedTree(raw: CdpPayload): AccessibilityNode {
  const role = normalizeAccessibilityText(raw.role, 'unknown');
  const name = normalizeAccessibilityText(raw.name);

  const node: AccessibilityNode = { role, name };

  const value = normalizeAccessibilityText(raw.value);
  if (value !== '') node.value = value;

  const description = normalizeAccessibilityText(raw.description);
  if (description !== '') node.description = description;

  if (Array.isArray(raw.children) && raw.children.length > 0) {
    node.children = (raw.children as CdpPayload[])
      .map((child) => normalizeInjectedTree(child))
      .filter((c) => c.role !== 'unknown');
  }

  return node;
}
