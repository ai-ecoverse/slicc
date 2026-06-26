import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

export interface QuickLookOptions {
  path: string;
  content: string | ArrayBuffer;
  mimeType: string;
}

const STYLE = `
:host {
  position: fixed;
  inset: 0;
  z-index: 105;
  display: flex;
  align-items: center;
  justify-content: center;
}
.backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,.4);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.panel {
  position: relative;
  max-width: 80vw;
  max-height: 80vh;
  background: var(--canvas, #fff);
  border: 1px solid var(--line, #e1e1e1);
  border-radius: 12px;
  box-shadow: 0 18px 50px -12px rgba(10,10,10,.35), 0 4px 12px -4px rgba(10,10,10,.18);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: var(--ui);
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line, #e1e1e1);
  font-size: 13px;
  font-weight: 600;
  color: var(--ink, #131313);
  flex: 0 0 auto;
}
.x {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: var(--txt-3, #717171);
  cursor: pointer;
}
.x:hover {
  background: var(--ghost, rgba(0,0,0,.05));
  color: var(--ink, #131313);
}
.content {
  padding: 16px;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
pre {
  margin: 0;
  font-family: var(--mono, 'SF Mono', 'Fira Code', monospace);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--ink, #131313);
  max-height: 60vh;
  overflow: auto;
}
img {
  max-width: 100%;
  max-height: 70vh;
  object-fit: contain;
  display: block;
  margin: 0 auto;
}
audio {
  width: 100%;
  min-width: 300px;
}
video {
  max-width: 100%;
  max-height: 70vh;
  display: block;
  margin: 0 auto;
}
.fallback {
  text-align: center;
  padding: 32px 16px;
  color: var(--txt-3, #717171);
  font-size: 13px;
}
`;
const SHEET = sheet(STYLE);

let activeInstance: SliccQuickLook | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;

export class SliccQuickLook extends HTMLElement {
  #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  static open(opts: QuickLookOptions): void {
    SliccQuickLook.close();
    const el = document.createElement('slicc-quick-look') as SliccQuickLook;

    const filename = opts.path.split('/').pop() || opts.path;
    const backdrop = h('div', { class: 'backdrop' });
    const closeBtn = h('button', { class: 'x' });
    closeBtn.appendChild(iconEl('x', { size: 14 }));
    const header = h('div', { class: 'header' }, filename, closeBtn);
    const content = h('div', { class: 'content' });
    content.appendChild(el.#buildContent(opts));
    const panel = h('div', { class: 'panel' }, header, content);

    el.#root.append(backdrop, panel);
    document.body.appendChild(el);
    activeInstance = el;

    backdrop.addEventListener('click', () => el.#dismiss('backdrop'));
    closeBtn.addEventListener('click', () => el.#dismiss('close-button'));
    escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') el.#dismiss('escape');
    };
    document.addEventListener('keydown', escapeHandler);
  }

  static close(): void {
    if (activeInstance) {
      activeInstance.remove();
      activeInstance = null;
    }
    if (escapeHandler) {
      document.removeEventListener('keydown', escapeHandler);
      escapeHandler = null;
    }
  }

  #dismiss(reason: 'escape' | 'backdrop' | 'close-button'): void {
    this.dispatchEvent(
      new CustomEvent('quick-look-close', { bubbles: true, composed: true, detail: { reason } })
    );
    SliccQuickLook.close();
  }

  #buildContent(opts: QuickLookOptions): HTMLElement {
    const mime = opts.mimeType;

    if (mime.startsWith('text/') || mime === 'application/json') {
      const text =
        typeof opts.content === 'string' ? opts.content : new TextDecoder().decode(opts.content);
      return h('pre', null, text);
    }

    if (mime.startsWith('image/')) {
      const blob = new Blob(
        [typeof opts.content === 'string' ? new TextEncoder().encode(opts.content) : opts.content],
        { type: mime }
      );
      const img = document.createElement('img');
      img.src = URL.createObjectURL(blob);
      img.alt = opts.path.split('/').pop() || '';
      return img;
    }

    if (mime.startsWith('audio/')) {
      const blob = new Blob(
        [typeof opts.content === 'string' ? new TextEncoder().encode(opts.content) : opts.content],
        { type: mime }
      );
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = URL.createObjectURL(blob);
      return audio;
    }

    if (mime.startsWith('video/')) {
      const blob = new Blob(
        [typeof opts.content === 'string' ? new TextEncoder().encode(opts.content) : opts.content],
        { type: mime }
      );
      const video = document.createElement('video');
      video.controls = true;
      video.src = URL.createObjectURL(blob);
      return video;
    }

    const size = typeof opts.content === 'string' ? opts.content.length : opts.content.byteLength;
    return h(
      'div',
      { class: 'fallback' },
      `Preview not available for this file type (${formatSize(size)})`
    );
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

define('slicc-quick-look', SliccQuickLook);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-quick-look': SliccQuickLook;
  }
}
