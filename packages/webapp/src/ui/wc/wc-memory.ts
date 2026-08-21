/**
 * Memory surface for the WC workbench: the selected cone's `CLAUDE.md`
 * rendered as `<slicc-memrow>` cards — one per memory bullet, with section
 * headings carried into the row title. Each cone has its own file (#2271), so
 * the path is passed in rather than hardcoded.
 */

import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import { PRIMARY_WORKSPACE } from '../../work-unit/descriptor.js';
import { renderMessageContent } from '../message-renderer.js';
import '@slicc/webcomponents/src/memory/slicc-memrow.js';

const TITLE_TARGET = 64;
export const MEMORY_TITLE_MAX = 96;
const MIN_TITLE_LENGTH = 12;
const FEEDBACK_SECTION =
  /\b(feedback|reviews?|corrections?|learnings?|observations?|testing|verification)\b/i;
const USER_SECTION =
  /\b(user|preferences?|identit(?:y|ies)|accounts?|personal|interface|working rhythm|keyboard|accessibility)\b/i;
const AUTO_EXTRACTED_SECTION = /^Auto-extracted \(/;

export type MemoryTag = 'user' | 'feedback' | 'project';

export interface MemoryRow {
  title: string;
  summary: string;
  section: string;
  tag: MemoryTag | null;
  bodyHtml: string;
  titleEnd: number;
  summaryStart: number;
}

interface MemorySplit {
  title: string;
  summary: string;
  titleEnd: number;
  summaryStart: number;
}

interface PendingMemory {
  lines: string[];
  section: string;
}

/** Parse trusted renderer output without assigning it to an HTML sink. */
function trustedFragment(html: string): DocumentFragment {
  const range = document.createRange();
  range.selectNodeContents(document.body);
  return range.createContextualFragment(html);
}

function markdownText(markdown: string): string {
  return (trustedFragment(renderMessageContent(markdown)).textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Prefer a nearby clause boundary, then enforce a lossless hard cap. */
function splitBullet(markdown: string): MemorySplit {
  const plain = markdownText(markdown);
  if (plain.length <= TITLE_TARGET) {
    return { title: plain, summary: '', titleEnd: plain.length, summaryStart: plain.length };
  }

  const candidates: Array<{ titleEnd: number; summaryStart: number }> = [];
  const boundary =
    /[.!?](?:[*_`'")\]]*)\s+|\s+[—–]\s+|[:;](?:[*_`]*)\s+|,\s+(?=(?:and|but|because|while|when|then|so)\b)/g;
  for (const match of plain.matchAll(boundary)) {
    const delimiterStartsSummary = /^\s+[—–]|^[:;]/.test(match[0]);
    const titleEnd = match.index + (delimiterStartsSummary ? 0 : match[0].trimEnd().length);
    const summaryStart = match.index + match[0].length;
    if (
      plain.slice(0, titleEnd).trim().length >= MIN_TITLE_LENGTH &&
      titleEnd <= MEMORY_TITLE_MAX &&
      plain.slice(summaryStart).trim()
    ) {
      candidates.push({ titleEnd, summaryStart });
    }
  }
  const best = candidates.sort(
    (a, b) => Math.abs(a.titleEnd - TITLE_TARGET) - Math.abs(b.titleEnd - TITLE_TARGET)
  )[0];
  if (best) {
    return {
      title: plain.slice(0, best.titleEnd).trim(),
      summary: plain.slice(best.summaryStart).trim(),
      titleEnd: best.titleEnd,
      summaryStart: best.summaryStart,
    };
  }

  const prefix = plain.slice(0, MEMORY_TITLE_MAX + 1);
  const lastSpace = prefix.lastIndexOf(' ');
  const splitAt = lastSpace >= MIN_TITLE_LENGTH ? lastSpace : MEMORY_TITLE_MAX;
  const summary = plain.slice(splitAt).trim();
  return {
    title: plain.slice(0, splitAt).trim(),
    summary,
    titleEnd: splitAt,
    summaryStart: plain.indexOf(summary, splitAt),
  };
}

function tagForMemory(markdown: string, section: string): MemoryTag | null {
  const content = markdownText(markdown);
  const autoExtracted = AUTO_EXTRACTED_SECTION.test(section);
  const evidence = autoExtracted ? content : `${section} ${content}`;
  if (FEEDBACK_SECTION.test(evidence)) return 'feedback';
  if (USER_SECTION.test(evidence)) return 'user';
  return autoExtracted ? null : 'project';
}

function memoryRow(markdown: string, section: string): MemoryRow {
  const split = splitBullet(markdown);
  return {
    title: split.title,
    summary: split.summary,
    section,
    tag: tagForMemory(markdown, section),
    bodyHtml: renderMessageContent(markdown),
    titleEnd: split.titleEnd,
    summaryStart: split.summaryStart,
  };
}

/**
 * Parse the memory markdown into rows: one per `- ` bullet (continuation
 * lines folded in). A document without bullets becomes a single row.
 */
export function parseMemoryRows(markdown: string): MemoryRow[] {
  const rows: MemoryRow[] = [];
  let documentTitle = 'Memory';
  let section = '';
  let subsection = '';
  let current: PendingMemory | null = null;
  const currentSection = (): string =>
    [section || documentTitle, subsection].filter(Boolean).join(' / ');
  const flush = (): void => {
    if (!current) return;
    const text = current.lines.join(' ').trim();
    if (text) rows.push(memoryRow(text, current.section));
    current = null;
  };
  for (const line of markdown.split('\n')) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (heading) {
      flush();
      const headingText = markdownText(heading[2]);
      if (heading[1].length === 1) {
        documentTitle = headingText || documentTitle;
        section = '';
        subsection = '';
      } else if (heading[1].length === 2) {
        section = headingText;
        subsection = '';
      } else if (heading[1].length === 3) {
        subsection = headingText;
      }
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      current = { lines: [bullet[1]], section: currentSection() };
    } else if (!line.trim()) {
      flush();
    } else if (current) {
      current.lines.push(line.trim());
    } else {
      current = { lines: [line.trim()], section: currentSection() };
    }
  }
  flush();
  return rows;
}

interface FragmentPosition {
  node: Node;
  offset: number;
}

function normalizedPosition(fragment: DocumentFragment, target: number): FragmentPosition | null {
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  let normalizedOffset = 0;
  let hasText = false;
  let pendingSpace = false;
  let pendingSpacePosition: FragmentPosition | null = null;
  let node = walker.nextNode() as Text | null;
  while (node) {
    for (let offset = 0; offset < node.data.length; offset += 1) {
      if (/\s/.test(node.data[offset])) {
        if (hasText && !pendingSpace) {
          pendingSpace = true;
          pendingSpacePosition = { node, offset };
        }
        continue;
      }
      if (pendingSpace) {
        if (normalizedOffset === target) return pendingSpacePosition;
        normalizedOffset += 1;
      }
      pendingSpace = false;
      pendingSpacePosition = null;
      if (normalizedOffset === target) return { node, offset };
      normalizedOffset += 1;
      hasText = true;
    }
    node = walker.nextNode() as Text | null;
  }
  return normalizedOffset === target
    ? { node: fragment, offset: fragment.childNodes.length }
    : null;
}

function renderedFragment(html: string, start: number, end: number | null): DocumentFragment {
  const fragment = trustedFragment(html);
  const startPosition = normalizedPosition(fragment, start);
  const endPosition =
    end == null
      ? { node: fragment, offset: fragment.childNodes.length }
      : normalizedPosition(fragment, end);
  if (!startPosition || !endPosition) return document.createDocumentFragment();
  const range = document.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset);
  const content = range.cloneContents();
  for (const child of [...content.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()) child.remove();
  }
  const paragraph = content.childNodes.length === 1 ? content.firstChild : null;
  if (!(paragraph instanceof HTMLParagraphElement)) return content;
  const unwrapped = document.createDocumentFragment();
  unwrapped.append(...paragraph.childNodes);
  return unwrapped;
}

interface RichMemoryRow extends HTMLElement {
  setHeadingContent(content: DocumentFragment): void;
  setBodyContent(content: DocumentFragment): void;
}

/** Build production memrow elements from already-loaded memory Markdown. */
export function createMemoryRows(markdown: string): HTMLElement[] {
  return parseMemoryRows(markdown).map((row) => {
    const el = document.createElement('slicc-memrow') as RichMemoryRow;
    el.setAttribute('heading', row.title);
    if (row.summary) el.setAttribute('summary', row.summary);
    el.setAttribute('section', row.section);
    if (row.tag) el.setAttribute('tag', row.tag);
    el.setHeadingContent(renderedFragment(row.bodyHtml, 0, row.titleEnd));
    if (row.summary) {
      el.setBodyContent(renderedFragment(row.bodyHtml, row.summaryStart, null));
    }
    return el;
  });
}

/**
 * Read a cone's memory file and render it as memrow cards. `memoryPath`
 * defaults to the primary cone's (#2271).
 */
export async function buildMemoryRows(
  fs: LocalVfsClient,
  memoryPath: string = PRIMARY_WORKSPACE.memoryPath
): Promise<HTMLElement[]> {
  let markdown = '';
  try {
    const raw = await fs.readFile(memoryPath, { encoding: 'utf-8' });
    markdown = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    markdown = '';
  }
  return createMemoryRows(markdown);
}
