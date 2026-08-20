/**
 * Quick Look — the file previewer.
 *
 * ## Two-stage rendering
 *
 * Text is shown TWICE: a plain `<pre>` lands synchronously in `open()`, and the
 * syntax-highlighted `@pierre/diffs` view replaces it once that library has
 * loaded. The split is deliberate. `@pierre/diffs` carries Shiki and pulls a
 * grammar chunk per language, which is far too much to block the overlay on —
 * but reading the file is the point of the overlay, so the text cannot wait for
 * it either. Staging means the preview is never empty and never slow, and if the
 * import fails outright (offline, a realm with no dynamic import) the `<pre>`
 * simply stays: a degraded preview, not a broken one.
 *
 * ## Type handling
 *
 * The component renders what it is TOLD to render — callers pass a `mimeType`
 * they sniffed from the bytes (`core/file-type.ts`), rather than this component
 * re-deriving one from the extension. That is what fixed `.jsh`: the old code
 * keyed off a hardcoded extension table, so any unknown extension fell through
 * to "Preview not available" even when the bytes were plainly text. The
 * `text` option lets a caller assert readability directly when it knows better
 * than the MIME string does.
 *
 * ## Git awareness
 *
 * When a caller supplies `baseContent` (the committed version of a modified
 * file), the preview opens on the DIFF rather than the file, because for a file
 * with uncommitted changes "what changed" is almost always the question being
 * asked. A toggle switches back to the whole file.
 */

import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

export interface QuickLookOptions {
  path: string;
  content: string | ArrayBuffer;
  mimeType: string;
  /**
   * Force text treatment regardless of `mimeType`. Set by callers that sniffed
   * the bytes and know the file is readable even though its type is unregistered.
   */
  text?: boolean;
  /**
   * The committed contents of this file, when it has uncommitted changes.
   * Supplying it opens the preview in diff mode.
   */
  baseContent?: string;
  /** Short git status label shown in the header (`modified`, `staged`, …). */
  gitStatus?: string;
  /** 1-based line to scroll to and highlight. */
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
.fallback {
  text-align: center;
  padding: 32px 16px;
  color: var(--txt-3, #717171);
  font-size: 13px;
}
.fallback code { font-family: var(--mono, monospace); font-size: 12px; }
`;
const SHEET = sheet(STYLE);

let activeInstance: SliccQuickLook | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;

/**
 * Whether the payload should be shown as text.
 *
 * `text/*` and the `application/` types that are text underneath (JSON, XML,
 * JavaScript, SVG) all qualify, as does an explicit `text: true` from a caller
 * that sniffed the bytes.
 */
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

/**
 * Teach the highlighter about SLICC's own script extensions.
 *
 * `@pierre/diffs` infers a language from the FILE NAME, and its table (Shiki's)
 * has never heard of `.jsh` / `.bsh` — SLICC's shell scripts — so they would
 * render as unhighlighted plain text even though they are shell. Registering
 * them maps onto the same grammar `.sh` uses. Idempotent, and deferred until the
 * library is actually loaded so it costs nothing for users who never preview.
 */
let extensionsRegistered = false;
function registerSliccExtensions(mod: typeof import('@pierre/diffs')): void {
  if (extensionsRegistered) return;
  extensionsRegistered = true;
  for (const ext of ['jsh', 'bsh']) {
    try {
      mod.setCustomExtension(ext, 'zsh');
    } catch {
      // A future version may drop the API or the grammar; unhighlighted is fine.
    }
  }
}

/** The theme half `@pierre/diffs` should render for, read off the live document. */
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
  /** Bumped on every open so a late async upgrade can tell it is stale. */
  #generation = 0;
  #options: QuickLookOptions | null = null;
  #contentBox: HTMLElement | null = null;
  #mode: 'diff' | 'file' = 'file';

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
    el.#mode = opts.baseContent !== undefined ? 'diff' : 'file';

    const filename = opts.path.split('/').pop() || opts.path;
    const dir = opts.path.slice(0, opts.path.length - filename.length);

    const backdrop = h('div', { class: 'backdrop' });
    const closeBtn = h('button', { class: 'x' });
    closeBtn.setAttribute('aria-label', 'Close preview');
    closeBtn.appendChild(iconEl('x', { size: 14 }));

    const name = h('div', { class: 'name' }, h('span', { class: 'dir' }, dir), filename);
    const header = h('div', { class: 'header' }, name);

    // A type chip earns its space because the whole point of sniffing is that
    // the extension may not tell you what a file is.
    header.appendChild(h('span', { class: 'chip' }, shortType(opts)));
    if (opts.gitStatus) {
      header.appendChild(h('span', { class: 'chip chip--git' }, opts.gitStatus));
    }
    if (opts.baseContent !== undefined) {
      header.appendChild(el.#buildModeToggle());
    }
    header.appendChild(closeBtn);

    const content = h('div', { class: 'content' });
    el.#contentBox = content;
    content.appendChild(el.#buildContent(opts));

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

    // Upgrade the plain text baseline to the highlighted view. Fire-and-forget:
    // failure leaves the `<pre>` in place, which is a usable preview.
    if (isTextual(opts)) void el.#enhance(el.#generation);
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

  #buildModeToggle(): HTMLElement {
    const diffBtn = h('button', { type: 'button' }, 'Diff');
    const fileBtn = h('button', { type: 'button' }, 'File');
    const setPressed = (): void => {
      diffBtn.setAttribute('aria-pressed', String(this.#mode === 'diff'));
      fileBtn.setAttribute('aria-pressed', String(this.#mode === 'file'));
    };
    setPressed();

    const switchTo = (mode: 'diff' | 'file') => () => {
      if (this.#mode === mode) return;
      this.#mode = mode;
      setPressed();
      void this.#enhance(this.#generation);
    };
    diffBtn.addEventListener('click', switchTo('diff'));
    fileBtn.addEventListener('click', switchTo('file'));

    return h('div', { class: 'toggle' }, diffBtn, fileBtn);
  }

  #dismiss(reason: 'escape' | 'backdrop' | 'close-button'): void {
    this.dispatchEvent(
      new CustomEvent('quick-look-close', { bubbles: true, composed: true, detail: { reason } })
    );
    SliccQuickLook.close();
  }

  /**
   * Swap the synchronous baseline for the `@pierre/diffs` view.
   *
   * `generation` guards against a slow import resolving after the overlay has
   * been closed and reopened on a different file.
   */
  async #enhance(generation: number): Promise<void> {
    const opts = this.#options;
    const box = this.#contentBox;
    if (!opts || !box) return;

    let mod: typeof import('@pierre/diffs');
    try {
      mod = await import('@pierre/diffs');
    } catch {
      return; // keep the <pre>; a plain preview beats an error
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
      } else {
        const file = new mod.File(codeOptions);
        file.render({ file: { name, contents }, containerWrapper: mount });
        if (opts.line !== undefined) file.setSelectedLines({ start: opts.line, end: opts.line });
      }
    } catch {
      return; // malformed input or an unsupported grammar — keep the baseline
    }

    if (generation !== this.#generation || !this.isConnected) return;
    box.classList.add('content--rich');
    box.replaceChildren(mount);
  }

  #buildContent(opts: QuickLookOptions): HTMLElement {
    const mime = opts.mimeType;

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

    // Genuinely opaque. Say what it is and how big, rather than only that we
    // gave up — with sniffing upstream, reaching here means the bytes really
    // are binary rather than merely unrecognized.
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

/** A compact type label for the header chip: `text/typescript` → `typescript`. */
function shortType(opts: QuickLookOptions): string {
  const base = opts.mimeType.split(';', 1)[0]?.trim() ?? opts.mimeType;
  if (base === 'application/octet-stream') return 'binary';
  const subtype = base.slice(base.indexOf('/') + 1);
  return subtype.replace(/^x-/, '').replace(/\+.*$/, '');
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
