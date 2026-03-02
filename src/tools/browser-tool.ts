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
  return {
    name: 'browser',
    description:
      'Control browser tabs via Chrome DevTools Protocol. Specify an "action" and relevant parameters. Actions: list_tabs, navigate (url, targetId), screenshot (targetId), evaluate (expression, targetId), click (selector, targetId), type (text, targetId).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_tabs', 'navigate', 'screenshot', 'evaluate', 'click', 'type'],
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

      try {
        switch (action) {
          case 'list_tabs': {
            const pages = await browser.listPages();
            if (pages.length === 0) {
              return { content: 'No browser tabs found.' };
            }
            const lines = pages.map(
              (p) => `- ${p.targetId}: ${p.title} (${p.url})`,
            );
            return { content: lines.join('\n') };
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
