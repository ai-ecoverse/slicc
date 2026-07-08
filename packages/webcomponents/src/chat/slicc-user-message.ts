import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import { SliccImagePreview } from '../primitives/slicc-image-preview.js';

/**
 * Shared constructable stylesheet, lifted from the prototype's chat rules:
 *
 * - `.msg` — the message row metrics (`margin-bottom`, `line-height`).
 * - `.msg.user` — flex row, right-aligned (`justify-content:flex-end`).
 * - `.stack` — a right-aligned column holding the optional attachment row above
 *   the bubble, both capped at 80% of the column.
 * - `.msg.user .b` — the inverted iMessage bubble: `--deep` ground, white text,
 *   asymmetric `16px 16px 4px 16px` radius.
 *
 * The bubble also carries a compact markdown chrome (paragraphs, lists, inline
 * code + fenced blocks, links, blockquotes, headings) so rendered-markdown HTML
 * handed to `setBodyHtml` styles correctly. Every markdown surface is keyed off
 * `currentColor`, so it stays legible whether the bubble text is white (light)
 * or dark (dark mode, where `--deep` flips toward white).
 *
 * Attachments mirror the webapp's `.attachment-chip` (visual + name + meta),
 * with image attachments rendered as a thumbnail.
 *
 * Dark mode: the prototype flips `--deep` to a near-white in `body.dark`, so the
 * bubble text is overridden to `#0a0a0a` to stay readable. Shadow DOM does not
 * see the ancestor `body.dark` selector, so we re-express that override with
 * `:host-context()` plus the package's `.dark` / `[data-theme="dark"]` scopes.
 */
const STYLE = `
:host{display:block;margin-bottom:18px;font-family:var(--ui);font-size:15px;line-height:1.5;}
:host([hidden]){display:none;}
.msg{display:flex;justify-content:flex-end;}
.stack{display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:80%;}
.ts{font-size:10px;color:var(--txt-3);opacity:.7;margin-bottom:2px;font-variant-numeric:tabular-nums;}
.b{background:var(--deep);color:#fff;padding:10px 14px;border-radius:16px 16px 4px 16px;font-size:14px;max-width:100%;}
:host-context(body.dark) .b,
:host-context(.dark) .b,
:host-context([data-theme="dark"]) .b{color:#0a0a0a;}
/* markdown chrome inside the bubble — all currentColor-relative so it adapts to the theme flip */
.b > :first-child{margin-top:0;}
.b > :last-child{margin-bottom:0;}
.b p{margin:0 0 8px;}
.b strong,.b b{font-weight:600;}
.b a{color:inherit;text-decoration:underline;}
/* Code inside the dark bubble: the wash leans on the active context accent
   (--ctx) instead of plain currentColor; the text keeps the bubble's light
   ink, so the translucent tint never costs contrast. */
.b code{font-family:var(--mono);font-size:12.5px;background:color-mix(in srgb,var(--ctx) 32%,transparent);border-radius:6px;padding:1px 6px;}
.b pre{margin:8px 0;background:color-mix(in srgb,var(--ctx) 22%,transparent);border-left:3px solid color-mix(in srgb,var(--ctx) 60%,transparent);border-radius:8px;padding:9px 11px;overflow-x:auto;font-family:var(--mono);font-size:12.5px;line-height:1.55;white-space:pre-wrap;}
.b pre code{background:none;padding:0;border-radius:0;font-size:inherit;}
.b ul,.b ol{margin:6px 0;padding-left:1.3em;}
.b li{margin:2px 0;}
.b blockquote{margin:6px 0;border-left:3px solid color-mix(in srgb,currentColor 45%,transparent);padding-left:10px;}
.b h1,.b h2,.b h3,.b h4{margin:8px 0 4px;font-weight:700;line-height:1.25;}
.b h1{font-size:18px;}.b h2{font-size:16px;}.b h3,.b h4{font-size:14px;}
/* attachment chips — mirror the webapp's .attachment-chip structure */
.attachments{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;}
.attachment-chip{display:inline-flex;align-items:center;gap:8px;max-width:240px;padding:6px 9px;border:1px solid var(--line);border-radius:10px;background:var(--ghost);font-family:var(--ui);}
.attachment-chip__visual{display:inline-flex;flex:0 0 auto;width:30px;height:30px;border-radius:7px;overflow:hidden;align-items:center;justify-content:center;background:var(--bg);color:var(--txt-2);}
.attachment-chip__visual img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in;}
.attachment-chip__visual svg{display:block;}
.attachment-chip__body{display:flex;flex-direction:column;min-width:0;}
.attachment-chip__name{font-size:12px;color:var(--ink);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.attachment-chip__meta{font-size:10.5px;color:var(--txt-3);}
/* Queued (not yet sent — the agent is mid-turn): the bubble dims and a small
   clock tag sits under it, so pending input reads distinctly from sent input. */
:host([queued]) .b{opacity:.62;}
.queued-tag{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--txt-3);}
.queued-tag svg{display:block;}
`;
const SHEET = sheet(STYLE);

/** Kind of a user-message attachment — mirrors the webapp's `MessageAttachmentKind`. */
export type UserAttachmentKind = 'image' | 'text' | 'file';

/** A single attachment shown above a user bubble (image thumbnail or file chip). */
export interface UserAttachment {
  /** File / attachment name. */
  name: string;
  /** Attachment kind — `image` renders a thumbnail, others a lucide icon chip. */
  kind?: UserAttachmentKind;
  /** Image source (data: URL or path) for `image` attachments. */
  src?: string;
  /** MIME type, shown in the chip meta line. */
  mime?: string;
  /** Byte size, formatted into the chip meta line. */
  size?: number;
}

/** Lucide icon name for a non-image attachment chip. */
const ATTACHMENT_ICON: Record<UserAttachmentKind, string> = {
  image: 'image',
  text: 'file-text',
  file: 'file',
};

/** Format a byte count into a compact `B` / `KB` / `MB` string (webapp parity). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `<slicc-user-message>` — the user's chat bubble from the prototype
 * (`.msg.user > .b`). An inverted iMessage-style bubble: a `--deep` ground with
 * white text, an asymmetric `16px 16px 4px 16px` radius, capped at 80% of the
 * column and right-aligned by the host's flex row. The bubble text comes from
 * the `text` attribute, from rendered-markdown HTML supplied via `setBodyHtml`,
 * or from slotted content when both are absent.
 *
 * Attachments (images / files) supplied via `setAttachments` render as a
 * right-aligned chip row above the bubble, mirroring the webapp's
 * `.attachment-chip` (image thumbnail or lucide file icon + name + meta). When
 * an image attachment is present with no text the bubble is omitted.
 *
 * Self-contained shadow DOM; themes via inherited tokens (`--deep`, `--ui`,
 * `--ghost`, `--line`, `--bg`, `--ink`, `--txt-2/3`, `--mono`). In dark mode the
 * prototype flips `--deep` toward white, so the bubble text is overridden to
 * `#0a0a0a`; the markdown chrome is `currentColor`-relative so it follows suit.
 *
 * @attr text - the bubble message text (escaped); falls back to slotted content
 * @attr queued - boolean; the message is queued behind the current turn —
 *   dims the bubble and shows a small "queued" clock tag under it
 * @csspart message - the flex row wrapper (`.msg.user`)
 * @csspart stack - the right-aligned column (attachments + bubble)
 * @csspart attachments - the attachment chip row
 * @csspart bubble - the bubble (`.b`)
 * @slot - bubble content, used when neither `text` nor `setBodyHtml` is set
 */
export class SliccUserMessage extends HTMLElement {
  static readonly observedAttributes = ['text', 'queued', 'timestamp'];

  readonly #root: ShadowRoot;
  /** Rendered-markdown HTML for the bubble; wins over `text` / slot when set. */
  #bodyHtml: string | null = null;
  /** Attachments rendered as a chip row above the bubble. */
  #attachments: readonly UserAttachment[] = [];

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /** Bubble message text; when absent, slotted content is rendered instead. */
  get text(): string | null {
    return this.getAttribute('text');
  }

  set text(value: string | null) {
    if (value == null) this.removeAttribute('text');
    else this.setAttribute('text', value);
  }

  /** Whether the message is queued behind the current turn (reflected). */
  get queued(): boolean {
    return this.hasAttribute('queued');
  }

  set queued(value: boolean) {
    this.toggleAttribute('queued', value);
  }

  /**
   * Replace the bubble content with already-rendered (trusted) markdown HTML —
   * the same shape the webapp's marked/DOMPurify renderer produces. Callers are
   * responsible for sanitizing untrusted input; the string is parsed via a
   * contextual fragment (no HTML sink). Wins over the `text` attribute and slot.
   */
  setBodyHtml(html: string): void {
    this.#bodyHtml = html;
    this.#render();
  }

  /** Set the attachments rendered as a chip row above the bubble (replaces any). */
  setAttachments(items: readonly UserAttachment[]): void {
    this.#attachments = items.slice();
    this.#render();
  }

  /** Build the bubble body: rendered markdown HTML > `text` > the default slot. */
  #bubbleBody(): Node {
    if (this.#bodyHtml != null) {
      const range = this.ownerDocument.createRange();
      return range.createContextualFragment(this.#bodyHtml);
    }
    const text = this.text;
    return text != null ? this.ownerDocument.createTextNode(text) : h('slot');
  }

  /** Build one `.attachment-chip` — an image thumbnail or a lucide file chip. */
  #attachmentChip(att: UserAttachment): HTMLElement {
    const kind = att.kind ?? 'file';
    const visual = h('span', { class: 'attachment-chip__visual' });
    if (kind === 'image' && att.src) {
      const img = h('img', { src: att.src, alt: att.name || 'Attached image' }) as HTMLImageElement;
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        SliccImagePreview.show(att.src!, img);
      });
      visual.append(img);
    } else {
      visual.append(iconEl(ATTACHMENT_ICON[kind], { size: 16 }));
    }

    const meta = att.size != null ? `${att.mime || 'file'} · ${formatSize(att.size)}` : att.mime;
    const body = h(
      'span',
      { class: 'attachment-chip__body' },
      h('span', { class: 'attachment-chip__name' }, att.name),
      meta ? h('span', { class: 'attachment-chip__meta' }, meta) : null
    );

    return h('div', { class: `attachment-chip attachment-chip--${kind}` }, visual, body);
  }

  #render(): void {
    const hasAttachments = this.#attachments.length > 0;
    const hasText = this.text != null || this.#bodyHtml != null;
    const hasSlotted = this.childNodes.length > 0;
    // Show the bubble unless this is a pure-attachment message (no text / slot).
    const showBubble = hasText || hasSlotted || !hasAttachments;

    const stack = h('div', { class: 'stack', part: 'stack' });
    const ts = this.getAttribute('timestamp');
    if (ts) {
      stack.append(h('span', { class: 'ts', part: 'timestamp' }, ts));
    }
    if (hasAttachments) {
      const list = h('div', { class: 'attachments', part: 'attachments' });
      for (const att of this.#attachments) list.append(this.#attachmentChip(att));
      stack.append(list);
    }
    if (showBubble) {
      stack.append(h('div', { class: 'b', part: 'bubble' }, this.#bubbleBody()));
    }
    if (this.queued) {
      stack.append(
        h('span', { class: 'queued-tag', part: 'queued' }, iconEl('clock', { size: 11 }), 'queued')
      );
    }

    const row = h('div', { class: 'msg user', part: 'message' }, stack);
    this.#root.replaceChildren(row);
  }
}

define('slicc-user-message', SliccUserMessage);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-user-message': SliccUserMessage;
  }
}
