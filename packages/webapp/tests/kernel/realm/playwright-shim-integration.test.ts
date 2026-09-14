import { describe, expect, it, vi } from 'vitest';
import type { PlaywrightShimRpc } from '../../../src/kernel/realm/playwright-shim.js';
import { createPlaywrightShim } from '../../../src/kernel/realm/playwright-shim.js';

interface MockRpc extends PlaywrightShimRpc {
  call: ReturnType<typeof vi.fn<PlaywrightShimRpc['call']>>;
}

function createIntegrationMockRpc(): MockRpc {
  let nextTabId = 0;
  const tabIds = new Set<string>();

  const call = vi.fn(async (channel: string, op: string, args: unknown[] = []) => {
    if (channel === 'browser') {
      if (op === 'createTab') {
        const tabId = `tab-${++nextTabId}`;
        tabIds.add(tabId);
        return tabId;
      }

      if (op === 'closeTab') {
        const tabId = args[0] as string;
        tabIds.delete(tabId);
        return undefined;
      }

      if (op === 'navigateTab') {
        return undefined;
      }

      if (op === 'waitForLoadState') {
        return undefined;
      }

      if (op === 'setViewport') {
        return undefined;
      }

      if (op === 'screenshotTab') {
        return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      }

      if (op === 'evalAsync') {
        const code = args[1] as string;

        if (code.includes('document.documentElement.outerHTML')) {
          return '<html><body><button class="nav-btn">Menu</button></body></html>';
        }

        if (code.includes('!!document.querySelector')) {
          if (code.includes('.nav-btn')) return true;
          return false;
        }

        if (code.includes('Array.from(document.querySelectorAll')) {
          if (code.includes('"li"')) return 3;
          return 0;
        }

        if (code.includes('document.querySelectorAll')) {
          if (code.includes('.length')) {
            if (code.includes('.nav-btn')) return 1;
            if (code.includes('li')) return 3;
            return 0;
          }
        }

        if (code.includes('.textContent')) {
          return 'Menu';
        }

        if (code.includes('.getAttribute(')) {
          if (code.includes('"class"')) return 'nav-btn';
          if (code.includes('"data-mobile"')) return 'true';
          return null;
        }

        if (code.includes('getComputedStyle')) {
          return true;
        }

        if (code.includes('getBoundingClientRect')) {
          return { x: 10, y: 20, width: 100, height: 50 };
        }

        return null;
      }
    }

    if (channel === 'vfs') {
      if (op === 'writeFileBinary') {
        return undefined;
      }
    }

    return undefined;
  });

  return { call };
}

describe('playwright shim integration', () => {
  it('simulates the mobile-nav-audit.mjs pattern end-to-end', async () => {
    const rpc = createIntegrationMockRpc();
    const { chromium } = createPlaywrightShim(rpc);

    const browser = await chromium.launch({ headless: true });
    expect(browser).toBeDefined();

    const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
    expect(page).toBeDefined();

    expect(rpc.call).toHaveBeenCalledWith('browser', 'createTab', ['about:blank']);

    expect(rpc.call).toHaveBeenCalledWith('browser', 'setViewport', [expect.any(String), 360, 640]);

    await page.goto('file:///tmp/test.html');
    expect(rpc.call).toHaveBeenCalledWith('browser', 'navigateTab', [
      expect.any(String),
      'file:///tmp/test.html',
    ]);

    await page.waitForLoadState('networkidle');
    expect(rpc.call).toHaveBeenCalledWith('browser', 'waitForLoadState', [
      expect.any(String),
      'networkidle',
    ]);

    const html = await page.content();
    expect(html).toBe('<html><body><button class="nav-btn">Menu</button></body></html>');

    const buf = await page.screenshot({ path: '/tmp/shot.png' });
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.length).toBeGreaterThan(0);
    expect(rpc.call).toHaveBeenCalledWith('vfs', 'writeFileBinary', [
      '/tmp/shot.png',
      expect.any(Uint8Array),
    ]);

    await page.close();
    expect(rpc.call).toHaveBeenCalledWith('browser', 'closeTab', [expect.any(String)]);

    await browser.close();
  });

  it('exercises element query and manipulation patterns', async () => {
    const rpc = createIntegrationMockRpc();
    const { chromium } = createPlaywrightShim(rpc);

    const browser = await chromium.launch();
    const page = await browser.newPage();

    await page.goto('https://example.com');

    const navBtn = await page.$('.nav-btn');
    expect(navBtn).not.toBeNull();

    const text = await navBtn!.textContent();
    expect(text).toBe('Menu');

    const classAttr = await navBtn!.getAttribute('class');
    expect(classAttr).toBe('nav-btn');

    const mobileAttr = await navBtn!.getAttribute('data-mobile');
    expect(mobileAttr).toBe('true');

    const isVisible = await navBtn!.isVisible();
    expect(isVisible).toBe(true);

    const bbox = await navBtn!.boundingBox();
    expect(bbox).toEqual({ x: 10, y: 20, width: 100, height: 50 });

    const listItems = await page.$$('li');
    expect(listItems).toHaveLength(3);

    for (let i = 0; i < listItems.length; i++) {
      const text = await listItems[i].textContent();
      expect(text).toBe('Menu');
    }

    await browser.close();
  });

  it('handles full-page screenshots with path writing', async () => {
    const rpc = createIntegrationMockRpc();
    const { chromium } = createPlaywrightShim(rpc);

    const browser = await chromium.launch();
    const page = await browser.newPage();

    await page.goto('https://example.com');

    const screenshotPath = '/tmp/full-page.png';
    const buf = await page.screenshot({ fullPage: true, path: screenshotPath });

    expect(rpc.call).toHaveBeenCalledWith('vfs', 'writeFileBinary', [
      screenshotPath,
      expect.any(Uint8Array),
    ]);

    expect(rpc.call).toHaveBeenCalledWith('browser', 'screenshotTab', [
      expect.any(String),
      { fullPage: true },
    ]);

    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.length).toBeGreaterThan(0);

    await browser.close();
  });

  it('handles multiple pages in a single browser instance', async () => {
    const rpc = createIntegrationMockRpc();
    const { chromium } = createPlaywrightShim(rpc);

    const browser = await chromium.launch();

    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    const page3 = await browser.newPage();

    expect(rpc.call).toHaveBeenCalledWith('browser', 'createTab', ['about:blank']);

    await page1.goto('https://example1.com');
    await page2.goto('https://example2.com');
    await page3.goto('https://example3.com');

    await page1.close();
    await page2.close();

    await browser.close();

    const closeCalls = (
      rpc.call.mock.calls as Array<[string, string, unknown[] | undefined]>
    ).filter((c) => c[1] === 'closeTab');
    expect(closeCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('works with firefox and webkit launchers (all backed by same chrome)', async () => {
    const rpc = createIntegrationMockRpc();
    const { firefox, webkit } = createPlaywrightShim(rpc);

    const browser1 = await firefox.launch();
    const browser2 = await webkit.launch();

    const page1 = await browser1.newPage();
    const page2 = await browser2.newPage();

    await page1.goto('https://example.com');
    await page2.goto('https://example.com');

    const html1 = await page1.content();
    const html2 = await page2.content();

    expect(html1).toBe(html2);

    await browser1.close();
    await browser2.close();
  });

  it('handles evaluate with both function and string code', async () => {
    const rpc = createIntegrationMockRpc();
    const { chromium } = createPlaywrightShim(rpc);

    const browser = await chromium.launch();
    const page = await browser.newPage();

    await page.goto('https://example.com');

    const stringResult = await page.evaluate('1 + 41');
    expect(stringResult).toBeDefined();

    const funcResult = await page.evaluate(() => {
      return 'test result';
    });
    expect(funcResult).toBeDefined();

    const argsResult = await page.evaluate(
      (...args: unknown[]) => (args[0] as number) + (args[1] as number),
      10,
      20
    );
    expect(argsResult).toBeDefined();

    await browser.close();
  });

  it('handles missing elements gracefully', async () => {
    const rpc = createIntegrationMockRpc();
    const { chromium } = createPlaywrightShim(rpc);

    const browser = await chromium.launch();
    const page = await browser.newPage();

    await page.goto('https://example.com');

    const missing = await page.$('.nonexistent-class');
    expect(missing).toBeNull();

    const items = await page.$$('.also-nonexistent');
    expect(items).toEqual([]);

    await browser.close();
  });

  it('maintains element handle isolation across queries', async () => {
    const rpc = createIntegrationMockRpc();
    const { chromium } = createPlaywrightShim(rpc);

    const browser = await chromium.launch();
    const page = await browser.newPage();

    await page.goto('https://example.com');

    const buttons = await page.$$('.nav-btn');
    expect(buttons).toHaveLength(1);

    const text1 = await buttons[0].textContent();
    expect(text1).toBe('Menu');

    await browser.close();
  });

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

    const count = await page.$$eval('.nav-btn', (elements) => elements.length);
    expect(count).toBe(0);

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

    const calls = rpc.call.mock.calls as Array<[string, string, unknown[]]>;
    const directPageTargetId = calls.find(
      (c) => c[1] === 'navigateTab' && c[2][1] === 'https://example.com'
    )?.[2][0];
    expect(directPageTargetId).toBeDefined();

    await context.close();
    expect(context.pages()).toHaveLength(0);

    const closeTabIds = calls.filter((c) => c[1] === 'closeTab').map((c) => c[2][0]);
    expect(closeTabIds).toHaveLength(2);
    expect(closeTabIds).not.toContain(directPageTargetId);

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
});
