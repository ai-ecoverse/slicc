/**
 * Memory surface for the WC workbench: the cone's `/workspace/CLAUDE.md`
 * rendered as `<slicc-memrow>` cards — one per memory bullet, with section
 * headings carried into the row title.
 */

import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import { renderMessageContent } from '../message-renderer.js';

const MEMORY_PATH = '/workspace/CLAUDE.md';
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
}

interface MemorySplit {
  title: string;
  summary: string;
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
  if (plain.length <= TITLE_TARGET) return { title: plain, summary: '' };

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
    };
  }

  const prefix = plain.slice(0, MEMORY_TITLE_MAX + 1);
  const lastSpace = prefix.lastIndexOf(' ');
  const splitAt = lastSpace >= MIN_TITLE_LENGTH ? lastSpace : MEMORY_TITLE_MAX;
  return { title: plain.slice(0, splitAt).trim(), summary: plain.slice(splitAt).trim() };
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

/** Commit sanitized renderer output via DOM construction, matching message rows. */
function setBodyHtml(row: HTMLElement, html: string): void {
  row.replaceChildren(trustedFragment(html));
}

/** Read the cone memory file and render it as memrow cards. */
export async function buildMemoryRows(fs: LocalVfsClient): Promise<HTMLElement[]> {
  let markdown = '';
  try {
    const raw = await fs.readFile(MEMORY_PATH, { encoding: 'utf-8' });
    markdown = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    markdown = '';
  }
  return parseMemoryRows(markdown).map((row) => {
    const el = document.createElement('slicc-memrow');
    el.setAttribute('heading', row.title);
    if (row.summary) el.setAttribute('summary', row.summary);
    el.setAttribute('section', row.section);
    if (row.tag) el.setAttribute('tag', row.tag);
    setBodyHtml(el, row.bodyHtml);
    return el;
  });
}
