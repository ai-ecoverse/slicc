/**
 * Replacing pasted base64 payloads in the transcript with a chip.
 *
 * The DOM half of the base64 preview: it walks a rendered message, decodes the
 * candidates `core/base64-mentions.ts` found, and swaps the ones it can
 * IDENTIFY for a `<slicc-blob-chip>` that opens the payload in Quick Look.
 * Everything else is left exactly as the markdown renderer produced it.
 *
 * ## Decode, then elide
 *
 * Nothing is replaced optimistically. A run stays plain text until the bytes it
 * decodes to are recognizable — a known signature, a MIME type the `data:` URL
 * declared, or content that reads as text. This mirrors `file-mention-linker.ts`
 * ("confirm, then linkify") but with a sharper edge: a wrong file mention is a
 * link that goes nowhere, whereas eliding hides text the user typed. Verifying
 * costs a decode, and unlike a file mention that decode is synchronous — there
 * is no VFS to ask, so the chip lands in the same frame as the text.
 *
 * ## Where it declines to look
 *
 * Fenced code blocks (`pre`) are skipped. They already scroll inside themselves,
 * so a blob in one is contained, and a code block is the one place someone is
 * asking to see the literal characters. Inline `code` IS processed — a payload
 * wrapped in backticks is still a payload. Existing links and chips are never
 * re-entered.
 *
 * ## Idempotence
 *
 * Assistant messages re-render on every streaming chunk and bubbles are rebuilt
 * whenever the thread is, so this runs repeatedly over the same content.
 * Processed roots carry a fingerprint of what was processed, making a second
 * pass over unchanged content free.
 */

import { hasIcon } from '@slicc/webcomponents';
import { shortMimeLabel } from '@slicc/webcomponents/internal/mime-label';
import { formatAttachmentSize } from '../core/attachments.js';
import { findBase64Mentions } from '../core/base64-mentions.js';
import { type Base64Payload, identifyBase64 } from '../core/base64-payload.js';

/** Tag of the chip a confirmed payload becomes. */
export const BLOB_CHIP_TAG = 'slicc-blob-chip';

/** Event name the shell listens for to open a payload preview. */
export const BASE64_PREVIEW_OPEN_EVENT = 'base64-preview-open';

/** Detail carried by the event a chip click dispatches. */
export interface Base64PreviewOpenDetail {
  /** The decoded, identified payload. */
  payload: Base64Payload;
}

/**
 * Records WHAT was elided, not merely that something was — the same reasoning
 * as `file-mention-linker.ts`'s marker. A body element is reused across
 * re-renders, so a sticky boolean would permanently suppress processing of the
 * NEXT content to land in it.
 */
const PROCESSED_ATTR = 'data-base64-chips';

/** Cheap "is this the same rendered content?" stand-in. */
function contentFingerprint(root: HTMLElement): string {
  return `${root.childNodes.length}:${root.textContent?.length ?? 0}`;
}

/** Element names whose text is never a payload worth eliding. */
const SKIPPED_ANCESTORS = new Set(['A', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']);

/**
 * Lucide icon for a payload's top-level type. Only the families a reader
 * recognizes at a glance get their own glyph; everything else is a file.
 */
const ICON_BY_FAMILY: ReadonlyArray<readonly [string, string]> = [
  ['image/', 'image'],
  ['audio/', 'file-audio'],
  ['video/', 'file-video'],
  ['text/', 'file-text'],
];

function iconFor(mime: string): string {
  for (const [prefix, icon] of ICON_BY_FAMILY) {
    if (mime.startsWith(prefix)) return hasIcon(icon) ? icon : 'file';
  }
  return 'file';
}

/** A payload that decoded, positioned in the segment text it was found in. */
interface ConfirmedPayload {
  start: number;
  end: number;
  payload: Base64Payload;
}

/**
 * A maximal run of adjacent `Text` / `<br>` siblings, and the text they read as.
 *
 * The unit is a run rather than a single text node because of how a WRAPPED
 * payload arrives. `base64`(1) wraps at 76 columns, and the markdown renderer
 * runs with `breaks: true`, so a pasted block reaches the DOM as
 * `text <br> text <br> text` — one 76-character node per line, every one of
 * them far below the length bar. Walking text nodes individually cannot see
 * the payload at all; joining a run with `\n` for each `<br>` reconstructs
 * exactly the string the user pasted.
 *
 * Any other element (a `<strong>`, a `<code>`, a link) ENDS the run, because
 * across one of those the text was never contiguous to begin with.
 */
interface Segment {
  text: string;
  parts: Array<{ node: ChildNode; start: number; end: number }>;
}

/**
 * Replace every confirmed base64 payload inside `root` with a chip.
 *
 * Synchronous, and safe to call repeatedly on the same element.
 */
export function elideBase64Payloads(root: HTMLElement): void {
  const fingerprint = contentFingerprint(root);
  if (root.getAttribute(PROCESSED_ATTR) === fingerprint) return;

  for (const segment of collectSegments(root)) {
    // Decode first, keep only what identified. A segment whose candidates all
    // turn out to be unrecognizable bytes is left untouched — no split, no
    // marker, nothing the user can see.
    const confirmed: ConfirmedPayload[] = [];
    for (const candidate of findBase64Mentions(segment.text)) {
      const payload = identifyBase64(candidate.data, candidate.declaredMime);
      if (payload) confirmed.push({ start: candidate.start, end: candidate.end, payload });
    }
    if (confirmed.length === 0) continue;

    replaceWithChips(segment, confirmed);
  }

  // Fingerprint the POST-replacement content: swapping in chips changes the
  // node count, so recording the pre-swap value would make the next pass think
  // the body had changed.
  root.setAttribute(PROCESSED_ATTR, contentFingerprint(root));
}

/** Whether `el` sits inside something whose text is never a payload. */
function isSkipped(el: Element, root: HTMLElement): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (SKIPPED_ANCESTORS.has(cur.tagName)) return true;
    if (cur === root) return false;
  }
  return false;
}

/** Every segment under `root` that is eligible to contain a payload. */
function collectSegments(root: HTMLElement): Segment[] {
  const segments: Segment[] = [];
  // Every text node has exactly one parent, so visiting each element's DIRECT
  // children covers each of them exactly once.
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (isSkipped(el, root)) continue;
    let current: Segment | null = null;
    for (const child of el.childNodes) {
      const piece = segmentPiece(child);
      if (piece === null) {
        current = null;
        continue;
      }
      if (!current) {
        current = { text: '', parts: [] };
        segments.push(current);
      }
      const start = current.text.length;
      current.text += piece;
      current.parts.push({ node: child, start, end: current.text.length });
    }
  }
  return segments.filter((segment) => segment.text.length > 0);
}

/** What a child node contributes to its segment's text, or `null` if it breaks it. */
function segmentPiece(node: ChildNode): string | null {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
  // A `<br>` IS the newline the user typed — it reads as one, and it is the
  // only element a payload is allowed to span.
  if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') return '\n';
  return null;
}

/**
 * Rebuild a segment with its confirmed payloads swapped for chips.
 *
 * The whole run is replaced at once rather than node by node, because a single
 * payload can cover several nodes and the `<br>`s between them: those `<br>`s
 * are INSIDE the elided span and must disappear with it, or a collapsed block
 * would leave a stack of blank lines where its wrapping used to be.
 */
function replaceWithChips(segment: Segment, confirmed: readonly ConfirmedPayload[]): void {
  const anchor = segment.parts[0]?.node;
  const parent = anchor?.parentNode;
  if (!anchor || !parent) return;
  const doc = anchor.ownerDocument;
  if (!doc) return;

  const fragment = doc.createDocumentFragment();
  const emitted = new Set<number>();

  for (const part of segment.parts) {
    if (segmentPiece(part.node) === '\n' && part.node.nodeType === Node.ELEMENT_NODE) {
      const swallowed = confirmed.some((c) => c.start <= part.start && part.end <= c.end);
      if (!swallowed) fragment.appendChild(doc.createElement('br'));
      continue;
    }

    let cursor = part.start;
    for (const [index, span] of confirmed.entries()) {
      if (span.end <= part.start || span.start >= part.end) continue;
      const upTo = Math.min(Math.max(span.start, part.start), part.end);
      if (upTo > cursor) fragment.appendChild(doc.createTextNode(segment.text.slice(cursor, upTo)));
      if (!emitted.has(index)) {
        fragment.appendChild(createChip(doc, span.payload));
        emitted.add(index);
      }
      cursor = Math.max(cursor, Math.min(span.end, part.end));
    }
    if (cursor < part.end) {
      fragment.appendChild(doc.createTextNode(segment.text.slice(cursor, part.end)));
    }
  }

  parent.insertBefore(fragment, anchor);
  for (const part of segment.parts) part.node.remove();
}

function createChip(doc: Document, payload: Base64Payload): HTMLElement {
  const size = payload.bytes.byteLength;
  const chip = doc.createElement(BLOB_CHIP_TAG);
  chip.setAttribute('icon', iconFor(payload.mime));
  chip.setAttribute('label', `${shortMimeLabel(payload.mime)} · ${formatAttachmentSize(size)}`);
  // The chip's label is deliberately short, so the full type and the exact byte
  // count — the two things someone checking a payload actually wants — live in
  // the tooltip rather than being dropped.
  chip.title = `${payload.mime} · ${size.toLocaleString()} bytes\nClick to preview`;

  chip.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const detail: Base64PreviewOpenDetail = { payload };
    chip.dispatchEvent(
      new CustomEvent<Base64PreviewOpenDetail>(BASE64_PREVIEW_OPEN_EVENT, {
        detail,
        bubbles: true,
        // Composed so the event escapes the user bubble's shadow root — the
        // thread that listens for it is outside.
        composed: true,
      })
    );
  });

  return chip;
}
