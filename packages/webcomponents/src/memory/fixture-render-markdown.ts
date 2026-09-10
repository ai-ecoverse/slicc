/**
 * Story/test markdown→HTML. Escapes, then applies a few inline marks so
 * titles do not keep raw `**` / backticks. Not the webapp GFM renderer —
 * production hosts inject `renderMessageContent`.
 */

import { escapeHtml } from '../internal/html.js';
import { createMemoryRows } from './memory-rows.js';

export function fixtureRenderMarkdown(markdown: string): string {
  const escaped = escapeHtml(markdown);
  const withCode = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  const withBold = withCode.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return `<p>${withBold}</p>`;
}

/** Build memrow elements for stories and panel tests (no webapp import). */
export function createFixtureMemoryRows(markdown: string): HTMLElement[] {
  return createMemoryRows(markdown, fixtureRenderMarkdown);
}
