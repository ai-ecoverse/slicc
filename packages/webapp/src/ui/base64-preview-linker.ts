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

/**
 * Replace every confirmed base64 payload inside `root` with a chip.
 *
 * Synchronous, and safe to call repeatedly on the same element.
 */
export function elideBase64Payloads(root: HTMLElement): void {
  const fingerprint = contentFingerprint(root);
  if (root.getAttribute(PROCESSED_ATTR) === fingerprint) return;

  for (const node of collectTextNodes(root)) {
    const candidates = findBase64Mentions(node.data);
    if (candidates.length === 0) continue;

    // Decode first, keep only what identified. A node whose candidates all
    // turn out to be unrecognizable bytes is left untouched — no split, no
    // marker, nothing the user can see.
    const confirmed: Array<{ start: number; end: number; payload: Base64Payload }> = [];
    for (const candidate of candidates) {
      const payload = identifyBase64(candidate.data, candidate.declaredMime);
      if (payload) confirmed.push({ start: candidate.start, end: candidate.end, payload });
    }
    if (confirmed.length === 0) continue;

    replaceWithChips(node, confirmed);
  }

  // Fingerprint the POST-replacement content: swapping in chips changes the
  // node count, so recording the pre-swap value would make the next pass think
  // the body had changed.
  root.setAttribute(PROCESSED_ATTR, contentFingerprint(root));
}

/** Every text node under `root` that is eligible to contain a payload. */
function collectTextNodes(root: HTMLElement): Text[] {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (!node.nodeValue || node.nodeValue.length === 0) return NodeFilter.FILTER_REJECT;
      for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
        if (SKIPPED_ANCESTORS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
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

/** Split one text node into text + chip fragments and swap it into the DOM. */
function replaceWithChips(
  node: Text,
  confirmed: ReadonlyArray<{ start: number; end: number; payload: Base64Payload }>
): void {
  const doc = node.ownerDocument;
  const text = node.data;
  const fragment = doc.createDocumentFragment();
  let cursor = 0;

  for (const { start, end, payload } of confirmed) {
    if (start > cursor) fragment.appendChild(doc.createTextNode(text.slice(cursor, start)));
    fragment.appendChild(createChip(doc, payload));
    cursor = end;
  }

  if (cursor < text.length) fragment.appendChild(doc.createTextNode(text.slice(cursor)));
  node.parentNode?.replaceChild(fragment, node);
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
