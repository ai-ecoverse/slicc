import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import { SliccImagePreview } from '../primitives/slicc-image-preview.js';

const STYLE = `
:host{display:block;margin-bottom:18px;font-family:var(--ui);font-size:15px;line-height:1.5;}
:host([hidden]){display:none;}
.msg{display:flex;justify-content:flex-end;}
.stack{display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:80%;}
.ts{font-size:10px;color:var(--txt-3);opacity:.7;margin-bottom:2px;font-variant-numeric:tabular-nums;}
/* An unbroken run with no break opportunity — a pasted base64 payload, a long
   token — has no width the bubble can honour, so max-width alone does not
   contain it: the run overflows and drags the whole chat column sideways.
   overflow-wrap:anywhere is what gives the line breaker permission mid-token
   AND shrinks the bubble's intrinsic min-width, so the 80% cap becomes real.
   Set on .b so every markdown surface inherits it; fenced code opts back OUT
   below, where scrolling inside the block beats mangling the source. */
.b{background:var(--deep);color:#fff;padding:10px 14px;border-radius:16px 16px 4px 16px;font-size:14px;max-width:100%;overflow-wrap:anywhere;word-break:break-word;}
:host-context(body.dark) .b,
:host-context(.dark) .b,
:host-context([data-theme="dark"]) .b{color:#0a0a0a;}
/* markdown chrome inside the bubble — all currentColor-relative so it adapts to the theme flip */
.b > :first-child{margin-top:0;}
.b > :last-child{margin-bottom:0;}
.b p{margin:0 0 8px;}
.b strong,.b b{font-weight:600;}
.b a{color:inherit;text-decoration:underline;overflow-wrap:anywhere;}
/* Code inside the dark bubble: the wash leans on the active context accent
   (--ctx) instead of plain currentColor; the text keeps the bubble's light
   ink, so the translucent tint never costs contrast. */
.b code{font-family:var(--mono);font-size:12.5px;background:color-mix(in srgb,var(--ctx) 32%,transparent);border-radius:6px;padding:1px 6px;overflow-wrap:anywhere;word-break:break-word;}
.b pre{margin:8px 0;background:color-mix(in srgb,var(--ctx) 22%,transparent);border-left:3px solid color-mix(in srgb,var(--ctx) 60%,transparent);border-radius:8px;padding:9px 11px;overflow-x:auto;font-family:var(--mono);font-size:12.5px;line-height:1.55;white-space:pre-wrap;}
.b pre code{background:none;padding:0;border-radius:0;font-size:inherit;overflow-wrap:normal;word-break:normal;}
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

export type UserAttachmentKind = 'image' | 'text' | 'file';

export interface UserAttachment {
  name: string;

  kind?: UserAttachmentKind;

  src?: string;

  mime?: string;

  size?: number;
}

const ATTACHMENT_ICON: Record<UserAttachmentKind, string> = {
  image: 'image',
  text: 'file-text',
  file: 'file',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class SliccUserMessage extends HTMLElement {
  static readonly observedAttributes = ['text', 'queued', 'timestamp'];

  readonly #root: ShadowRoot;

  #bodyHtml: string | null = null;

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

  get text(): string | null {
    return this.getAttribute('text');
  }

  set text(value: string | null) {
    if (value == null) this.removeAttribute('text');
    else this.setAttribute('text', value);
  }

  get queued(): boolean {
    return this.hasAttribute('queued');
  }

  set queued(value: boolean) {
    this.toggleAttribute('queued', value);
  }

  setBodyHtml(html: string): void {
    this.#bodyHtml = html;
    this.#render();
  }

  setAttachments(items: readonly UserAttachment[]): void {
    this.#attachments = items.slice();
    this.#render();
  }

  #bubbleBody(): Node {
    if (this.#bodyHtml != null) {
      const range = this.ownerDocument.createRange();
      return range.createContextualFragment(this.#bodyHtml);
    }
    const text = this.text;
    return text != null ? this.ownerDocument.createTextNode(text) : h('slot');
  }

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
