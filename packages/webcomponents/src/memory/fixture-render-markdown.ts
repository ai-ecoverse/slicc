/**
 * Story/test markdown→HTML. Escapes, then applies a few inline marks so
 * titles do not keep raw `**` / backticks / `[label](url)`. Not the webapp
 * GFM renderer — production hosts inject `renderMessageContent`.
 */

import { escapeHtml } from '../internal/html.js';
import { createMemoryRows } from './memory-rows.js';

const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

export function fixtureRenderMarkdown(markdown: string): string {
  const escaped = escapeHtml(markdown);
  const withCode = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  const withBold = withCode.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const withLinks = withBold.replace(LINK_RE, (_match, label: string, href: string) => {
    if (/^javascript:/i.test(href)) return label;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return `<p>${withLinks}</p>`;
}

/** Build memrow elements for stories and panel tests (no webapp import). */
export function createFixtureMemoryRows(markdown: string): HTMLElement[] {
  return createMemoryRows(markdown, fixtureRenderMarkdown);
}
