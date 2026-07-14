/**
 * Unit tests for `playwright-shim.ts` — verifies `createPlaywrightShim(rpc)`
 * translates each Playwright-shaped call into the right `rpc.call('browser', op, args)`
 * (and `rpc.call('vfs', 'writeFileBinary', ...)` for screenshot-to-path) without
 * needing a real realm/host round trip. Host-side op behavior is covered by
 * `playwright-host-ops.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PlaywrightShimRpc } from '../../../src/kernel/realm/playwright-shim.js';
import { createPlaywrightShim } from '../../../src/kernel/realm/playwright-shim.js';

interface MockRpc extends PlaywrightShimRpc {
  call: ReturnType<typeof vi.fn<PlaywrightShimRpc['call']>>;
  calls: Array<{ channel: string; op: string; args: unknown[] }>;
}

function mockRpc(overrides: Record<string, unknown> = {}): MockRpc {
  const calls: Array<{ channel: string; op: string; args: unknown[] }> = [];
  const call = vi.fn(async (channel: string, op: string, args: unknown[] = []) => {
    calls.push({ channel, op, args });
    if (op in overrides) return overrides[op];
    switch (op) {
      case 'createTab':
        return 'target-abc';
      case 'screenshotTab':
        return 'iVBORw0KGgo=';
      case 'eval':
      case 'evalAsync':
        return null;
      default:
        return undefined;
    }
  });
  return { call, calls };
}

describe('createPlaywrightShim: chromium/firefox/webkit.launch', () => {
  it('chromium.launch() returns a Browser-shaped object', async () => {
    const rpc = mockRpc();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    expect(browser).toBeDefined();
    expect(typeof browser.newPage).toBe('function');
    expect(typeof browser.close).toBe('function');
  });

  it('firefox.launch() and webkit.launch() also return Browser-shaped objects backed by the same Chrome', async () => {
    const rpc = mockRpc();
    const { firefox, webkit } = createPlaywrightShim(rpc);
    const b1 = await firefox.launch();
    const b2 = await webkit.launch();
    expect(typeof b1.newPage).toBe('function');
    expect(typeof b2.newPage).toBe('function');
  });
});

describe('createPlaywrightShim: browser.newPage / browser.close', () => {
  it('newPage() calls createTab with about:blank when no url given', async () => {
    const rpc = mockRpc();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    expect(page).toBeDefined();
    expect(rpc.call).toHaveBeenCalledWith('browser', 'createTab', ['about:blank']);
  });

  it('newPage({ viewport }) also calls setViewport with the new tab id', async () => {
    const rpc = mockRpc();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    await browser.newPage({ viewport: { width: 360, height: 640 } });
    expect(rpc.call).toHaveBeenCalledWith('browser', 'setViewport', ['target-abc', 360, 640]);
  });

  it('newPage() without viewport does not call setViewport', async () => {
    const rpc = mockRpc();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    await browser.newPage();
    expect(rpc.call).not.toHaveBeenCalledWith('browser', 'setViewport', expect.anything());
  });

  it('close() closes every tab opened by this Browser instance', async () => {
    const rpc = mockRpc();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    await browser.newPage();
    await browser.close();
    expect(rpc.call).toHaveBeenCalledWith('browser', 'closeTab', ['target-abc']);
  });

  it('close() closes multiple distinct tabs and clears the tracked set', async () => {
    let n = 0;
    const rpc = mockRpc();
    rpc.call.mockImplementation(async (channel: string, op: string, args: unknown[] = []) => {
      rpc.calls.push({ channel, op, args });
      if (op === 'createTab') return `target-${++n}`;
      return undefined;
    });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    await browser.newPage();
    await browser.newPage();
    await browser.close();
    expect(rpc.call).toHaveBeenCalledWith('browser', 'closeTab', ['target-1']);
    expect(rpc.call).toHaveBeenCalledWith('browser', 'closeTab', ['target-2']);

    // A second close() is a no-op — the tracked page list was cleared.
    const closeCallsBefore = rpc.calls.filter((c) => c.op === 'closeTab').length;
    await browser.close();
    const closeCallsAfter = rpc.calls.filter((c) => c.op === 'closeTab').length;
    expect(closeCallsAfter).toBe(closeCallsBefore);
  });

  it('browser.close() does not re-close a page already closed individually', async () => {
    // Mirrors real Chrome: `Target.closeTarget` on an already-closed target
    // rejects. If `browser.close()` still re-issued `closeTab` for a page
    // that called `page.close()` itself, this mock would reject too.
    const closedTargets = new Set<string>();
    let n = 0;
    const rpc = mockRpc();
    rpc.call.mockImplementation(async (channel: string, op: string, args: unknown[] = []) => {
      rpc.calls.push({ channel, op, args });
      if (op === 'createTab') return `target-${++n}`;
      if (op === 'closeTab') {
        const targetId = args[0] as string;
        if (closedTargets.has(targetId)) {
          throw new Error(`No target with given id found: ${targetId}`);
        }
        closedTargets.add(targetId);
        return undefined;
      }
      return undefined;
    });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page1 = await browser.newPage();
    await browser.newPage();
    await page1.close();
    await expect(browser.close()).resolves.toBeUndefined();
    const closeCalls = rpc.calls.filter((c) => c.op === 'closeTab').map((c) => c.args[0]);
    expect(closeCalls).toEqual(['target-1', 'target-2']);
  });
});

describe('createPlaywrightShim: page navigation + lifecycle', () => {
  it('page.goto() calls navigateTab with the tab id and url', async () => {
    const rpc = mockRpc();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('https://example.com');
    expect(rpc.call).toHaveBeenCalledWith('browser', 'navigateTab', [
      'target-abc',
      'https://example.com',
    ]);
  });

  it('page.waitForLoadState() defaults to "load"', async () => {
    const rpc = mockRpc();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.waitForLoadState();
    expect(rpc.call).toHaveBeenCalledWith('browser', 'waitForLoadState', ['target-abc', 'load']);
  });

  it('page.waitForLoadState("networkidle") forwards the requested state', async () => {
    const rpc = mockRpc();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.waitForLoadState('networkidle');
    expect(rpc.call).toHaveBeenCalledWith('browser', 'waitForLoadState', [
      'target-abc',
      'networkidle',
    ]);
  });

  it('page.setViewportSize() calls setViewport', async () => {
    const rpc = mockRpc();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1024, height: 768 });
    expect(rpc.call).toHaveBeenCalledWith('browser', 'setViewport', ['target-abc', 1024, 768]);
  });

  it('page.close() calls closeTab for just that page', async () => {
    const rpc = mockRpc();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.close();
    expect(rpc.call).toHaveBeenCalledWith('browser', 'closeTab', ['target-abc']);
  });
});

describe('createPlaywrightShim: page.evaluate', () => {
  it('serializes a function + args into an evalAsync IIFE call', async () => {
    const rpc = mockRpc({ evalAsync: 'The Title' });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const result = await page.evaluate(
      (...args: unknown[]) => document.title + (args[0] as string),
      '!'
    );
    expect(result).toBe('The Title');
    const call = rpc.calls.find((c) => c.op === 'evalAsync');
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe('target-abc');
    expect(typeof call!.args[1]).toBe('string');
    expect(call!.args[1] as string).toContain('document.title');
    expect(call!.args[1] as string).toContain('.apply(null, JSON.parse(');
    const document = { title: 'The Title' };
    // biome-ignore lint/security/noGlobalEval: verifying the generated code actually round-trips args correctly
    expect(eval(call!.args[1] as string)).toBe('The Title!');
  });

  it('passes a raw string straight through as the eval code', async () => {
    const rpc = mockRpc({ evalAsync: 42 });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const result = await page.evaluate('1 + 41');
    expect(result).toBe(42);
    expect(rpc.call).toHaveBeenCalledWith('browser', 'evalAsync', ['target-abc', '1 + 41']);
  });
});

describe('createPlaywrightShim: page.screenshot', () => {
  it('decodes the base64 PNG into a Uint8Array', async () => {
    const rpc = mockRpc({ screenshotTab: 'iVBORw0KGgo=' });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const buf = await page.screenshot();
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.length).toBeGreaterThan(0);
    expect(rpc.call).toHaveBeenCalledWith('browser', 'screenshotTab', ['target-abc', {}]);
  });

  it('forwards fullPage to screenshotTab', async () => {
    const rpc = mockRpc({ screenshotTab: 'iVBORw0KGgo=' });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.screenshot({ fullPage: true });
    expect(rpc.call).toHaveBeenCalledWith('browser', 'screenshotTab', [
      'target-abc',
      { fullPage: true },
    ]);
  });

  it('writes to VFS when a path option is given', async () => {
    const rpc = mockRpc({ screenshotTab: 'iVBORw0KGgo=' });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const buf = await page.screenshot({ path: '/tmp/out.png' });
    expect(rpc.call).toHaveBeenCalledWith('vfs', 'writeFileBinary', [
      '/tmp/out.png',
      expect.any(Uint8Array),
    ]);
    expect(buf).toBeInstanceOf(Uint8Array);
  });

  it('does not touch VFS when no path option is given', async () => {
    const rpc = mockRpc({ screenshotTab: 'iVBORw0KGgo=' });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.screenshot();
    expect(rpc.call).not.toHaveBeenCalledWith('vfs', expect.anything(), expect.anything());
  });
});

describe('createPlaywrightShim: page.content', () => {
  it('returns the document outerHTML via evalAsync', async () => {
    const rpc = mockRpc({ evalAsync: '<html><body>hi</body></html>' });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const html = await page.content();
    expect(html).toBe('<html><body>hi</body></html>');
    const call = rpc.calls.find((c) => c.op === 'evalAsync');
    expect(call!.args[1] as string).toContain('outerHTML');
  });
});

describe('createPlaywrightShim: page.$ / page.$$', () => {
  it('page.$ returns null when the selector matches nothing', async () => {
    const rpc = mockRpc({ evalAsync: false });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const el = await page.$('.missing');
    expect(el).toBeNull();
  });

  it('page.$ returns an ElementHandle when the selector matches', async () => {
    const rpc = mockRpc({ evalAsync: true });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const el = await page.$('button.primary');
    expect(el).not.toBeNull();
    expect(typeof el!.textContent).toBe('function');
  });

  it('page.$$ returns one ElementHandle per matched element', async () => {
    const rpc = mockRpc({ evalAsync: 3 });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const els = await page.$$('li');
    expect(els).toHaveLength(3);
  });

  it('page.$$ returns an empty array when nothing matches', async () => {
    const rpc = mockRpc({ evalAsync: 0 });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const els = await page.$$('li');
    expect(els).toEqual([]);
  });
});

describe('createPlaywrightShim: ElementHandle', () => {
  function makeElement() {
    const rpc = mockRpc();
    rpc.call.mockImplementation(async (channel: string, op: string, args: unknown[] = []) => {
      rpc.calls.push({ channel, op, args });
      if (op === 'createTab') return 'target-abc';
      if (op === 'evalAsync') {
        const code = args[1] as string;
        if (code.includes('!!document.querySelector')) return true;
        if (code.includes('.textContent')) return 'Hello';
        if (code.includes('.getAttribute(')) return 'primary';
        if (code.includes('getComputedStyle')) return true;
        if (code.includes('getBoundingClientRect')) return { x: 10, y: 20, width: 100, height: 50 };
      }
      return undefined;
    });
    return rpc;
  }

  it('textContent() evaluates against the captured selector/index', async () => {
    const rpc = makeElement();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const el = await page.$('button');
    expect(await el!.textContent()).toBe('Hello');
  });

  it('getAttribute(name) evaluates against the captured selector/index', async () => {
    const rpc = makeElement();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const el = await page.$('button');
    expect(await el!.getAttribute('class')).toBe('primary');
  });

  it('isVisible() evaluates computed style + bounding rect', async () => {
    const rpc = makeElement();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const el = await page.$('button');
    expect(await el!.isVisible()).toBe(true);
  });

  it('boundingBox() returns the evaluated rect', async () => {
    const rpc = makeElement();
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const el = await page.$('button');
    expect(await el!.boundingBox()).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it('$$ handles each embed a distinct element index in their generated code', async () => {
    const rpc = mockRpc();
    rpc.call.mockImplementation(async (channel: string, op: string, args: unknown[] = []) => {
      rpc.calls.push({ channel, op, args });
      if (op === 'createTab') return 'target-abc';
      if (op === 'evalAsync') {
        const code = args[1] as string;
        if (code.includes('.length')) return 2;
      }
      return undefined;
    });
    const { chromium } = createPlaywrightShim(rpc);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const els = await page.$$('li');
    expect(els).toHaveLength(2);

    rpc.calls.length = 0;
    await els[0].textContent();
    await els[1].textContent();
    const codes = rpc.calls.filter((c) => c.op === 'evalAsync').map((c) => c.args[1] as string);
    expect(codes).toHaveLength(2);
    expect(codes[0]).toContain('els[0]');
    expect(codes[1]).toContain('els[1]');
  });
});
