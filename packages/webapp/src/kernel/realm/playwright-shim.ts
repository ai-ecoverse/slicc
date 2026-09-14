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

export interface PlaywrightNewContextOptions {
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

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

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

export class PlaywrightPage {
  private closed = false;

  constructor(
    private readonly rpc: PlaywrightShimRpc,
    private readonly targetId: string,
    private readonly onClose?: () => void
  ) {}

  async goto(url: string, _options?: { waitUntil?: string; timeout?: number }): Promise<void> {
    await this.rpc.call('browser', 'navigateTab', [this.targetId, url]);
  }

  async waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void> {
    await this.rpc.call('browser', 'waitForLoadState', [this.targetId, state ?? 'load']);
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

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
    const code = `(${fn.toString()}).apply(null, [Array.from(document.querySelectorAll(${JSON.stringify(selector)}))].concat(JSON.parse(${JSON.stringify(JSON.stringify(args))})))`;
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
    if (this.closed) return;
    this.closed = true;
    await this.rpc.call('browser', 'closeTab', [this.targetId]);
    this.onClose?.();
  }
}

export class PlaywrightBrowserContext {
  private readonly openPages: PlaywrightPage[] = [];

  constructor(private readonly rpc: PlaywrightShimRpc) {}

  async newPage(options?: PlaywrightNewPageOptions): Promise<PlaywrightPage> {
    const targetId = (await this.rpc.call('browser', 'createTab', ['about:blank'])) as string;
    if (options?.viewport) {
      await this.rpc.call('browser', 'setViewport', [
        targetId,
        options.viewport.width,
        options.viewport.height,
      ]);
    }
    const page: PlaywrightPage = new PlaywrightPage(this.rpc, targetId, () => {
      const idx = this.openPages.indexOf(page);
      if (idx !== -1) this.openPages.splice(idx, 1);
    });
    this.openPages.push(page);
    return page;
  }

  pages(): PlaywrightPage[] {
    return [...this.openPages];
  }

  async close(): Promise<void> {
    const pages = this.openPages.splice(0, this.openPages.length);
    for (const page of pages) {
      await page.close();
    }
  }
}

export class PlaywrightBrowser {
  private readonly openPages: PlaywrightPage[] = [];
  private readonly openContexts: PlaywrightBrowserContext[] = [];

  constructor(private readonly rpc: PlaywrightShimRpc) {}

  async newPage(options?: PlaywrightNewPageOptions): Promise<PlaywrightPage> {
    const targetId = (await this.rpc.call('browser', 'createTab', ['about:blank'])) as string;
    if (options?.viewport) {
      await this.rpc.call('browser', 'setViewport', [
        targetId,
        options.viewport.width,
        options.viewport.height,
      ]);
    }
    const page: PlaywrightPage = new PlaywrightPage(this.rpc, targetId, () => {
      const idx = this.openPages.indexOf(page);
      if (idx !== -1) this.openPages.splice(idx, 1);
    });
    this.openPages.push(page);
    return page;
  }

  async newContext(_options?: PlaywrightNewContextOptions): Promise<PlaywrightBrowserContext> {
    const context = new PlaywrightBrowserContext(this.rpc);
    this.openContexts.push(context);
    return context;
  }

  contexts(): PlaywrightBrowserContext[] {
    return [...this.openContexts];
  }

  async close(): Promise<void> {
    const pages = this.openPages.splice(0, this.openPages.length);
    for (const page of pages) {
      await page.close();
    }
    const contexts = this.openContexts.splice(0, this.openContexts.length);
    for (const context of contexts) {
      await context.close();
    }
  }
}

export interface PlaywrightShim {
  chromium: {
    launch(options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser>;
    connect(wsEndpoint: string, options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser>;
    connectOverCDP(endpoint: string, options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser>;
  };
  firefox: {
    launch(options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser>;
    connect(wsEndpoint: string, options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser>;
  };
  webkit: {
    launch(options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser>;
    connect(wsEndpoint: string, options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser>;
  };
}

export function createPlaywrightShim(rpc: PlaywrightShimRpc): PlaywrightShim {
  const launch = async (_options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser> => {
    return new PlaywrightBrowser(rpc);
  };
  const connect = async (
    _endpoint: string,
    _options?: PlaywrightLaunchOptions
  ): Promise<PlaywrightBrowser> => {
    return new PlaywrightBrowser(rpc);
  };
  return {
    chromium: { launch, connect, connectOverCDP: connect },
    firefox: { launch, connect },
    webkit: { launch, connect },
  };
}
