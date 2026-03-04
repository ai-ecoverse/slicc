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
import type { ToolDefinition, ToolResult } from '../core/types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tool:browser');

/** Create the browser tool bound to a BrowserAPI instance. */
export function createBrowserTool(browser: BrowserAPI): ToolDefinition {
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

  return {
    name: 'browser',
    description:
      'Control browser tabs via Chrome DevTools Protocol. Specify an "action" and relevant parameters. ' +
      'The app\'s own tab is hidden and protected — you cannot accidentally navigate or modify it. ' +
      'Actions: list_tabs, new_tab (url — creates a new tab and navigates to the URL, returns targetId), ' +
      'navigate (url, targetId), screenshot (targetId), evaluate (expression, targetId), ' +
      'click (selector, targetId), type (text, targetId), evaluate_persistent (expression — runs JS in a persistent ' +
      'blank tab that preserves variables across calls, no targetId needed).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_tabs', 'new_tab', 'navigate', 'screenshot', 'evaluate', 'click', 'type', 'evaluate_persistent'],
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
          description: 'CSS selector to click (for "click" action).',
        },
        text: {
          type: 'string',
          description: 'Text to type (for "type" action).',
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
              (p) => `- ${p.targetId}: ${p.title} (${p.url})`,
            );
            return { content: lines.join('\n') };
          }

          case 'new_tab': {
            const url = input['url'] as string || 'about:blank';
            await resolveAppTabId();
            const createResult = await browser.cdpClient.send('Target.createTarget', { url });
            const newTargetId = createResult['targetId'] as string;
            return { content: `Created new tab (targetId: ${newTargetId}) at ${url}` };
          }

          case 'navigate': {
            const targetId = input['targetId'] as string;
            const url = input['url'] as string;
            if (!targetId || !url) {
              return { content: 'navigate requires targetId and url', isError: true };
            }
            await browser.attachToPage(targetId);
            await browser.navigate(url);
            return { content: `Navigated to ${url}` };
          }

          case 'screenshot': {
            const targetId = input['targetId'] as string;
            if (!targetId) {
              return { content: 'screenshot requires targetId', isError: true };
            }
            await browser.attachToPage(targetId);
            const base64 = await browser.screenshot();
            return { content: `Screenshot captured (base64 PNG, ${base64.length} chars). Data: ${base64.slice(0, 100)}...` };
          }

          case 'evaluate': {
            const targetId = input['targetId'] as string;
            const expression = input['expression'] as string;
            if (!targetId || !expression) {
              return { content: 'evaluate requires targetId and expression', isError: true };
            }
            await browser.attachToPage(targetId);
            const result = await browser.evaluate(expression);
            return { content: JSON.stringify(result, null, 2) };
          }

          case 'click': {
            const targetId = input['targetId'] as string;
            const selector = input['selector'] as string;
            if (!targetId || !selector) {
              return { content: 'click requires targetId and selector', isError: true };
            }
            await browser.attachToPage(targetId);
            await browser.click(selector);
            return { content: `Clicked: ${selector}` };
          }

          case 'type': {
            const targetId = input['targetId'] as string;
            const text = input['text'] as string;
            if (!targetId || !text) {
              return { content: 'type requires targetId and text', isError: true };
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
              } catch {
                runtimeTabId = null;
              }
            }
            if (!runtimeTabId) {
              // listPages ensures CDP connection is established
              await browser.listPages();
              const createResult = await browser.cdpClient.send('Target.createTarget', { url: 'about:blank' });
              runtimeTabId = createResult['targetId'] as string;
              await browser.attachToPage(runtimeTabId);
            }
            const evalResult = await browser.evaluate(expression);
            return { content: JSON.stringify(evalResult, null, 2) };
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
