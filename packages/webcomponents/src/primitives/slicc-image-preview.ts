import { define } from '../internal/define.js';

/**
 * Shared transition duration (ms) used for the dismiss-cleanup fallback timer.
 * Matches the `0.35s` transition in the stylesheet, rounded up to the original
 * webapp `image-preview.ts` 400ms safety window.
 */
const DISMISS_TIMEOUT_MS = 400;

/**
 * Per-instance stylesheet — the verbatim `.image-preview-*` rules lifted from
 * `packages/webapp/src/ui/styles/image-preview.css`, re-rooted onto the shadow
 * structure (`:host`, `.overlay`, `.backdrop`, `.image`). These colors are the
 * intentional lightbox chrome (a dark scrim + drop shadow), not theme tokens,
 * so they are NOT token-driven — the lightbox reads the same in light and dark.
 */
const STYLE = `
:host{position:fixed;inset:0;z-index:1000;display:none;}
:host([open]){display:block;}
.overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.backdrop{position:absolute;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);opacity:0;transition:opacity .35s cubic-bezier(.2,0,.13,1);}
.overlay.visible .backdrop{opacity:1;}
.overlay.closing .backdrop{opacity:0;}
.image{position:absolute;border-radius:6px;box-shadow:0 20px 60px rgba(0,0,0,.4),0 8px 20px rgba(0,0,0,.3);max-width:90vw;max-height:90vh;object-fit:contain;transform-origin:center center;will-change:transform;transition:transform .35s cubic-bezier(.2,0,.13,1),border-radius .35s cubic-bezier(.2,0,.13,1);}
`;

/** The single currently-open preview, mirroring the webapp module singleton. */
let activePreview: SliccImagePreview | null = null;

/**
 * `<slicc-image-preview>` — the FLIP-zoom image lightbox lifted verbatim from
 * the webapp `ui/image-preview.ts` `showImagePreview` helper, wrapped as a
 * self-mounting overlay element. Open it with {@link open} (or the static
 * {@link show} helper, mirroring `showImagePreview(src, originEl)`); it animates
 * the image from the origin thumbnail's rect up to a centred, viewport-fitted
 * preview using a double-rAF FLIP transform, and animates back to the origin on
 * dismiss (click / Escape / {@link close}). Only one preview is visible at a
 * time — opening a second dismisses the first immediately.
 *
 * Shadow DOM; the dark scrim + drop-shadow are intentional lightbox chrome and
 * read identically in light and dark mode (no theme tokens).
 *
 * @attr open - reflects whether the lightbox is mounted/visible (read-only mirror; see `isOpen`)
 * @attr src - the image source currently shown (reflected)
 * @fires slicc-image-preview-open - composed, bubbling; fired once the image starts animating in
 * @fires slicc-image-preview-close - composed, bubbling; fired when dismissal begins
 * @csspart overlay - the full-viewport overlay (scrim + cursor target)
 * @csspart backdrop - the blurred dark scrim
 * @csspart image - the zoomed image
 */
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
    this.#root.innerHTML = `<style>${STYLE}</style>`;
  }

  disconnectedCallback(): void {
    this.#teardown();
    if (activePreview === this) activePreview = null;
  }

  /** The image source currently shown (reflected to the `src` attribute). */
  get src(): string | null {
    return this.getAttribute('src');
  }

  set src(value: string | null) {
    if (value == null) this.removeAttribute('src');
    else this.setAttribute('src', value);
  }

  /** Whether the lightbox is currently mounted/visible (mirrors the `open` attr). */
  get isOpen(): boolean {
    return this.hasAttribute('open');
  }

  /**
   * Open the lightbox showing `src`, FLIP-zooming from `originEl`'s on-screen
   * rect (when supplied) up to a centred, viewport-fitted preview. Dismisses any
   * other open preview first. Without an `originEl` the image still animates from
   * the host element's own rect, so the call is always safe.
   */
  open(src: string, originEl?: HTMLElement | null): void {
    if (activePreview && activePreview !== this) activePreview.#dismissImmediate();

    // Re-opening: drop the previous image/listeners cleanly first.
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

      // Place image at final layout position but visually at thumbnail via transform.
      img.style.position = 'absolute';
      img.style.width = `${finalW}px`;
      img.style.height = `${finalH}px`;
      img.style.left = `${finalLeft}px`;
      img.style.top = `${finalTop}px`;
      img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`;
      img.style.borderRadius = `${6 / Math.min(scaleX, scaleY)}px`;

      // Double-rAF ensures the browser paints the initial state before we animate.
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

  /**
   * Dismiss the lightbox, FLIP-animating the image back to the origin element's
   * current rect (when it is still on screen) before removing it. Idempotent.
   */
  close(): void {
    const overlay = this.#overlay;
    const img = this.#img;
    if (this.#dismissed || !overlay || !img || activePreview !== this) return;
    this.#dismissed = true;

    overlay.classList.add('closing');
    overlay.classList.remove('visible');

    // Animate back to origin if it's still in the DOM.
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

  /** Remove the overlay node and listeners without animating. */
  #dismissImmediate(): void {
    this.#teardown();
  }

  /** Final removal of the overlay + listeners after the close animation. */
  #finalizeDismiss(): void {
    this.#teardown();
  }

  /** Tear down the live overlay, key listener, and timer; clear `open`/`src`. */
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

  /**
   * Mirror of the webapp `showImagePreview(src, originEl)`: lazily mounts a
   * shared `<slicc-image-preview>` host on `<body>` (reused across calls), opens
   * it FLIP-zooming from `originEl`, and returns a dismiss function. Only one
   * preview shows at a time.
   */
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
