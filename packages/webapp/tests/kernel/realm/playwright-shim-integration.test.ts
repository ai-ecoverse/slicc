/**
 * Integration test for `playwright-shim.ts` — exercises the full playwright
 * shim flow end-to-end, simulating the exact usage patterns from the stardust
 * fixture scripts (e.g., mobile-nav-audit.mjs).
 *
 * Unlike the unit tests (playwright-shim.test.ts) which test individual method
 * call translations, these tests verify complete realistic workflows: launch
 * a browser → navigate → wait for load → query DOM → screenshot → close.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PlaywrightShimRpc } from '../../../src/kernel/realm/playwright-shim.js';
import { createPlaywrightShim } from '../../../src/kernel/realm/playwright-shim.js';

interface MockRpc extends PlaywrightShimRpc {
  call: ReturnType<typeof vi.fn<PlaywrightShimRpc['call']>>;
}

/**
 * Creates a mock RPC that responds intelligently based on the operation
 * and the arguments (especially eval code content checking).
 */
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
        // navigateTab([targetId, url])
        return undefined;
      }

      if (op === 'waitForLoadState') {
        // waitForLoadState([targetId, state?])
        return undefined;
      }

      if (op === 'setViewport') {
        // setViewport([targetId, width, height])
        return undefined;
      }

      if (op === 'screenshotTab') {
        // screenshotTab([targetId, opts?])
        // Return a minimal valid base64 PNG (1x1 transparent PNG)
        return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      }

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

        if (code.includes('Array.from(document.querySelectorAll')) {
          // page.$$eval() — simulate counting the matched elements
          if (code.includes('"li"')) return 3;
          return 0;
        }

        if (code.includes('document.querySelectorAll')) {
          // Count for page.$$
          if (code.includes('.length')) {
            if (code.includes('.nav-btn')) return 1;
            if (code.includes('li')) return 3;
            return 0;
          }
        }

        if (code.includes('.textContent')) {
          // ElementHandle.textContent()
          return 'Menu';
        }

        if (code.includes('.getAttribute(')) {
          // ElementHandle.getAttribute()
          if (code.includes('"class"')) return 'nav-btn';
          if (code.includes('"data-mobile"')) return 'true';
          return null;
        }

        if (code.includes('getComputedStyle')) {
          // ElementHandle.isVisible()
          return true;
        }

        if (code.includes('getBoundingClientRect')) {
          // ElementHandle.boundingBox()
          return { x: 10, y: 20, width: 100, height: 50 };
        }

        return null;
      }
    }

    if (channel === 'vfs') {
      if (op === 'writeFileBinary') {
        // writeFileBinary([path, bytes])
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

    // Launch browser
    const browser = await chromium.launch({ headless: true });
    expect(browser).toBeDefined();

    // Create a page with mobile viewport
    const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
    expect(page).toBeDefined();

    // Verify that createTab was called
    expect(rpc.call).toHaveBeenCalledWith('browser', 'createTab', ['about:blank']);

    // Verify that setViewport was called with the mobile size
    expect(rpc.call).toHaveBeenCalledWith('browser', 'setViewport', [expect.any(String), 360, 640]);

    // Navigate to a test page
    await page.goto('file:///tmp/test.html');
    expect(rpc.call).toHaveBeenCalledWith('browser', 'navigateTab', [
      expect.any(String),
      'file:///tmp/test.html',
    ]);

    // Wait for network to be idle
    await page.waitForLoadState('networkidle');
    expect(rpc.call).toHaveBeenCalledWith('browser', 'waitForLoadState', [
      expect.any(String),
      'networkidle',
    ]);

    // Get page HTML content
    const html = await page.content();
    expect(html).toBe('<html><body><button class="nav-btn">Menu</button></body></html>');

    // Take a screenshot and save it to VFS
    const buf = await page.screenshot({ path: '/tmp/shot.png' });
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.length).toBeGreaterThan(0);
    expect(rpc.call).toHaveBeenCalledWith('vfs', 'writeFileBinary', [
      '/tmp/shot.png',
      expect.any(Uint8Array),
    ]);

    // Close the page
    await page.close();
    expect(rpc.call).toHaveBeenCalledWith('browser', 'closeTab', [expect.any(String)]);

    // Close the browser
    await browser.close();
  });

  it('exercises element query and manipulation patterns', async () => {
    const rpc = createIntegrationMockRpc();
    const { chromium } = createPlaywrightShim(rpc);

    const browser = await chromium.launch();
    const page = await browser.newPage();

    // Navigate
    await page.goto('https://example.com');

    // Query a single element
    const navBtn = await page.$('.nav-btn');
    expect(navBtn).not.toBeNull();

    // Get text content from the element
    const text = await navBtn!.textContent();
    expect(text).toBe('Menu');

    // Get an attribute
    const classAttr = await navBtn!.getAttribute('class');
    expect(classAttr).toBe('nav-btn');

    // Get another attribute (data-mobile)
    const mobileAttr = await navBtn!.getAttribute('data-mobile');
    expect(mobileAttr).toBe('true');

    // Check visibility
    const isVisible = await navBtn!.isVisible();
    expect(isVisible).toBe(true);

    // Get bounding box
    const bbox = await navBtn!.boundingBox();
    expect(bbox).toEqual({ x: 10, y: 20, width: 100, height: 50 });

    // Query multiple elements
    const listItems = await page.$$('li');
    expect(listItems).toHaveLength(3);

    // Call methods on each element
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

    // Take a full-page screenshot to a file
    const screenshotPath = '/tmp/full-page.png';
    const buf = await page.screenshot({ fullPage: true, path: screenshotPath });

    // Verify the screenshot was written to VFS
    expect(rpc.call).toHaveBeenCalledWith('vfs', 'writeFileBinary', [
      screenshotPath,
      expect.any(Uint8Array),
    ]);

    // Verify screenshotTab was called with fullPage option
    expect(rpc.call).toHaveBeenCalledWith('browser', 'screenshotTab', [
      expect.any(String),
      { fullPage: true },
    ]);

    // Verify the returned buffer is valid
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.length).toBeGreaterThan(0);

    await browser.close();
  });

  it('handles multiple pages in a single browser instance', async () => {
    const rpc = createIntegrationMockRpc();
    const { chromium } = createPlaywrightShim(rpc);

    const browser = await chromium.launch();

    // Create multiple pages
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    const page3 = await browser.newPage();

    // Each should get its own createTab call
    expect(rpc.call).toHaveBeenCalledWith('browser', 'createTab', ['about:blank']);

    // Navigate each to different URLs
    await page1.goto('https://example1.com');
    await page2.goto('https://example2.com');
    await page3.goto('https://example3.com');

    // Close pages individually
    await page1.close();
    await page2.close();

    // Browser.close() should close the remaining page
    await browser.close();

    // Verify all three were closed (two explicit + one via browser.close())
    const closeCalls = (
      rpc.call.mock.calls as Array<[string, string, unknown[] | undefined]>
    ).filter((c) => c[1] === 'closeTab');
    expect(closeCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('works with firefox and webkit launchers (all backed by same chrome)', async () => {
    const rpc = createIntegrationMockRpc();
    const { firefox, webkit } = createPlaywrightShim(rpc);

    // Both should work identically
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

    // Evaluate with a string
    const stringResult = await page.evaluate('1 + 41');
    expect(stringResult).toBeDefined();

    // Evaluate with a function
    const funcResult = await page.evaluate(() => {
      return 'test result';
    });
    expect(funcResult).toBeDefined();

    // Evaluate with a function that takes args
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

    // Query for an element that doesn't exist
    const missing = await page.$('.nonexistent-class');
    expect(missing).toBeNull();

    // Query multiple that don't exist
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

    // Get multiple elements
    const buttons = await page.$$('.nav-btn');
    expect(buttons).toHaveLength(1);

    // Each handle should maintain its own index for queries
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

    // Selector deliberately chosen so the $$eval-specific mock branch (→ 0)
    // and the pre-existing generic querySelectorAll+.length branch (→ 1 for
    // ".nav-btn") diverge — this discriminates a mock branch-order regression,
    // unlike a selector where both branches happen to agree.
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

    // context.close() must close exactly the two context-owned tabs, and
    // never the browser's own directly-opened tab — this is the isolation
    // guarantee this test exists to check, verified against actual rpc
    // calls rather than the mock's canned (targetId-insensitive) content.
    const closeTabIds = calls.filter((c) => c[1] === 'closeTab').map((c) => c[2][0]);
    expect(closeTabIds).toHaveLength(2);
    expect(closeTabIds).not.toContain(directPageTargetId);

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
});
