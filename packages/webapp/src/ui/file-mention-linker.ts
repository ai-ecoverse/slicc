/**
 * Making file names in the transcript clickable.
 *
 * This is the DOM half of the mention feature: it walks a rendered message,
 * asks `FileMentionResolver` which of the candidate names are real, and rewrites
 * only the confirmed ones into links. Everything else is left exactly as the
 * markdown renderer produced it.
 *
 * ## Confirm, then linkify
 *
 * Nothing is decorated optimistically. A mention stays plain text until the VFS
 * says the file exists, so the transcript never shows a link that leads nowhere
 * and never visibly churns as lookups land. The cost is that links appear a beat
 * after the text — acceptable, because the alternative is either dead links or a
 * blocking read on every render.
 *
 * ## Where it declines to look
 *
 * Fenced code blocks (`pre`) are skipped: they are full of paths that are
 * examples, not references, and linkifying inside syntax-highlighted markup
 * would fight the highlighter's own spans. Inline `code` IS processed, because
 * `` `bb.jsh` `` is the single most common way an agent names a file. Existing
 * links are never re-entered.
 *
 * ## Idempotence
 *
 * Assistant messages re-render on every streaming chunk, so this runs repeatedly
 * over the same content. Processed roots are marked, and already-linked mentions
 * are recognized and skipped, making a second pass over unchanged content free.
 */

import type { FileMentionResolver } from '../core/file-mention-resolver.js';
import { findFileMentions } from '../core/file-mentions.js';

/** Class applied to every generated link, and the hook for styling. */
export const FILE_MENTION_CLASS = 'file-mention';

/** Marks a subtree as already linkified, so re-renders don't redo the work. */
const PROCESSED_ATTR = 'data-file-mentions';

/** Element names whose text is never a file reference worth linking. */
const SKIPPED_ANCESTORS = new Set(['A', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']);

/** Detail carried by the event a mention click dispatches. */
export interface FileMentionOpenDetail {
  /** The VFS path to preview. */
  path: string;
  /** Every path the mention could have meant, when it was ambiguous. */
  alternatives: string[];
  /** 1-based line to reveal, from a `path:42` mention. */
  line?: number;
}

/** Event name the shell listens for to open the preview. */
export const FILE_MENTION_OPEN_EVENT = 'file-mention-open';

/**
 * Link every confirmed file mention inside `root`.
 *
 * Resolves in the background and returns once the rewrite is done, so callers
 * that want to await it (tests, transcript export) can. Fire-and-forget is the
 * normal usage.
 */
export async function linkifyFileMentions(
  root: HTMLElement,
  resolver: FileMentionResolver
): Promise<void> {
  if (root.getAttribute(PROCESSED_ATTR) === 'done') return;

  const targets = collectTextNodes(root);
  if (targets.length === 0) {
    root.setAttribute(PROCESSED_ATTR, 'done');
    return;
  }

  // Gather every candidate across the whole message first, so one resolver pass
  // covers all of them and repeated names share a single lookup.
  const work: Array<{ node: Text; mentions: ReturnType<typeof findFileMentions> }> = [];
  const queries = new Set<string>();
  for (const node of targets) {
    const mentions = findFileMentions(node.data);
    if (mentions.length === 0) continue;
    work.push({ node, mentions });
    for (const mention of mentions) queries.add(mention.path);
  }

  if (work.length === 0) {
    root.setAttribute(PROCESSED_ATTR, 'done');
    return;
  }

  const resolutions = await resolver.resolveAll([...queries]);
  const byQuery = new Map(resolutions.map((r) => [r.query, r.matches]));

  for (const { node, mentions } of work) {
    // The node may have been replaced by a re-render while we awaited.
    if (!node.isConnected) continue;
    const confirmed = mentions.filter((m) => (byQuery.get(m.path)?.length ?? 0) > 0);
    if (confirmed.length === 0) continue;
    replaceWithLinks(node, confirmed, byQuery);
  }

  root.setAttribute(PROCESSED_ATTR, 'done');
}

/** Every text node under `root` that is eligible to contain a file mention. */
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

/** Split one text node into text + link fragments and swap it into the DOM. */
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
  // `href` makes it a real link for middle-click, focus and a11y, but the
  // preview opens in-app, so the default navigation is suppressed on click.
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
