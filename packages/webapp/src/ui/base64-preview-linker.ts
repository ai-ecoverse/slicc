import { hasIcon } from '@slicc/webcomponents';
import { shortMimeLabel } from '@slicc/webcomponents/quick-look/mime-label';
import { formatAttachmentSize } from '../core/attachments.js';
import { findBase64Mentions } from '../core/base64-mentions.js';
import { type Base64Payload, identifyBase64 } from '../core/base64-payload.js';

export const BLOB_CHIP_TAG = 'slicc-blob-chip';

export const BASE64_PREVIEW_OPEN_EVENT = 'base64-preview-open';

export interface Base64PreviewOpenDetail {
  payload: Base64Payload;
}

const PROCESSED_ATTR = 'data-base64-chips';

function contentFingerprint(root: HTMLElement): string {
  return `${root.childNodes.length}:${root.textContent?.length ?? 0}`;
}

const SKIPPED_ANCESTORS = new Set(['A', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']);

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

interface ConfirmedPayload {
  start: number;
  end: number;
  payload: Base64Payload;
}

interface Segment {
  text: string;
  parts: Array<{ node: ChildNode; start: number; end: number }>;
}

export function elideBase64Payloads(root: HTMLElement): void {
  const fingerprint = contentFingerprint(root);
  if (root.getAttribute(PROCESSED_ATTR) === fingerprint) return;

  for (const segment of collectSegments(root)) {
    const confirmed: ConfirmedPayload[] = [];
    for (const candidate of findBase64Mentions(segment.text)) {
      const payload = identifyBase64(candidate.data, candidate.declaredMime);
      if (payload) confirmed.push({ start: candidate.start, end: candidate.end, payload });
    }
    if (confirmed.length === 0) continue;

    replaceWithChips(segment, confirmed);
  }

  root.setAttribute(PROCESSED_ATTR, contentFingerprint(root));
}

function isSkipped(el: Element, root: HTMLElement): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (SKIPPED_ANCESTORS.has(cur.tagName)) return true;
    if (cur === root) return false;
  }
  return false;
}

function collectSegments(root: HTMLElement): Segment[] {
  const segments: Segment[] = [];

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

function segmentPiece(node: ChildNode): string | null {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';

  if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') return '\n';
  return null;
}

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

  chip.title = `${payload.mime} · ${size.toLocaleString()} bytes\nClick to preview`;

  chip.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const detail: Base64PreviewOpenDetail = { payload };
    chip.dispatchEvent(
      new CustomEvent<Base64PreviewOpenDetail>(BASE64_PREVIEW_OPEN_EVENT, {
        detail,
        bubbles: true,

        composed: true,
      })
    );
  });

  return chip;
}
