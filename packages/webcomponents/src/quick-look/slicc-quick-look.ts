import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import { shortMimeLabel } from './mime-label.js';

export interface QuickLookOptions {
  path: string;
  content: string | ArrayBuffer;
  mimeType: string;

  text?: boolean;

  baseContent?: string;

  gitStatus?: string;

  rendered?: { mount: 'inline' | 'sandbox'; html: string };

  line?: number;
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
  width: min(1100px, 88vw);
  max-width: 88vw;
  max-height: 84vh;
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
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line, #e1e1e1);
  font-size: 13px;
  font-weight: 600;
  color: var(--ink, #131313);
  flex: 0 0 auto;
}
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dir { font-weight: 400; color: var(--txt-3, #717171); }
/* Type + git chips: same pill, different accent, so the header reads as one row
   of metadata rather than a pile of unrelated badges. */
.chip {
  flex: 0 0 auto;
  font-family: var(--mono, monospace);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: .02em;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--ghost, rgba(0,0,0,.05));
  color: var(--txt-3, #717171);
  border: 1px solid var(--line, #e1e1e1);
}
.chip--git { color: var(--amber, #b26b00); border-color: color-mix(in srgb, var(--amber, #b26b00) 40%, transparent); }
.toggle {
  flex: 0 0 auto;
  display: flex;
  border: 1px solid var(--line, #e1e1e1);
  border-radius: 7px;
  overflow: hidden;
}
.toggle button {
  border: none;
  background: transparent;
  font-family: var(--ui);
  font-size: 11.5px;
  padding: 3px 9px;
  color: var(--txt-3, #717171);
  cursor: pointer;
}
.toggle button[aria-pressed="true"] { background: var(--ghost, rgba(0,0,0,.06)); color: var(--ink, #131313); font-weight: 600; }
.x {
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
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
/* The rendered diffs view supplies its own scrolling and padding, so the
   content box gets out of its way when one is mounted. */
.content--rich { padding: 0; }
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
iframe {
  width: 100%;
  height: 70vh;
  border: 0;
  display: block;
}
/* The rendered document view. Deliberately plain prose chrome — this is a file
   preview, not a themed reader — but it must not inherit the mono/pre look. */
.rendered {
  font-family: var(--ui);
  font-size: 14px;
  line-height: 1.55;
  color: var(--ink, #131313);
  max-height: 62vh;
  overflow: auto;
}
.rendered > :first-child { margin-top: 0; }
.rendered > :last-child { margin-bottom: 0; }
.rendered h1, .rendered h2, .rendered h3, .rendered h4, .rendered h5, .rendered h6 {
  margin: 1.1em 0 .35em;
  line-height: 1.25;
}
.rendered h1 { font-size: 22px; }
.rendered h2 { font-size: 18px; }
.rendered h3 { font-size: 16px; }
.rendered p, .rendered ul, .rendered ol, .rendered blockquote { margin: 0 0 .7em; }
.rendered ul, .rendered ol { padding-left: 1.4em; }
.rendered a { color: var(--accent, #6d28d9); }
.rendered code {
  font-family: var(--mono, monospace);
  font-size: 12.5px;
  background: var(--ghost, rgba(0,0,0,.05));
  border-radius: 5px;
  padding: 1px 5px;
}
.rendered pre {
  max-height: none;
  background: var(--ghost, rgba(0,0,0,.05));
  border: 1px solid var(--line, #e1e1e1);
  border-radius: 8px;
  padding: 10px 12px;
}
.rendered pre code { background: none; padding: 0; }
.rendered blockquote {
  border-left: 3px solid var(--line, #e1e1e1);
  padding-left: 12px;
  color: var(--txt-2, #4a4a4a);
}
.rendered table { border-collapse: collapse; font-size: 13px; }
.rendered th, .rendered td { border: 1px solid var(--line, #e1e1e1); padding: 5px 10px; }
.rendered img { max-height: 40vh; }
/* A sandboxed document owns its own page box, so it gets the full panel. */
.rendered-frame { height: 70vh; }
.fallback {
  text-align: center;
  padding: 32px 16px;
  color: var(--txt-3, #717171);
  font-size: 13px;
}
.fallback code { font-family: var(--mono, monospace); font-size: 12px; }
`;
const SHEET = sheet(STYLE);

type ViewMode = 'rendered' | 'file' | 'diff';

const MODE_LABELS: Record<ViewMode, string> = {
  rendered: 'Preview',
  file: 'Source',
  diff: 'Diff',
};

function availableModes(opts: QuickLookOptions): ViewMode[] {
  const modes: ViewMode[] = [];
  if (opts.rendered) modes.push('rendered');
  if (isTextual(opts)) modes.push('file');
  if (opts.baseContent !== undefined) modes.push('diff');
  return modes;
}

function initialMode(opts: QuickLookOptions): ViewMode {
  if (opts.rendered) return 'rendered';
  return opts.baseContent !== undefined ? 'diff' : 'file';
}

let activeInstance: SliccQuickLook | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;

function isTextual(opts: QuickLookOptions): boolean {
  if (opts.text === true) return true;
  const base = opts.mimeType.split(';', 1)[0]?.trim() ?? opts.mimeType;
  if (base.startsWith('text/')) return true;
  return (
    base === 'application/json' ||
    base === 'application/xml' ||
    base === 'application/javascript' ||
    base === 'image/svg+xml' ||
    base.endsWith('+json') ||
    base.endsWith('+xml')
  );
}

function decode(content: string | ArrayBuffer): string {
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
}

function toBlob(content: string | ArrayBuffer, mime: string): Blob {
  const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return new Blob([data], { type: mime });
}

let extensionsRegistered = false;
function registerSliccExtensions(mod: typeof import('@pierre/diffs')): void {
  if (extensionsRegistered) return;
  extensionsRegistered = true;
  for (const ext of ['jsh', 'bsh']) {
    try {
      mod.setCustomExtension(ext, 'zsh');
    } catch {}
  }
}

function sandboxDocument(html: string, theme: 'dark' | 'light'): string {
  const base = `<style>:root{color-scheme:${theme};}html{background:Canvas;color:CanvasText;}</style>`;

  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (!doctype) return base + html;
  return html.slice(0, doctype[0].length) + base + html.slice(doctype[0].length);
}

function currentThemeType(): 'dark' | 'light' {
  const root = document.documentElement;
  const declared = root.dataset.theme ?? root.getAttribute('data-theme') ?? '';
  if (declared.includes('dark')) return 'dark';
  if (declared.includes('light')) return 'light';
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export class SliccQuickLook extends HTMLElement {
  #root: ShadowRoot;
  #blobUrls: string[] = [];

  #generation = 0;
  #options: QuickLookOptions | null = null;
  #contentBox: HTMLElement | null = null;
  #mode: ViewMode = 'file';

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  disconnectedCallback(): void {
    for (const url of this.#blobUrls) URL.revokeObjectURL(url);
    this.#blobUrls.length = 0;
    if (activeInstance === this) activeInstance = null;
  }

  static open(opts: QuickLookOptions): void {
    SliccQuickLook.close();
    const el = document.createElement('slicc-quick-look') as SliccQuickLook;
    el.#options = opts;
    el.#generation += 1;
    el.#mode = initialMode(opts);

    const filename = opts.path.split('/').pop() || opts.path;
    const dir = opts.path.slice(0, opts.path.length - filename.length);

    const backdrop = h('div', { class: 'backdrop' });
    const closeBtn = h('button', { class: 'x' });
    closeBtn.setAttribute('aria-label', 'Close preview');
    closeBtn.appendChild(iconEl('x', { size: 14 }));

    const name = h('div', { class: 'name' }, h('span', { class: 'dir' }, dir), filename);
    const header = h('div', { class: 'header' }, name);

    header.appendChild(h('span', { class: 'chip' }, shortMimeLabel(opts.mimeType)));
    if (opts.gitStatus) {
      header.appendChild(h('span', { class: 'chip chip--git' }, opts.gitStatus));
    }
    const modes = availableModes(opts);
    if (modes.length > 1) header.appendChild(el.#buildModeToggle(modes));
    header.appendChild(closeBtn);

    const content = h('div', { class: 'content' });
    el.#contentBox = content;
    el.#applyMode();

    const panel = h('div', { class: 'panel' }, header, content) as HTMLElement;
    panel.tabIndex = -1;

    el.#root.append(backdrop, panel);
    document.body.appendChild(el);
    activeInstance = el;
    panel.focus();

    backdrop.addEventListener('click', () => el.#dismiss('backdrop'));
    closeBtn.addEventListener('click', () => el.#dismiss('close-button'));
    if (escapeHandler) {
      document.removeEventListener('keydown', escapeHandler);
    }
    escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') el.#dismiss('escape');
    };
    document.addEventListener('keydown', escapeHandler);
  }

  static close(): void {
    if (activeInstance) {
      for (const url of activeInstance.#blobUrls) {
        URL.revokeObjectURL(url);
      }
      activeInstance.remove();
      activeInstance = null;
    }
    if (escapeHandler) {
      document.removeEventListener('keydown', escapeHandler);
      escapeHandler = null;
    }
  }

  #buildModeToggle(modes: readonly ViewMode[]): HTMLElement {
    const buttons = modes.map((mode) => h('button', { type: 'button' }, MODE_LABELS[mode]));
    const setPressed = (): void => {
      for (const [i, mode] of modes.entries()) {
        buttons[i]?.setAttribute('aria-pressed', String(this.#mode === mode));
      }
    };
    setPressed();

    for (const [i, mode] of modes.entries()) {
      buttons[i]?.addEventListener('click', () => {
        if (this.#mode === mode) return;
        this.#mode = mode;
        setPressed();
        this.#applyMode();
      });
    }

    return h('div', { class: 'toggle' }, ...buttons);
  }

  #applyMode(): void {
    const opts = this.#options;
    const box = this.#contentBox;
    if (!opts || !box) return;

    box.replaceChildren(this.#buildContent(opts));

    box.classList.toggle(
      'content--rich',
      this.#mode === 'rendered' && opts.rendered?.mount === 'sandbox'
    );
    if (this.#mode !== 'rendered' && isTextual(opts)) void this.#enhance(this.#generation);
  }

  #buildRendered(opts: QuickLookOptions): HTMLElement {
    const rendered = opts.rendered;
    if (!rendered) return h('pre', null, decode(opts.content));

    if (rendered.mount === 'sandbox') {
      const frame = document.createElement('iframe');

      frame.setAttribute('sandbox', '');
      frame.srcdoc = sandboxDocument(rendered.html, currentThemeType());
      frame.title = `${opts.path.split('/').pop() || opts.path} preview`;
      frame.className = 'rendered-frame';
      return frame;
    }

    const host = h('div', { class: 'rendered' });
    const range = this.ownerDocument.createRange();
    range.selectNodeContents(host);
    host.appendChild(range.createContextualFragment(rendered.html));
    return host;
  }

  #dismiss(reason: 'escape' | 'backdrop' | 'close-button'): void {
    this.dispatchEvent(
      new CustomEvent('quick-look-close', { bubbles: true, composed: true, detail: { reason } })
    );
    SliccQuickLook.close();
  }

  async #enhance(generation: number): Promise<void> {
    const opts = this.#options;
    const box = this.#contentBox;
    if (!opts || !box) return;

    let mod: typeof import('@pierre/diffs');
    try {
      mod = await import('@pierre/diffs');
    } catch {
      return;
    }
    registerSliccExtensions(mod);
    if (generation !== this.#generation || !this.isConnected) return;

    const name = opts.path.split('/').pop() || opts.path;
    const contents = decode(opts.content);
    const codeOptions = {
      themeType: currentThemeType(),
      theme: { dark: 'github-dark', light: 'github-light' } as const,
      stickyHeader: false,
      disableFileHeader: true,
    };

    const mount = h('div');
    try {
      if (this.#mode === 'diff' && opts.baseContent !== undefined) {
        const diff = new mod.FileDiff({ ...codeOptions, diffStyle: 'unified' });
        diff.render({
          oldFile: { name, contents: opts.baseContent },
          newFile: { name, contents },
          containerWrapper: mount,
        });

        if (opts.line !== undefined) {
          diff.setSelectedLines({ start: opts.line, end: opts.line, side: 'additions' });
        }
      } else {
        const file = new mod.File(codeOptions);
        file.render({ file: { name, contents }, containerWrapper: mount });
        if (opts.line !== undefined) file.setSelectedLines({ start: opts.line, end: opts.line });
      }
    } catch {
      return;
    }

    if (generation !== this.#generation || !this.isConnected) return;
    box.classList.add('content--rich');
    box.replaceChildren(mount);
  }

  #buildContent(opts: QuickLookOptions): HTMLElement {
    const mime = opts.mimeType;

    if (this.#mode === 'rendered') return this.#buildRendered(opts);

    if (isTextual(opts)) {
      return h('pre', null, decode(opts.content));
    }

    if (mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = this.#objectUrl(opts.content, mime);
      img.alt = opts.path.split('/').pop() || '';
      return img;
    }

    if (mime.startsWith('audio/')) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = this.#objectUrl(opts.content, mime);
      return audio;
    }

    if (mime.startsWith('video/')) {
      const video = document.createElement('video');
      video.controls = true;
      video.src = this.#objectUrl(opts.content, mime);
      return video;
    }

    if (mime === 'application/pdf') {
      const frame = document.createElement('iframe');
      frame.src = this.#objectUrl(opts.content, mime);
      frame.title = opts.path.split('/').pop() || 'PDF preview';
      return frame;
    }

    const size = typeof opts.content === 'string' ? opts.content.length : opts.content.byteLength;
    return h(
      'div',
      { class: 'fallback' },
      h('div', null, `Preview not available for this file type (${formatSize(size)})`),
      h('div', { style: 'margin-top:6px;' }, h('code', null, mime))
    );
  }

  #objectUrl(content: string | ArrayBuffer, mime: string): string {
    const url = URL.createObjectURL(toBlob(content, mime));
    this.#blobUrls.push(url);
    return url;
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
