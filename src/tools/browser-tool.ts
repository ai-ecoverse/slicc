/**
 * Browser tool — Control other browser tabs via CDP.
 *
 * Provides a single "browser" tool with sub-actions:
 * - list_tabs: List open browser tabs
 * - navigate: Navigate a tab to a URL
 * - screenshot: Capture a screenshot of a tab
 * - evaluate: Run JavaScript in a tab
 * - click: Click an element by CSS selector
 * - type: Type text into a focused element
 */

import type { BrowserAPI } from '../cdp/index.js';
import type { VirtualFS } from '../fs/index.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tool:browser');

/** Decode base64 string to Uint8Array. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Create the browser tool bound to a BrowserAPI instance. */
export function createBrowserTool(browser: BrowserAPI, fs?: VirtualFS | null): ToolDefinition {
  let runtimeTabId: string | null = null;
  let appTabId: string | null = null;

  /** Detect and cache the SLICC app's own tab ID so we can hide/protect it. */
  async function resolveAppTabId(): Promise<void> {
    if (appTabId) return;
    const pages = await browser.listPages();
    const appOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
    const appTab = pages.find((p) => p.url.startsWith(appOrigin));
    if (appTab) appTabId = appTab.targetId;
  }

  function isAppTab(targetId: string): boolean {
    return targetId === appTabId;
  }

  /** Resolve the user's active tab. Returns targetId or null. */
  async function getActiveTab(): Promise<string | null> {
    try {
      const pages = await browser.listPages();
      const active = pages.find((p) => p.active && !isAppTab(p.targetId));
      if (!active) {
        log.debug('No active user tab found', {
          totalPages: pages.length,
          activeTabs: pages.filter((p) => p.active).length,
          appTabId,
        });
      }
      return active?.targetId ?? null;
    } catch (err) {
      log.error('Failed to resolve active tab', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  return {
    name: 'browser',
    description:
      'Control browser tabs via Chrome DevTools Protocol. Specify an "action" and relevant parameters. ' +
      'The app\'s own tab is hidden and protected — you cannot accidentally navigate or modify it. ' +
      'If targetId is omitted, the user\'s currently active/focused tab is used automatically. ' +
      'Actions: list_tabs, new_tab (url — creates a new tab and navigates to the URL, returns targetId), ' +
      'navigate (url, targetId?), screenshot (targetId?, path?, fullPage?, selector? — if path is given, saves PNG to VFS; ' +
      'set fullPage=true to capture the entire scrollable page; use selector to capture just a specific element), ' +
      'evaluate (expression, targetId?), click (selector, targetId?), type (text, targetId?), ' +
      'evaluate_persistent (expression — runs JS in a persistent blank tab that preserves variables across calls, no targetId needed), ' +
      'show_image (path — displays an image from VFS inline in the chat; use this when the user asks to see an image file).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_tabs', 'new_tab', 'navigate', 'screenshot', 'evaluate', 'click', 'type', 'evaluate_persistent', 'show_image'],
          description: 'The browser action to perform.',
        },
        targetId: {
          type: 'string',
          description: 'The target/tab ID to operate on. Required for all actions except list_tabs.',
        },
        url: {
          type: 'string',
          description: 'URL to navigate to (for "navigate" action).',
        },
        expression: {
          type: 'string',
          description: 'JavaScript expression to evaluate (for "evaluate" action).',
        },
        selector: {
          type: 'string',
          description: 'CSS selector — for "click" action: element to click. For "screenshot" action: element to capture (screenshots just that element).',
        },
        text: {
          type: 'string',
          description: 'Text to type (for "type" action).',
        },
        path: {
          type: 'string',
          description: 'VFS path to save screenshot PNG (for "screenshot" action). When provided, saves directly to the virtual filesystem instead of returning base64 data.',
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture the full scrollable page, not just the visible viewport (for "screenshot" action). Default: false.',
        },
      },
      required: ['action'],
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = input['action'] as string;
      const targetId = input['targetId'] as string | undefined;
      log.debug('Action', { action, targetId, url: input['url'], selector: input['selector'] });

      // Protect the SLICC app tab from being modified
      await resolveAppTabId();
      if (targetId && isAppTab(targetId)) {
        return { content: 'Cannot operate on the SLICC app tab — that would kill the application. Use a different tab or create a new one.', isError: true };
      }

      try {
        switch (action) {
          case 'list_tabs': {
            await resolveAppTabId();
            const pages = (await browser.listPages()).filter((p) => !isAppTab(p.targetId));
            if (pages.length === 0) {
              return { content: 'No browser tabs found. Use the "navigate" action with a new tab to open a page.' };
            }
            const lines = pages.map(
              (p) => `${p.active ? '→ ' : '- '}${p.targetId}: ${p.title} (${p.url})`,
            );
            return { content: lines.join('\n') };
          }

          case 'new_tab': {
            const url = input['url'] as string || 'about:blank';
            await resolveAppTabId();
            const newTargetId = await browser.createPage(url);
            return { content: `Created new tab (targetId: ${newTargetId}) at ${url}` };
          }

          case 'navigate': {
            const targetId = (input['targetId'] as string) || await getActiveTab();
            const url = input['url'] as string;
            if (!targetId || !url) {
              return { content: 'navigate requires url (and targetId or an active tab)', isError: true };
            }
            await browser.attachToPage(targetId);
            await browser.navigate(url);
            return { content: `Navigated to ${url}` };
          }

          case 'screenshot': {
            const targetId = (input['targetId'] as string) || await getActiveTab();
            if (!targetId) {
              return { content: 'screenshot requires targetId or an active tab', isError: true };
            }
            await browser.attachToPage(targetId);
            const fullPage = input['fullPage'] as boolean | undefined;
            const screenshotSelector = input['selector'] as string | undefined;

            // If selector is given, resolve it to a clip rect via evaluate
            let clip: { x: number; y: number; width: number; height: number } | undefined;
            if (screenshotSelector) {
              const rectJson = await browser.evaluate(
                `(function() {
                  const el = document.querySelector(${JSON.stringify(screenshotSelector)});
                  if (!el) return null;
                  el.scrollIntoView({ block: 'center' });
                  const r = el.getBoundingClientRect();
                  return JSON.stringify({ x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height });
                })()`,
              );
              if (rectJson) {
                clip = JSON.parse(rectJson as string);
              } else {
                return { content: `Element not found: ${screenshotSelector}`, isError: true };
              }
            }

            const base64 = await browser.screenshot({
              fullPage: fullPage ?? false,
              ...(clip ? { clip } : {}),
            });
            const savePath = input['path'] as string | undefined;
            if (savePath && fs) {
              // Save PNG directly to VFS — avoids flooding the conversation with megabytes of base64
              const bytes = base64ToBytes(base64);
              await fs.writeFile(savePath, bytes);
              const sizeKB = Math.round(bytes.length / 1024);
              // Include a data URL thumbnail so the chat UI can display the image inline
              return { content: `Screenshot saved to ${savePath} (${sizeKB} KB PNG)\n<img:data:image/png;base64,${base64}>` };
            }
            // No path: return base64 as data URL for inline display
            return { content: `Screenshot captured (base64 PNG, ${base64.length} chars)\n<img:data:image/png;base64,${base64}>` };
          }

          case 'evaluate': {
            const targetId = (input['targetId'] as string) || await getActiveTab();
            const expression = input['expression'] as string;
            if (!targetId || !expression) {
              return { content: 'evaluate requires expression (and targetId or an active tab)', isError: true };
            }
            await browser.attachToPage(targetId);
            const result = await browser.evaluate(expression);
            return { content: JSON.stringify(result, null, 2) };
          }

          case 'click': {
            const targetId = (input['targetId'] as string) || await getActiveTab();
            const selector = input['selector'] as string;
            if (!targetId || !selector) {
              return { content: 'click requires selector (and targetId or an active tab)', isError: true };
            }
            await browser.attachToPage(targetId);
            await browser.click(selector);
            return { content: `Clicked: ${selector}` };
          }

          case 'type': {
            const targetId = (input['targetId'] as string) || await getActiveTab();
            const text = input['text'] as string;
            if (!targetId || !text) {
              return { content: 'type requires text (and targetId or an active tab)', isError: true };
            }
            await browser.attachToPage(targetId);
            await browser.type(text);
            return { content: `Typed: ${text}` };
          }

          case 'evaluate_persistent': {
            const expression = input['expression'] as string;
            if (!expression) {
              return { content: 'evaluate_persistent requires expression', isError: true };
            }
            // Ensure we have a persistent runtime tab
            if (runtimeTabId) {
              try {
                await browser.attachToPage(runtimeTabId);
              } catch (err) {
                log.warn('Runtime tab lost, creating new one', {
                  runtimeTabId,
                  error: err instanceof Error ? err.message : String(err),
                });
                runtimeTabId = null;
              }
            }
            if (!runtimeTabId) {
              // listPages ensures CDP connection is established
              await browser.listPages();
              runtimeTabId = await browser.createPage();
              await browser.attachToPage(runtimeTabId);
            }
            const evalResult = await browser.evaluate(expression);
            return { content: JSON.stringify(evalResult, null, 2) };
          }

          case 'show_image': {
            const imagePath = input['path'] as string;
            if (!imagePath || !fs) {
              return { content: 'show_image requires path (VFS path to an image file)', isError: true };
            }
            try {
              const bytes = await fs.readFile(imagePath, { encoding: 'binary' });
              const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes as string);
              // Convert to base64
              let base64 = '';
              const chunk = 8192;
              for (let i = 0; i < data.length; i += chunk) {
                base64 += String.fromCharCode(...data.subarray(i, i + chunk));
              }
              base64 = btoa(base64);
              const ext = imagePath.split('.').pop()?.toLowerCase() ?? 'png';
              const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                : ext === 'svg' ? 'image/svg+xml'
                : ext === 'webp' ? 'image/webp'
                : ext === 'gif' ? 'image/gif'
                : 'image/png';
              const sizeKB = Math.round(data.length / 1024);
              return { content: `Showing ${imagePath} (${sizeKB} KB)\n<img:data:${mime};base64,${base64}>` };
            } catch (err) {
              return { content: `Failed to read image: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }
          }

          default:
            return { content: `Unknown action: ${action}`, isError: true };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Error', { action, error: message });
        return { content: `Browser error: ${message}`, isError: true };
      }
    },
  };
}
