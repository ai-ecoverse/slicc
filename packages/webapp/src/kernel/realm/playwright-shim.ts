/**
 * `playwright-shim.ts` — a Playwright-shaped API backed by SLICC's existing
 * CDP connection (`BrowserAPI`) rather than a bundled Playwright/browser
 * binary. `createPlaywrightShim(rpc)` is wired into the realm module
 * resolver (see `js-realm-shared.ts`'s `SHIMMED_PACKAGES`) so
 * `require('playwright')` / `import('playwright')` resolves inside realm
 * scripts to `{ chromium, firefox, webkit }` — all three launchers drive the
 * SAME already-running Chrome instance (SLICC never spawns a second
 * browser), so there is no meaningful behavioral difference between them
 * here.
 *
 * Every method is a thin translation to one `rpc.call('browser', op, args)`
 * against the host ops added in `realm-host.ts`'s `dispatchBrowser`
 * (`createTab` / `closeTab` / `setViewport` / `navigateTab` /
 * `screenshotTab` / `waitForLoadState`, plus the pre-existing `eval` /
 * `evalAsync`). Only the ~15 methods real fixture scripts (stardust, AEM)
 * call are implemented — see `docs/node-compat-shims.md` for the full
 * supported/unsupported surface.
 */

/**
 * Structural slice of `RealmRpcClient` — deliberately NOT importing the
 * real class so this module has zero import-time coupling to the realm
 * wiring and can be unit tested with a plain mock.
 */
export interface PlaywrightShimRpc {
  call(channel: string, op: string, args?: unknown[]): Promise<unknown>;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface PlaywrightLaunchOptions {
  headless?: boolean;
  [key: string]: unknown;
}

export interface PlaywrightNewPageOptions {
  viewport?: ViewportSize;
  [key: string]: unknown;
}

export interface PlaywrightScreenshotOptions {
  path?: string;
  fullPage?: boolean;
}

export interface PlaywrightBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Base64 (standard alphabet) → `Uint8Array`. Avoids Node's `Buffer` (not available in the realm). */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Wraps a `document.querySelector(All)` result identified by
 * `(selector, index)` rather than an opaque CDP object/remote handle — every
 * method just re-runs the selector query against the live DOM at call time.
 * Simpler than JS-object round-tripping through `Runtime.evaluate`, and
 * matches Playwright's "handles auto-invalidate on navigation" caveat well
 * enough for short-lived fixture scripts.
 */
export class PlaywrightElementHandle {
  constructor(
    private readonly rpc: PlaywrightShimRpc,
    private readonly targetId: string,
    private readonly selector: string,
    private readonly index: number
  ) {}

  private evalOnElement<R>(body: string): Promise<R> {
    const code = `(() => { const els = document.querySelectorAll(${JSON.stringify(this.selector)}); const el = els[${this.index}]; ${body} })()`;
    return this.rpc.call('browser', 'evalAsync', [this.targetId, code]) as Promise<R>;
  }

  async textContent(): Promise<string | null> {
    return this.evalOnElement<string | null>('return el ? el.textContent : null;');
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.evalOnElement<string | null>(
      `return el ? el.getAttribute(${JSON.stringify(name)}) : null;`
    );
  }

  async isVisible(): Promise<boolean> {
    return this.evalOnElement<boolean>(
      "if (!el) return false; const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;"
    );
  }

  async boundingBox(): Promise<PlaywrightBoundingBox | null> {
    return this.evalOnElement<PlaywrightBoundingBox | null>(
      'if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };'
    );
  }
}

/** Wraps a single real browser tab (a `targetId` from the host's `createTab`). */
export class PlaywrightPage {
  constructor(
    private readonly rpc: PlaywrightShimRpc,
    private readonly targetId: string,
    private readonly onClose?: (targetId: string) => void
  ) {}

  async goto(url: string, _options?: { waitUntil?: string; timeout?: number }): Promise<void> {
    await this.rpc.call('browser', 'navigateTab', [this.targetId, url]);
  }

  async waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void> {
    await this.rpc.call('browser', 'waitForLoadState', [this.targetId, state ?? 'load']);
  }

  /** Pure client-side delay — the realm already has real wall-clock timers, so no host RPC is needed. */
  async waitForTimeout(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Mirrors Playwright's `page.evaluate(fn, ...args)`: functions are
   * serialized to source and invoked as an IIFE, with the whole args array
   * JSON round-tripped as a single unit (matching Playwright's own
   * args-must-be-serializable contract) rather than per-argument, so values
   * that throw on serialization (cycles) fail fast instead of one arg
   * silently becoming `"undefined"` or `null` while its neighbors don't; a
   * string is passed through verbatim as raw code to eval, same as
   * Playwright's string-expression overload.
   */
  async evaluate<R = unknown>(
    fn: ((...args: unknown[]) => R | Promise<R>) | string,
    ...args: unknown[]
  ): Promise<R> {
    const code =
      typeof fn === 'string'
        ? fn
        : `(${fn.toString()}).apply(null, JSON.parse(${JSON.stringify(JSON.stringify(args))}))`;
    return this.rpc.call('browser', 'evalAsync', [this.targetId, code]) as Promise<R>;
  }

  async screenshot(options?: PlaywrightScreenshotOptions): Promise<Uint8Array> {
    const screenshotOpts: { fullPage?: boolean } = {};
    if (options?.fullPage !== undefined) screenshotOpts.fullPage = options.fullPage;
    const base64 = (await this.rpc.call('browser', 'screenshotTab', [
      this.targetId,
      screenshotOpts,
    ])) as string;
    const bytes = base64ToBytes(base64);
    if (options?.path) {
      await this.rpc.call('vfs', 'writeFileBinary', [options.path, bytes]);
    }
    return bytes;
  }

  // biome-ignore lint/style/useNamingConvention: `$`/`$$` mirror Playwright's real API names exactly, so fixture scripts can call `page.$(...)` unmodified.
  async $(selector: string): Promise<PlaywrightElementHandle | null> {
    const exists = (await this.rpc.call('browser', 'evalAsync', [
      this.targetId,
      `!!document.querySelector(${JSON.stringify(selector)})`,
    ])) as boolean;
    if (!exists) return null;
    return new PlaywrightElementHandle(this.rpc, this.targetId, selector, 0);
  }

  // biome-ignore lint/style/useNamingConvention: `$`/`$$` mirror Playwright's real API names exactly, so fixture scripts can call `page.$$(...)` unmodified.
  async $$(selector: string): Promise<PlaywrightElementHandle[]> {
    const count = (await this.rpc.call('browser', 'evalAsync', [
      this.targetId,
      `document.querySelectorAll(${JSON.stringify(selector)}).length`,
    ])) as number;
    const handles: PlaywrightElementHandle[] = [];
    for (let i = 0; i < count; i++) {
      handles.push(new PlaywrightElementHandle(this.rpc, this.targetId, selector, i));
    }
    return handles;
  }

  // biome-ignore lint/style/useNamingConvention: `$$eval` mirrors Playwright's real API name exactly, so fixture scripts can call `page.$$eval(...)` unmodified.
  async $$eval<R = unknown>(
    selector: string,
    fn: ((elements: Element[], ...args: unknown[]) => R | Promise<R>) | string,
    ...args: unknown[]
  ): Promise<R> {
    if (typeof fn === 'string') {
      return this.rpc.call('browser', 'evalAsync', [this.targetId, fn]) as Promise<R>;
    }
    const serializedArgs = args.map((a) => JSON.stringify(a)).join(', ');
    const callArgs = serializedArgs
      ? `Array.from(document.querySelectorAll(${JSON.stringify(selector)})), ${serializedArgs}`
      : `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`;
    const code = `(${fn.toString()})(${callArgs})`;
    return this.rpc.call('browser', 'evalAsync', [this.targetId, code]) as Promise<R>;
  }

  async content(): Promise<string> {
    return this.rpc.call('browser', 'evalAsync', [
      this.targetId,
      'document.documentElement.outerHTML',
    ]) as Promise<string>;
  }

  async setViewportSize(size: ViewportSize): Promise<void> {
    await this.rpc.call('browser', 'setViewport', [this.targetId, size.width, size.height]);
  }

  async close(): Promise<void> {
    await this.rpc.call('browser', 'closeTab', [this.targetId]);
    this.onClose?.(this.targetId);
  }
}

/**
 * Wraps a "browser" — in reality just a bookkeeping set of tabs opened
 * through this launch() call, so `close()` knows which real tabs to tear
 * down. There's no separate browser process to spawn or attach to; the
 * host already owns the one real Chrome instance.
 */
export class PlaywrightBrowser {
  private readonly pageTargetIds: string[] = [];

  constructor(private readonly rpc: PlaywrightShimRpc) {}

  async newPage(options?: PlaywrightNewPageOptions): Promise<PlaywrightPage> {
    const targetId = (await this.rpc.call('browser', 'createTab', ['about:blank'])) as string;
    this.pageTargetIds.push(targetId);
    if (options?.viewport) {
      await this.rpc.call('browser', 'setViewport', [
        targetId,
        options.viewport.width,
        options.viewport.height,
      ]);
    }
    return new PlaywrightPage(this.rpc, targetId, (closedTargetId) => {
      const index = this.pageTargetIds.indexOf(closedTargetId);
      if (index !== -1) this.pageTargetIds.splice(index, 1);
    });
  }

  async close(): Promise<void> {
    const targetIds = this.pageTargetIds.splice(0, this.pageTargetIds.length);
    for (const targetId of targetIds) {
      await this.rpc.call('browser', 'closeTab', [targetId]);
    }
  }
}

export interface PlaywrightShim {
  chromium: { launch(options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser> };
  firefox: { launch(options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser> };
  webkit: { launch(options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser> };
}

/**
 * Builds the `{ chromium, firefox, webkit }` module shape realm scripts get
 * back from `require('playwright')` / `import('playwright')`. `launch()` is
 * a no-op spawn — SLICC's Chrome is already running — it just hands back a
 * fresh `PlaywrightBrowser` bookkeeping wrapper over `rpc`. All three
 * launchers are identical (see module doc comment).
 */
export function createPlaywrightShim(rpc: PlaywrightShimRpc): PlaywrightShim {
  const launch = async (_options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser> => {
    return new PlaywrightBrowser(rpc);
  };
  return {
    chromium: { launch },
    firefox: { launch },
    webkit: { launch },
  };
}
