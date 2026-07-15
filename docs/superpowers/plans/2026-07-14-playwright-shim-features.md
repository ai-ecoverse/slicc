# Playwright Realm Shim Feature Additions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `page.waitForTimeout`, `page.$$eval`, `browser.newContext`, and `chromium.connectOverCDP`/`<launcher>.connect` to the Playwright realm shim (`packages/webapp/src/kernel/realm/playwright-shim.ts`) so scripts that use these four Playwright APIs stop throwing `TypeError`/`undefined` when run against SLICC's shim.

**Architecture:** All four additions are thin client-side wrappers over the shim's existing `rpc.call('browser', op, args)` pattern (or, for `waitForTimeout`, no RPC at all). No changes to `realm-host.ts` or any other host-side file are required — every op already exists (`evalAsync`) or isn't needed (real `setTimeout` is already available in the realm).

**Tech Stack:** TypeScript, Vitest (unit + integration tests, mocked `PlaywrightShimRpc`).

## Global Constraints

- `browser.newContext()` provides grouping only — no cookie/storage isolation between contexts (single real Chrome profile). This must be stated in a doc comment on `PlaywrightBrowserContext` and in `docs/node-compat-shims.md`.
- `connectOverCDP`/`connect` accept an endpoint argument but ignore it — always return a `PlaywrightBrowser` wrapping the existing `rpc`, identical to `launch()`.
- `connectOverCDP` is added only to `chromium`. `connect` is added to `chromium`, `firefox`, and `webkit`.
- No new `realm-host.ts` op is added for `$$eval` or `waitForTimeout` — reuse the existing `evalAsync` op / native realm timers.
- Follow the existing arg-serialization convention exactly: function bodies via `fn.toString()`, each arg individually `JSON.stringify`'d into the generated code string.

---

### Task 1: `page.waitForTimeout(ms)`

**Files:**

- Modify: `packages/webapp/src/kernel/realm/playwright-shim.ts:122-124`
- Test: `packages/webapp/tests/kernel/realm/playwright-shim.test.ts`

**Interfaces:**

- Consumes: nothing new — pure client-side delay.
- Produces: `PlaywrightPage.waitForTimeout(ms: number): Promise<void>`, used by Task 5's integration test.

- [ ] **Step 1: Write the failing test**

Append to `packages/webapp/tests/kernel/realm/playwright-shim.test.ts`, right after the `createPlaywrightShim: page navigation + lifecycle` describe block (after line 168, before the `createPlaywrightShim: page.evaluate` describe block on line 170):

```ts
describe('createPlaywrightShim: page.waitForTimeout', () => {
  it('resolves after the given delay without making any rpc calls', async () => {
    vi.useFakeTimers();
    try {
      const rpc = mockRpc();
      const { chromium } = createPlaywrightShim(rpc);
      const browser = await chromium.launch();
      const page = await browser.newPage();
      rpc.calls.length = 0;

      let resolved = false;
      const promise = page.waitForTimeout(500).then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(499);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(resolved).toBe(true);
      expect(rpc.calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/kernel/realm/playwright-shim.test.ts -t "waitForTimeout"`
Expected: FAIL with `page.waitForTimeout is not a function`

- [ ] **Step 3: Write minimal implementation**

In `packages/webapp/src/kernel/realm/playwright-shim.ts`, the `PlaywrightPage` class currently has this at lines 122-124:

```ts
  async waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void> {
    await this.rpc.call('browser', 'waitForLoadState', [this.targetId, state ?? 'load']);
  }
```

Add a new method directly after it (still inside `PlaywrightPage`):

```ts
  async waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void> {
    await this.rpc.call('browser', 'waitForLoadState', [this.targetId, state ?? 'load']);
  }

  /** Pure client-side delay — the realm already has real wall-clock timers, so no host RPC is needed. */
  async waitForTimeout(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/webapp/tests/kernel/realm/playwright-shim.test.ts -t "waitForTimeout"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/kernel/realm/playwright-shim.ts packages/webapp/tests/kernel/realm/playwright-shim.test.ts
git commit -m "feat(realm): add page.waitForTimeout to playwright shim"
```

---

### Task 2: `page.$$eval(selector, fn, ...args)`

**Files:**

- Modify: `packages/webapp/src/kernel/realm/playwright-shim.ts:169-179` (insert after `$$`)
- Test: `packages/webapp/tests/kernel/realm/playwright-shim.test.ts`

**Interfaces:**

- Consumes: the shim's existing `evalAsync` host op (`rpc.call('browser', 'evalAsync', [targetId, code])`), same as `evaluate`/`$`/`$$`.
- Produces: `PlaywrightPage.$$eval<R = unknown>(selector: string, fn: ((elements: Element[], ...args: unknown[]) => R | Promise<R>) | string, ...args: unknown[]): Promise<R>`, used by Task 5's integration test.

- [ ] **Step 1: Write the failing test**

Append to `packages/webapp/tests/kernel/realm/playwright-shim.test.ts`, right after the `createPlaywrightShim: page.$ / page.$$` describe block (after line 297, before the `createPlaywrightShim: ElementHandle` describe block on line 299):

```ts
describe('createPlaywrightShim: page.$$eval', () => {
  it('serializes a function + args into an Array.from(querySelectorAll(...)) IIFE call', async () => {
    const rpc = mockRpc({ evalAsync: 3 });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();

    const result = await page.$$eval(
      'li',
      (elements: Element[], suffix: string) => elements.length + suffix.length,
      '!!'
    );

    expect(result).toBe(3);
    const call = rpc.calls.find((c) => c.op === 'evalAsync');
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe('target-abc');
    const code = call!.args[1] as string;
    expect(code).toContain('document.querySelectorAll("li")');
    expect(code).toContain('Array.from');
    expect(code).toContain('"!!"');
  });

  it('omits the trailing comma when no extra args are passed', async () => {
    const rpc = mockRpc({ evalAsync: 0 });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();

    await page.$$eval('li', (elements: Element[]) => elements.length);

    const call = rpc.calls.find((c) => c.op === 'evalAsync');
    const code = call!.args[1] as string;
    expect(code.trim().endsWith('))')).toBe(true);
  });

  it('passes a raw string straight through as the eval code', async () => {
    const rpc = mockRpc({ evalAsync: 5 });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();

    const result = await page.$$eval('li', 'document.querySelectorAll("li").length');

    expect(result).toBe(5);
    expect(rpc.call).toHaveBeenCalledWith('browser', 'evalAsync', [
      'target-abc',
      'document.querySelectorAll("li").length',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/kernel/realm/playwright-shim.test.ts -t "\\$\\$eval"`
Expected: FAIL with `page.$$eval is not a function`

- [ ] **Step 3: Write minimal implementation**

In `packages/webapp/src/kernel/realm/playwright-shim.ts`, the `PlaywrightPage` class currently has this at lines 168-179:

```ts
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
```

Add a new method directly after it (still inside `PlaywrightPage`, before `content()`):

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/webapp/tests/kernel/realm/playwright-shim.test.ts -t "\\$\\$eval"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/kernel/realm/playwright-shim.ts packages/webapp/tests/kernel/realm/playwright-shim.test.ts
git commit -m "feat(realm): add page.\$\$eval to playwright shim"
```

---

### Task 3: `browser.newContext()` / `PlaywrightBrowserContext`

**Files:**

- Modify: `packages/webapp/src/kernel/realm/playwright-shim.ts:196-227` (insert `PlaywrightBrowserContext` class before `PlaywrightBrowser`; modify `PlaywrightBrowser`)
- Test: `packages/webapp/tests/kernel/realm/playwright-shim.test.ts`

**Interfaces:**

- Consumes: `PlaywrightPage` (Task 3 wraps pages the same way `PlaywrightBrowser.newPage` does today), the existing `createTab`/`setViewport`/`closeTab` ops.
- Produces:
  - `class PlaywrightBrowserContext { newPage(options?: PlaywrightNewPageOptions): Promise<PlaywrightPage>; pages(): PlaywrightPage[]; close(): Promise<void>; }`
  - `PlaywrightBrowser.newContext(options?: PlaywrightNewContextOptions): Promise<PlaywrightBrowserContext>`
  - `PlaywrightBrowser.contexts(): PlaywrightBrowserContext[]`
  - `PlaywrightBrowser.close()` now also closes every tracked context's pages.
  - Used by Task 5's integration test.

- [ ] **Step 1: Write the failing test**

Append to `packages/webapp/tests/kernel/realm/playwright-shim.test.ts`, right after the `createPlaywrightShim: page navigation + lifecycle` describe block content but this time as its own top-level describe placed after the `createPlaywrightShim: browser.newPage / browser.close` describe block (after line 115, before `createPlaywrightShim: page navigation + lifecycle` on line 117):

```ts
describe('createPlaywrightShim: browser.newContext', () => {
  it('newContext().newPage() opens a real tab', async () => {
    const rpc = mockRpc();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    expect(page).toBeDefined();
    expect(rpc.call).toHaveBeenCalledWith('browser', 'createTab', ['about:blank']);
  });

  it('context.pages() returns every page opened through that context', async () => {
    let n = 0;
    const rpc = mockRpc();
    rpc.call.mockImplementation(async (channel: string, op: string, args: unknown[] = []) => {
      rpc.calls.push({ channel, op, args });
      if (op === 'createTab') return `ctx-target-${++n}`;
      return undefined;
    });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const context = await browser.newContext();
    await context.newPage();
    await context.newPage();
    expect(context.pages()).toHaveLength(2);
  });

  it("context.close() closes only that context's tabs, leaving the browser's own pages open", async () => {
    let n = 0;
    const rpc = mockRpc();
    rpc.call.mockImplementation(async (channel: string, op: string, args: unknown[] = []) => {
      rpc.calls.push({ channel, op, args });
      if (op === 'createTab') return `target-${++n}`;
      return undefined;
    });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    await browser.newPage(); // target-1, owned directly by the browser
    const context = await browser.newContext();
    await context.newPage(); // target-2, owned by the context

    await context.close();

    expect(rpc.call).toHaveBeenCalledWith('browser', 'closeTab', ['target-2']);
    expect(rpc.call).not.toHaveBeenCalledWith('browser', 'closeTab', ['target-1']);
    expect(context.pages()).toHaveLength(0);
  });

  it("browser.close() also tears down every context's tabs", async () => {
    let n = 0;
    const rpc = mockRpc();
    rpc.call.mockImplementation(async (channel: string, op: string, args: unknown[] = []) => {
      rpc.calls.push({ channel, op, args });
      if (op === 'createTab') return `target-${++n}`;
      return undefined;
    });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const context = await browser.newContext();
    await context.newPage(); // target-1

    await browser.close();

    expect(rpc.call).toHaveBeenCalledWith('browser', 'closeTab', ['target-1']);
  });

  it('browser.contexts() returns every context created via newContext()', async () => {
    const rpc = mockRpc();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const c1 = await browser.newContext();
    const c2 = await browser.newContext();
    expect(browser.contexts()).toEqual([c1, c2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/kernel/realm/playwright-shim.test.ts -t "newContext"`
Expected: FAIL with `browser.newContext is not a function`

- [ ] **Step 3: Write minimal implementation**

In `packages/webapp/src/kernel/realm/playwright-shim.ts`, add a new options interface next to `PlaywrightNewPageOptions` (currently lines 40-43):

```ts
export interface PlaywrightNewPageOptions {
  viewport?: ViewportSize;
  [key: string]: unknown;
}

export interface PlaywrightNewContextOptions {
  viewport?: ViewportSize;
  [key: string]: unknown;
}
```

Currently, lines 196-227 read:

```ts
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
    return new PlaywrightPage(this.rpc, targetId);
  }

  async close(): Promise<void> {
    const targetIds = this.pageTargetIds.splice(0, this.pageTargetIds.length);
    for (const targetId of targetIds) {
      await this.rpc.call('browser', 'closeTab', [targetId]);
    }
  }
}
```

Replace that whole block with:

```ts
/**
 * Wraps Playwright's `BrowserContext` shape, but grouping-only: it tracks
 * its own pages so `close()`/`pages()` bookkeeping is scoped to just this
 * context. SLICC has exactly one real Chrome profile — there is NO cookie
 * jar / storage isolation between contexts (see docs/node-compat-shims.md).
 * Scripts that rely on real per-context isolation will not get it here.
 */
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
    const page = new PlaywrightPage(this.rpc, targetId);
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

/**
 * Wraps a "browser" — in reality just a bookkeeping set of tabs (and
 * contexts, which are themselves just bookkeeping sets of tabs) opened
 * through this launch() call, so `close()` knows which real tabs to tear
 * down. There's no separate browser process to spawn or attach to; the
 * host already owns the one real Chrome instance.
 */
export class PlaywrightBrowser {
  private readonly pageTargetIds: string[] = [];
  private readonly openContexts: PlaywrightBrowserContext[] = [];

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
    return new PlaywrightPage(this.rpc, targetId);
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
    const targetIds = this.pageTargetIds.splice(0, this.pageTargetIds.length);
    for (const targetId of targetIds) {
      await this.rpc.call('browser', 'closeTab', [targetId]);
    }
    const contexts = this.openContexts.splice(0, this.openContexts.length);
    for (const context of contexts) {
      await context.close();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/webapp/tests/kernel/realm/playwright-shim.test.ts -t "newContext"`
Expected: PASS

Also re-run the full unit test file to confirm no regressions from the `PlaywrightBrowser` edit:

Run: `npx vitest run packages/webapp/tests/kernel/realm/playwright-shim.test.ts`
Expected: PASS (all tests, including the pre-existing `browser.newPage / browser.close` describe block)

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/kernel/realm/playwright-shim.ts packages/webapp/tests/kernel/realm/playwright-shim.test.ts
git commit -m "feat(realm): add browser.newContext (grouping-only) to playwright shim"
```

---

### Task 4: `chromium.connectOverCDP` / `<launcher>.connect`

**Files:**

- Modify: `packages/webapp/src/kernel/realm/playwright-shim.ts:229-251`
- Test: `packages/webapp/tests/kernel/realm/playwright-shim.test.ts`

**Interfaces:**

- Consumes: `PlaywrightBrowser` (Task 3/existing), nothing new.
- Produces:
  - `PlaywrightShim.chromium.connect(wsEndpoint: string, options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser>`
  - `PlaywrightShim.chromium.connectOverCDP(endpoint: string, options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser>`
  - `PlaywrightShim.firefox.connect(...)`, `PlaywrightShim.webkit.connect(...)` (same signature as chromium's `connect`)
  - Used by Task 5's integration test.

- [ ] **Step 1: Write the failing test**

Append to `packages/webapp/tests/kernel/realm/playwright-shim.test.ts`, at the very end of the file (after the closing of the `createPlaywrightShim: ElementHandle` describe block, i.e. after the current last line 379):

```ts
describe('createPlaywrightShim: connectOverCDP / connect', () => {
  it('chromium.connectOverCDP() returns a working Browser regardless of the endpoint value', async () => {
    const rpc = mockRpc();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    expect(typeof browser.newPage).toBe('function');
    const page = await browser.newPage();
    expect(page).toBeDefined();
  });

  it('chromium.connect() / firefox.connect() / webkit.connect() all return working Browsers', async () => {
    const rpc = mockRpc();
    const { chromium, firefox, webkit } = createPlaywrightShim(rpc);
    const b1 = await chromium.connect('ws://localhost:1234/devtools/browser/abc');
    const b2 = await firefox.connect('ws://localhost:1234/devtools/browser/abc');
    const b3 = await webkit.connect('ws://localhost:1234/devtools/browser/abc');
    expect(typeof b1.newPage).toBe('function');
    expect(typeof b2.newPage).toBe('function');
    expect(typeof b3.newPage).toBe('function');
  });

  it('connectOverCDP/connect are no-ops that make no rpc calls themselves', async () => {
    const rpc = mockRpc();
    const { chromium } = createPlaywrightShim(rpc);
    await chromium.connectOverCDP('http://localhost:9222');
    expect(rpc.call).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/kernel/realm/playwright-shim.test.ts -t "connectOverCDP"`
Expected: FAIL with `chromium.connectOverCDP is not a function`

- [ ] **Step 3: Write minimal implementation**

In `packages/webapp/src/kernel/realm/playwright-shim.ts`, lines 229-251 currently read:

```ts
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
```

Replace that whole block with:

```ts
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

/**
 * Builds the `{ chromium, firefox, webkit }` module shape realm scripts get
 * back from `require('playwright')` / `import('playwright')`. `launch()` is
 * a no-op spawn — SLICC's Chrome is already running — it just hands back a
 * fresh `PlaywrightBrowser` bookkeeping wrapper over `rpc`. All three
 * launchers are identical (see module doc comment).
 *
 * `connect`/`connectOverCDP` accept an endpoint argument for API-shape
 * compatibility with real Playwright call sites, but ignore it: the realm
 * is always already attached to SLICC's one real Chrome instance, so there
 * is nothing else to dial. Both behave identically to `launch()`.
 */
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/webapp/tests/kernel/realm/playwright-shim.test.ts -t "connectOverCDP"`
Expected: PASS

Also re-run the full unit test file:

Run: `npx vitest run packages/webapp/tests/kernel/realm/playwright-shim.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/kernel/realm/playwright-shim.ts packages/webapp/tests/kernel/realm/playwright-shim.test.ts
git commit -m "feat(realm): add connectOverCDP/connect to playwright shim"
```

---

### Task 5: Integration tests for all four additions

**Files:**

- Modify: `packages/webapp/tests/kernel/realm/playwright-shim-integration.test.ts`

**Interfaces:**

- Consumes: `PlaywrightPage.waitForTimeout`, `PlaywrightPage.$$eval`, `PlaywrightBrowser.newContext`/`.contexts()`, `PlaywrightBrowserContext.newPage`/`.pages()`/`.close()`, `chromium.connectOverCDP`, `<launcher>.connect` — all from Tasks 1-4.
- Produces: nothing new; this task only adds test coverage.

- [ ] **Step 1: Write the failing tests**

The shared `createIntegrationMockRpc()` helper's `evalAsync` branch (lines 62-110 of `packages/webapp/tests/kernel/realm/playwright-shim-integration.test.ts`) currently reads:

```ts
      if (op === 'evalAsync') {
        // evalAsync([targetId, code])
        const code = args[1] as string;

        // Check what the code is trying to do
        if (code.includes('document.documentElement.outerHTML')) {
          // page.content()
          return '<html><body><button class="nav-btn">Menu</button></body></html>';
        }

        if (code.includes('!!document.querySelector')) {
          // page.$ check for existence
          if (code.includes('.nav-btn')) return true;
          return false;
        }

        if (code.includes('document.querySelectorAll')) {
          // Count for page.$$
          if (code.includes('.length')) {
            if (code.includes('.nav-btn')) return 1;
            if (code.includes('li')) return 3;
            return 0;
          }
        }
```

Insert a new branch for `$$eval`-shaped code **before** the generic `document.querySelectorAll` branch above (since `$$eval`'s generated code also contains both `document.querySelectorAll` and, incidentally, `.length` inside the user function body — it must be matched first via its distinguishing `Array.from(document.querySelectorAll` shape):

```ts
      if (op === 'evalAsync') {
        // evalAsync([targetId, code])
        const code = args[1] as string;

        // Check what the code is trying to do
        if (code.includes('document.documentElement.outerHTML')) {
          // page.content()
          return '<html><body><button class="nav-btn">Menu</button></body></html>';
        }

        if (code.includes('Array.from(document.querySelectorAll')) {
          // page.$$eval() — simulate counting the matched elements
          if (code.includes('"li"')) return 3;
          return 0;
        }

        if (code.includes('!!document.querySelector')) {
          // page.$ check for existence
          if (code.includes('.nav-btn')) return true;
          return false;
        }

        if (code.includes('document.querySelectorAll')) {
          // Count for page.$$
          if (code.includes('.length')) {
            if (code.includes('.nav-btn')) return 1;
            if (code.includes('li')) return 3;
            return 0;
          }
        }
```

Then append four new `it` blocks inside the `describe('playwright shim integration', ...)` block, after the last existing test (`'maintains element handle isolation across queries'`, currently ending at line 383, just before the describe block's closing `});` at line 384):

```ts
it('waits for a fixed timeout without making any rpc calls', async () => {
  vi.useFakeTimers();
  try {
    const rpc = createIntegrationMockRpc();
    const { chromium } = createPlaywrightShim(rpc);

    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('https://example.com');

    rpc.call.mockClear();
    let resolved = false;
    const promise = page.waitForTimeout(200).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(200);
    await promise;

    expect(resolved).toBe(true);
    expect(rpc.call).not.toHaveBeenCalled();

    await browser.close();
  } finally {
    vi.useRealTimers();
  }
});

it('evaluates a reducer function over every matched element via $$eval', async () => {
  const rpc = createIntegrationMockRpc();
  const { chromium } = createPlaywrightShim(rpc);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://example.com');

  const count = await page.$$eval('li', (elements) => elements.length);
  expect(count).toBe(3);

  await browser.close();
});

it("isolates tabs opened through a context from the browser's own tabs", async () => {
  const rpc = createIntegrationMockRpc();
  const { chromium } = createPlaywrightShim(rpc);

  const browser = await chromium.launch();
  const directPage = await browser.newPage();
  await directPage.goto('https://example.com');

  const context = await browser.newContext();
  const contextPage1 = await context.newPage();
  const contextPage2 = await context.newPage();
  await contextPage1.goto('https://example.com/one');
  await contextPage2.goto('https://example.com/two');

  expect(context.pages()).toHaveLength(2);
  expect(browser.contexts()).toEqual([context]);

  await context.close();
  expect(context.pages()).toHaveLength(0);

  // The browser's own directly-opened page is unaffected by context.close().
  const html = await directPage.content();
  expect(html).toContain('nav-btn');

  await browser.close();
});

it('connectOverCDP returns a Browser that drives the same real Chrome instance', async () => {
  const rpc = createIntegrationMockRpc();
  const { chromium } = createPlaywrightShim(rpc);

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const page = await browser.newPage();
  await page.goto('https://example.com');
  const html = await page.content();

  expect(html).toBe('<html><body><button class="nav-btn">Menu</button></body></html>');

  await browser.close();
});
```

- [ ] **Step 2: Run tests to verify they pass**

This task runs after Tasks 1-4, so the shim implementation already exists — these tests exercise realistic end-to-end flows rather than drive new implementation.

Run: `npx vitest run packages/webapp/tests/kernel/realm/playwright-shim-integration.test.ts`
Expected: PASS (all tests, including the 4 new ones and all pre-existing ones)

- [ ] **Step 3: Commit**

```bash
git add packages/webapp/tests/kernel/realm/playwright-shim-integration.test.ts
git commit -m "test(realm): add integration coverage for playwright shim feature additions"
```

---

### Task 6: Update documentation

**Files:**

- Modify: `docs/node-compat-shims.md:182-197`
- Modify: `packages/webapp/src/kernel/realm/playwright-shim.ts:1-19` (module doc comment)

**Interfaces:**

- Consumes: nothing (docs only).
- Produces: nothing (docs only).

- [ ] **Step 1: Update `docs/node-compat-shims.md`**

Lines 182-197 currently read:

```markdown
**Supported surface:**

- `chromium.launch()` — returns a Browser (no-op; Chrome is already running)
- `browser.newPage({ viewport? })` — opens a real new tab, sets viewport
- `browser.close()` — closes all tabs opened by the instance
- `page.goto(url)`, `page.waitForLoadState(state?)`
- `page.evaluate(fn, ...args)` — runs JS in page context
- `page.screenshot({ path?, fullPage? })` — returns Uint8Array (PNG)
- `page.$(selector)`, `page.$$(selector)` — query selectors → ElementHandle
- `page.content()` — returns page HTML
- `page.setViewportSize({ width, height })`
- `page.close()`
- `elementHandle.textContent()`, `.getAttribute(name)`, `.isVisible()`, `.boundingBox()`

**Not supported:** BrowserContext, request interception, locators, tracing,
video, firefox/webkit engines (all three launchers use the same Chrome).
```

Replace with:

```markdown
**Supported surface:**

- `chromium.launch()` — returns a Browser (no-op; Chrome is already running)
- `chromium.connectOverCDP(endpoint)`, `<launcher>.connect(wsEndpoint)` — also
  no-ops that return a Browser; the endpoint argument is accepted but ignored
  (the realm is always already attached to SLICC's one real Chrome)
- `browser.newPage({ viewport? })` — opens a real new tab, sets viewport
- `browser.newContext(options?)` — returns a `BrowserContext` that groups its
  own pages for `close()`/`pages()` bookkeeping. **No cookie/storage isolation**
  — every context and the top-level browser share the one real Chrome profile.
- `browser.contexts()`, `context.newPage()`, `context.pages()`, `context.close()`
- `browser.close()` — closes all tabs opened by the instance, including every
  context's tabs
- `page.goto(url)`, `page.waitForLoadState(state?)`, `page.waitForTimeout(ms)`
- `page.evaluate(fn, ...args)` — runs JS in page context
- `page.screenshot({ path?, fullPage? })` — returns Uint8Array (PNG)
- `page.$(selector)`, `page.$$(selector)` — query selectors → ElementHandle
- `page.$$eval(selector, fn, ...args)` — runs `fn` over every matched element
- `page.content()` — returns page HTML
- `page.setViewportSize({ width, height })`
- `page.close()`
- `elementHandle.textContent()`, `.getAttribute(name)`, `.isVisible()`, `.boundingBox()`

**Not supported:** request interception, locators, tracing, video, distinct
firefox/webkit engines (all three launchers use the same Chrome), real
per-context cookie/storage isolation for `BrowserContext`.
```

- [ ] **Step 2: Update the module doc comment in `packages/webapp/src/kernel/realm/playwright-shim.ts`**

Lines 1-19 currently read:

```ts
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
```

Replace with:

```ts
/**
 * `playwright-shim.ts` — a Playwright-shaped API backed by SLICC's existing
 * CDP connection (`BrowserAPI`) rather than a bundled Playwright/browser
 * binary. `createPlaywrightShim(rpc)` is wired into the realm module
 * resolver (see `js-realm-shared.ts`'s `SHIMMED_PACKAGES`) so
 * `require('playwright')` / `import('playwright')` resolves inside realm
 * scripts to `{ chromium, firefox, webkit }` — all three launchers drive the
 * SAME already-running Chrome instance (SLICC never spawns a second
 * browser), so there is no meaningful behavioral difference between them
 * here. `connectOverCDP`/`connect` are likewise no-ops for the same reason —
 * there is no other CDP endpoint to dial.
 *
 * Every method is a thin translation to one `rpc.call('browser', op, args)`
 * against the host ops added in `realm-host.ts`'s `dispatchBrowser`
 * (`createTab` / `closeTab` / `setViewport` / `navigateTab` /
 * `screenshotTab` / `waitForLoadState`, plus the pre-existing `eval` /
 * `evalAsync`), or in the case of `waitForTimeout`, a pure client-side
 * `setTimeout` with no host round trip at all. `browser.newContext()`
 * provides grouping only, not real per-context cookie/storage isolation —
 * see `docs/node-compat-shims.md` for the full supported/unsupported
 * surface.
 */
```

- [ ] **Step 3: Commit**

```bash
git add docs/node-compat-shims.md packages/webapp/src/kernel/realm/playwright-shim.ts
git commit -m "docs(realm): document playwright shim feature additions"
```

---

## Final Verification

- [ ] **Run the full webapp test suite**

Run: `npm run test -w @slicc/webapp`
Expected: PASS

- [ ] **Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no new errors)

- [ ] **Run lint**

Run: `npm run lint`
Expected: PASS (no new errors)
