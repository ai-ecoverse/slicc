import { define } from '../internal/define.js';
import { sheet } from '../internal/dom.js';

const DISMISS_TIMEOUT_MS = 400;

const STYLE = `
:host{position:fixed;inset:0;z-index:1000;display:none;}
:host([open]){display:block;}
.overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.backdrop{position:absolute;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);opacity:0;transition:opacity .35s cubic-bezier(.2,0,.13,1);}
.overlay.visible .backdrop{opacity:1;}
.overlay.closing .backdrop{opacity:0;}
.image{position:absolute;border-radius:6px;box-shadow:0 20px 60px rgba(0,0,0,.4),0 8px 20px rgba(0,0,0,.3);max-width:90vw;max-height:90vh;object-fit:contain;transform-origin:center center;will-change:transform;transition:transform .35s cubic-bezier(.2,0,.13,1),border-radius .35s cubic-bezier(.2,0,.13,1);}
`;
const SHEET = sheet(STYLE);

let activePreview: SliccImagePreview | null = null;

export class SliccImagePreview extends HTMLElement {
  readonly #root: ShadowRoot;
  #overlay: HTMLDivElement | null = null;
  #img: HTMLImageElement | null = null;
  #originEl: HTMLElement | null = null;
  #onKey: ((e: KeyboardEvent) => void) | null = null;
  #dismissed = false;
  #dismissTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  disconnectedCallback(): void {
    this.#teardown();
    if (activePreview === this) activePreview = null;
  }

  get src(): string | null {
    return this.getAttribute('src');
  }

  set src(value: string | null) {
    if (value == null) this.removeAttribute('src');
    else this.setAttribute('src', value);
  }

  get isOpen(): boolean {
    return this.hasAttribute('open');
  }

  open(src: string, originEl?: HTMLElement | null): void {
    if (activePreview && activePreview !== this) activePreview.#dismissImmediate();

    this.#teardown();
    this.#dismissed = false;
    this.src = src;
    this.setAttribute('open', '');
    activePreview = this;
    this.#originEl = originEl ?? this;

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.setAttribute('part', 'overlay');

    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.setAttribute('part', 'backdrop');
    overlay.appendChild(backdrop);

    const img = document.createElement('img');
    img.className = 'image';
    img.setAttribute('part', 'image');
    img.src = src;
    img.alt = 'Image preview';
    overlay.appendChild(img);

    this.#root.appendChild(overlay);
    this.#overlay = overlay;
    this.#img = img;

    const originRect = (this.#originEl as HTMLElement).getBoundingClientRect();

    const setupAndAnimate = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const maxW = vw * 0.9;
      const maxH = vh * 0.9;

      const natW = img.naturalWidth || originRect.width * 4;
      const natH = img.naturalHeight || originRect.height * 4;
      const scale = Math.min(maxW / natW, maxH / natH, 1);
      const finalW = natW * scale;
      const finalH = natH * scale;

      const finalLeft = (vw - finalW) / 2;
      const finalTop = (vh - finalH) / 2;

      const scaleX = originRect.width / finalW;
      const scaleY = originRect.height / finalH;
      const originCenterX = originRect.left + originRect.width / 2;
      const originCenterY = originRect.top + originRect.height / 2;
      const finalCenterX = finalLeft + finalW / 2;
      const finalCenterY = finalTop + finalH / 2;
      const translateX = originCenterX - finalCenterX;
      const translateY = originCenterY - finalCenterY;

      img.style.position = 'absolute';
      img.style.width = `${finalW}px`;
      img.style.height = `${finalH}px`;
      img.style.left = `${finalLeft}px`;
      img.style.top = `${finalTop}px`;
      img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`;
      img.style.borderRadius = `${6 / Math.min(scaleX, scaleY)}px`;

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          img.style.transform = 'translate(0, 0) scale(1, 1)';
          img.style.borderRadius = '6px';
          overlay.classList.add('visible');
        });
      });
    };

    if (img.complete && img.naturalWidth > 0) {
      setupAndAnimate();
    } else {
      img.onload = () => setupAndAnimate();
      img.onerror = () => this.#dismissImmediate();
    }

    this.#onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close();
    };
    overlay.addEventListener('click', () => this.close());
    document.addEventListener('keydown', this.#onKey);

    this.dispatchEvent(
      new CustomEvent('slicc-image-preview-open', {
        bubbles: true,
        composed: true,
        detail: { src },
      })
    );
  }

  close(): void {
    const overlay = this.#overlay;
    const img = this.#img;
    if (this.#dismissed || !overlay || !img || activePreview !== this) return;
    this.#dismissed = true;

    overlay.classList.add('closing');
    overlay.classList.remove('visible');

    const origin = this.#originEl;
    const currentOriginRect = origin ? origin.getBoundingClientRect() : null;
    if (currentOriginRect && currentOriginRect.width > 0 && currentOriginRect.height > 0) {
      const imgRect = img.getBoundingClientRect();
      const scaleX = currentOriginRect.width / imgRect.width;
      const scaleY = currentOriginRect.height / imgRect.height;
      const originCenterX = currentOriginRect.left + currentOriginRect.width / 2;
      const originCenterY = currentOriginRect.top + currentOriginRect.height / 2;
      const imgCenterX = imgRect.left + imgRect.width / 2;
      const imgCenterY = imgRect.top + imgRect.height / 2;
      const translateX = originCenterX - imgCenterX;
      const translateY = originCenterY - imgCenterY;

      img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`;
      img.style.borderRadius = `${6 / Math.min(scaleX, scaleY)}px`;
    }

    this.dispatchEvent(
      new CustomEvent('slicc-image-preview-close', {
        bubbles: true,
        composed: true,
        detail: { src: this.src },
      })
    );

    const cleanup = () => this.#finalizeDismiss();
    this.#dismissTimer = setTimeout(cleanup, DISMISS_TIMEOUT_MS);
    overlay.addEventListener('transitionend', (e) => {
      if ((e as TransitionEvent).propertyName !== 'transform') return;
      if (this.#dismissTimer) clearTimeout(this.#dismissTimer);
      cleanup();
    });
  }

  #dismissImmediate(): void {
    this.#teardown();
  }

  #finalizeDismiss(): void {
    this.#teardown();
  }

  #teardown(): void {
    if (this.#dismissTimer) {
      clearTimeout(this.#dismissTimer);
      this.#dismissTimer = null;
    }
    if (this.#onKey) {
      document.removeEventListener('keydown', this.#onKey);
      this.#onKey = null;
    }
    if (this.#overlay) {
      this.#overlay.remove();
      this.#overlay = null;
    }
    this.#img = null;
    this.#originEl = null;
    this.removeAttribute('open');
    this.removeAttribute('src');
    if (activePreview === this) activePreview = null;
  }

  static show(src: string, originEl: HTMLElement): () => void {
    let host = document.querySelector<SliccImagePreview>('slicc-image-preview[data-shared]');
    if (!host) {
      host = document.createElement('slicc-image-preview');
      host.setAttribute('data-shared', '');
      document.body.appendChild(host);
    }
    host.open(src, originEl);
    return () => host.close();
  }
}

define('slicc-image-preview', SliccImagePreview);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-image-preview': SliccImagePreview;
  }
}
