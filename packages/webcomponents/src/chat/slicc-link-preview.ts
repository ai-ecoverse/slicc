import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

export type LinkPreviewState = 'loading' | 'ready' | 'error';

const STATES = new Set<LinkPreviewState>(['loading', 'ready', 'error']);

const STYLE = `
:host{display:block;width:340px;max-width:100%;color:var(--ink);}
:host([hidden]){display:none;}
a{display:block;color:inherit;text-decoration:none;}
a:focus-visible{outline:2px solid var(--ctx,currentColor);outline-offset:-2px;}
.media{
  display:block;width:100%;aspect-ratio:1.91/1;object-fit:cover;
  background:color-mix(in srgb,var(--ink) 6%,transparent);
  border-bottom:1px solid color-mix(in srgb,var(--ink) 10%,transparent);
}
.body{display:flex;flex-direction:column;gap:4px;padding:10px 12px 12px;}
.site{
  display:flex;align-items:center;gap:6px;min-width:0;
  font-size:11px;color:color-mix(in srgb,var(--ink) 60%,transparent);
}
.site span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.badge{
  margin-left:auto;flex:0 0 auto;
  padding:0 7px;border-radius:999px;
  font:600 10.5px/1.6 var(--ui);letter-spacing:.02em;
  color:var(--ctx,var(--ink));
  background:color-mix(in srgb,var(--ctx,var(--ink)) 14%,transparent);
}
.title{
  font-weight:600;font-size:13.5px;line-height:1.3;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
}
.desc{
  font-size:12px;color:color-mix(in srgb,var(--ink) 72%,transparent);
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;
}
.skeleton{
  display:block;height:10px;border-radius:5px;
  background:linear-gradient(90deg,
    color-mix(in srgb,var(--ink) 7%,transparent) 0%,
    color-mix(in srgb,var(--ink) 13%,transparent) 50%,
    color-mix(in srgb,var(--ink) 7%,transparent) 100%);
  background-size:200% 100%;
  animation:shimmer 1.2s ease-in-out infinite;
}
.skeleton.media{height:auto;border-radius:0;}
.skeleton.w80{width:80%;}
.skeleton.w55{width:55%;}
@keyframes shimmer{from{background-position:100% 0}to{background-position:-100% 0}}
@media (prefers-reduced-motion: reduce){.skeleton{animation:none;}}
.empty{font-size:12px;color:color-mix(in srgb,var(--ink) 60%,transparent);}
`;
const SHEET = sheet(STYLE);

function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function safeImage(src: string): boolean {
  return safeHref(src) !== null || /^data:image\//i.test(src);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export class SliccLinkPreview extends HTMLElement {
  static readonly observedAttributes = [
    'url',
    'state',
    'heading',
    'description',
    'image',
    'site',
    'badge',
  ];

  readonly #root: ShadowRoot;

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

  get url(): string {
    return this.getAttribute('url') ?? '';
  }

  set url(value: string) {
    this.setAttribute('url', value);
  }

  get state(): LinkPreviewState {
    const raw = this.getAttribute('state') as LinkPreviewState | null;
    return raw && STATES.has(raw) ? raw : 'ready';
  }

  set state(value: LinkPreviewState) {
    this.setAttribute('state', value);
  }

  #attr(name: string): string {
    return this.getAttribute(name)?.trim() ?? '';
  }

  #render(): void {
    const url = this.url;
    const href = safeHref(url);
    const site = this.#attr('site') || hostOf(url);
    const badge = this.#attr('badge');
    const siteRow = h(
      'div',
      { class: 'site', part: 'site' },
      iconEl('globe', { size: 12 }),
      h('span', null, site),
      badge ? h('span', { class: 'badge', part: 'badge' }, badge) : null
    );

    let content: HTMLElement;
    if (this.state === 'loading') {
      content = h(
        'div',
        { 'aria-busy': 'true' },
        h('span', { class: 'skeleton media' }),
        h(
          'div',
          { class: 'body' },
          siteRow,
          h('span', { class: 'skeleton w80' }),
          h('span', { class: 'skeleton w55' })
        )
      );
    } else if (this.state === 'error') {
      content = h(
        'div',
        { class: 'body' },
        siteRow,
        h('div', { class: 'title', part: 'title' }, this.#attr('heading') || url),
        h('div', { class: 'empty' }, 'No preview available')
      );
    } else {
      const image = this.#attr('image');
      const description = this.#attr('description');
      content = h(
        'div',
        null,
        image && safeImage(image) ? this.#image(image) : null,
        h(
          'div',
          { class: 'body' },
          siteRow,
          h('div', { class: 'title', part: 'title' }, this.#attr('heading') || url),
          description ? h('div', { class: 'desc', part: 'description' }, description) : null
        )
      );
    }

    if (href) {
      const link = h('a', {
        href,
        target: '_blank',
        rel: 'noopener noreferrer',
        part: 'link',
      });
      link.append(content);
      this.#root.replaceChildren(link);
    } else {
      this.#root.replaceChildren(content);
    }
  }

  #image(src: string): HTMLImageElement {
    const img = h('img', {
      class: 'media',
      part: 'image',
      alt: '',
      src,
      loading: 'lazy',
      decoding: 'async',
      referrerpolicy: 'no-referrer',
    }) as HTMLImageElement;
    const settle = (): void => {
      this.dispatchEvent(new CustomEvent('link-preview-resize', { bubbles: true, composed: true }));
    };
    img.addEventListener('load', settle, { once: true });
    img.addEventListener(
      'error',
      () => {
        img.remove();
        settle();
      },
      { once: true }
    );
    return img;
  }
}

define('slicc-link-preview', SliccLinkPreview);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-link-preview': SliccLinkPreview;
  }
}
