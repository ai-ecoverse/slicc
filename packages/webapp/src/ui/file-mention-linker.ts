import type { FileMentionResolver } from '../core/file-mention-resolver.js';
import { findFileMentions } from '../core/file-mentions.js';

export const FILE_MENTION_CLASS = 'file-mention';

const PROCESSED_ATTR = 'data-file-mentions';

function contentFingerprint(root: HTMLElement): string {
  return `${root.childNodes.length}:${root.textContent?.length ?? 0}`;
}

const SKIPPED_ANCESTORS = new Set(['A', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']);

export interface FileMentionOpenDetail {
  path: string;

  alternatives: string[];

  line?: number;
}

export const FILE_MENTION_OPEN_EVENT = 'file-mention-open';

export async function linkifyFileMentions(
  root: HTMLElement,
  resolver: FileMentionResolver,
  hints: readonly string[] = []
): Promise<void> {
  const fingerprint = contentFingerprint(root);
  if (root.getAttribute(PROCESSED_ATTR) === fingerprint) return;

  const targets = collectTextNodes(root);
  if (targets.length === 0) {
    root.setAttribute(PROCESSED_ATTR, fingerprint);
    return;
  }

  const work: Array<{ node: Text; mentions: ReturnType<typeof findFileMentions> }> = [];
  const queries = new Set<string>();
  for (const node of targets) {
    const mentions = findFileMentions(node.data);
    if (mentions.length === 0) continue;
    work.push({ node, mentions });
    for (const mention of mentions) queries.add(mention.path);
  }

  if (work.length === 0) {
    root.setAttribute(PROCESSED_ATTR, fingerprint);
    return;
  }

  const asked = [...queries];
  const resolutions = await resolver.resolveAll(asked, hints);
  const byQuery = new Map(asked.map((query, i) => [query, resolutions[i]?.matches ?? []]));

  for (const { node, mentions } of work) {
    if (!node.isConnected) continue;
    const confirmed = mentions.filter((m) => (byQuery.get(m.path)?.length ?? 0) > 0);
    if (confirmed.length === 0) continue;
    replaceWithLinks(node, confirmed, byQuery);
  }

  root.setAttribute(PROCESSED_ATTR, contentFingerprint(root));
}

function collectTextNodes(root: HTMLElement): Text[] {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (!node.nodeValue || node.nodeValue.trim().length === 0) {
        return NodeFilter.FILTER_REJECT;
      }
      for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
        if (SKIPPED_ANCESTORS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (el.classList.contains(FILE_MENTION_CLASS)) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}

function replaceWithLinks(
  node: Text,
  mentions: ReturnType<typeof findFileMentions>,
  byQuery: Map<string, string[]>
): void {
  const doc = node.ownerDocument;
  const text = node.data;
  const fragment = doc.createDocumentFragment();
  let cursor = 0;

  for (const mention of mentions) {
    const matches = byQuery.get(mention.path) ?? [];
    const target = matches[0];
    if (!target) continue;

    if (mention.start > cursor) {
      fragment.appendChild(doc.createTextNode(text.slice(cursor, mention.start)));
    }
    fragment.appendChild(
      createMentionLink(doc, text.slice(mention.start, mention.end), target, matches, mention.line)
    );
    cursor = mention.end;
  }

  if (cursor < text.length) fragment.appendChild(doc.createTextNode(text.slice(cursor)));
  node.parentNode?.replaceChild(fragment, node);
}

function createMentionLink(
  doc: Document,
  label: string,
  target: string,
  matches: string[],
  line: number | undefined
): HTMLAnchorElement {
  const link = doc.createElement('a');
  link.className = FILE_MENTION_CLASS;
  link.textContent = label;

  link.href = `#${target}`;
  link.dataset.path = target;
  if (line !== undefined) link.dataset.line = String(line);
  link.title =
    matches.length > 1
      ? `${target}\n(+${matches.length - 1} other match${matches.length > 2 ? 'es' : ''})`
      : target;

  link.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const detail: FileMentionOpenDetail = {
      path: target,
      alternatives: matches,
      ...(line !== undefined ? { line } : {}),
    };
    link.dispatchEvent(
      new CustomEvent<FileMentionOpenDetail>(FILE_MENTION_OPEN_EVENT, {
        detail,
        bubbles: true,
        composed: true,
      })
    );
  });

  return link;
}
