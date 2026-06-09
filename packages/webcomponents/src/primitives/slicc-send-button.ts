import { define } from '../internal/define.js';
import { gravatarUrl } from '../internal/gravatar.js';
import { escapeHtml } from '../internal/html.js';
import { iconSvg } from '../internal/icons.js';

const STYLE = `
:host { display: inline-flex; }
:host([hidden]) { display: none; }

.send {
  position: relative;
  width: 36px;
  height: 36px;
  border-radius: 9999px;
  border: none;
  cursor: pointer;
  background: var(--rainbow);
  color: #fff;
  font-family: var(--ui);
  display: grid;
  place-items: center;
  padding: 0;
  line-height: 1;
  overflow: hidden;
  isolation: isolate;
}
.send:hover:not(:disabled) { filter: brightness(1.06); }
.send:disabled { cursor: not-allowed; opacity: 0.45; }

/*
 * Avatar / gravatar face: an email or src paints the user's picture as the
 * circular ground (behind the icon). When absent, the rainbow gradient above
 * shows through. A soft scrim darkens the face so the white glyph stays legible.
 */
.face {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  object-fit: cover;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
}
.send.has-face::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: rgba(0, 0, 0, 0.32);
  z-index: 1;
  pointer-events: none;
}

/* The glyph layer rides above the face + scrim. */
.glyph,
.stop {
  position: relative;
  z-index: 2;
  display: grid;
  place-items: center;
  pointer-events: none;
  color: #fff;
}
.glyph svg,
.stop svg { display: block; }

/*
 * 'Whoosh up' on send: the arrow translates up and fades, then resets. Toggled
 * as a class from JS on click and removed on \`animationend\` so it re-fires
 * every send and stays testable.
 */
.glyph.is-whoosh { animation: slicc-send-whoosh 360ms cubic-bezier(0.4, 0, 0.2, 1) both; }
@keyframes slicc-send-whoosh {
  0%   { transform: translateY(0); opacity: 1; }
  55%  { transform: translateY(-14px); opacity: 0; }
  56%  { transform: translateY(8px); opacity: 0; }
  100% { transform: translateY(0); opacity: 1; }
}

/*
 * Busy 'surprise' glyph: the stop square breathes with a soft pulse so the
 * streaming state reads as alive without being distracting.
 */
.send.is-busy .stop { animation: slicc-send-pulse 1.6s ease-in-out infinite; }
@keyframes slicc-send-pulse {
  0%, 100% { transform: scale(1); opacity: 0.92; }
  50%      { transform: scale(1.14); opacity: 1; }
}

/*
 * Respect prefers-reduced-motion: no motion, just the state swap. Animations
 * paint nothing (events are unaffected) and the glyphs hold their static state.
 */
@media (prefers-reduced-motion: reduce) {
  .glyph.is-whoosh,
  .send.is-busy .stop {
    animation: none;
  }
}
`;

/** Pixel size for the overlaid lucide glyphs inside the 36px circle. */
const GLYPH_SIZE = 18;
/** Requested gravatar pixel size (2× the 36px button for crisp HiDPI). */
const GRAVATAR_PX = 72;

/**
 * `<slicc-send-button>` — the composer toolbar send control from the prototype
 * (`.send`): a 36px circular button. By default the brand `--rainbow` gradient
 * is the ground; supplying `email` (a gravatar face, hashed with SHA-256 via the
 * shared {@link gravatarUrl} helper — the same approach as `slicc-avatar`) or an
 * explicit `src` paints the user's avatar as the circular background instead. A
 * white lucide `arrow-up` icon is overlaid on top (lucide, never emoji).
 *
 * States:
 * - default — clickable; on click animates the arrow UP (translate + fade, then
 *   reset — a satisfying "whoosh up") and emits `send`.
 * - `disabled` — non-interactive (e.g. empty composer input); emits nothing.
 * - `busy` — streaming; shows a white lucide `square` (stop) glyph with a soft
 *   pulse and emits `stop` on click.
 *
 * `prefers-reduced-motion: reduce` suppresses all motion — the state simply
 * swaps with no animation.
 *
 * @attr disabled - boolean; non-interactive, dimmed.
 * @attr busy - boolean; streaming state — renders a stop glyph and emits `stop`.
 * @attr email - optional user email; a gravatar face is derived (SHA-256) as the ground.
 * @attr src - optional image URL; painted as the circular face (wins over `email`).
 * @attr label - accessible label / tooltip (defaults to "Send" / "Stop").
 * @fires send - composed + bubbling; on click when not `busy` and not `disabled`.
 * @fires stop - composed + bubbling; on click when `busy` and not `disabled`.
 * @csspart button - the circular <button> element.
 * @csspart face - the avatar/gravatar face image (when `email`/`src` is set).
 * @csspart glyph - the up-arrow glyph wrapper (default state).
 * @csspart stop - the stop square wrapper (busy state).
 * @slot - optional custom default glyph (replaces the arrow-up icon).
 * @slot busy - optional custom busy glyph (replaces the stop square).
 */
export class SliccSendButton extends HTMLElement {
  static readonly observedAttributes = ['disabled', 'busy', 'email', 'src', 'label'];

  readonly #root: ShadowRoot;
  #button: HTMLButtonElement | null = null;
  /** Token guarding async gravatar resolution against stale attribute changes. */
  #faceToken = 0;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.#render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  get disabled(): boolean {
    return this.hasAttribute('disabled');
  }

  set disabled(value: boolean) {
    this.toggleAttribute('disabled', Boolean(value));
  }

  get busy(): boolean {
    return this.hasAttribute('busy');
  }

  set busy(value: boolean) {
    this.toggleAttribute('busy', Boolean(value));
  }

  get email(): string | null {
    return this.getAttribute('email');
  }

  set email(value: string | null) {
    if (value == null) this.removeAttribute('email');
    else this.setAttribute('email', value);
  }

  get src(): string | null {
    return this.getAttribute('src');
  }

  set src(value: string | null) {
    if (value == null) this.removeAttribute('src');
    else this.setAttribute('src', value);
  }

  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  #onClick = (): void => {
    if (this.disabled) return;
    if (this.busy) {
      this.dispatchEvent(new CustomEvent('stop', { bubbles: true, composed: true }));
      return;
    }
    this.#playWhoosh();
    this.dispatchEvent(new CustomEvent('send', { bubbles: true, composed: true }));
  };

  /** Re-trigger the 'whoosh up' animation on the arrow glyph (no-op under reduced motion via CSS). */
  #playWhoosh(): void {
    const glyph = this.#root.querySelector<HTMLElement>('.glyph');
    if (!glyph) return;
    glyph.classList.remove('is-whoosh');
    // Force reflow so removing + re-adding the class restarts the animation.
    void glyph.offsetWidth;
    glyph.classList.add('is-whoosh');
    glyph.addEventListener('animationend', () => glyph.classList.remove('is-whoosh'), {
      once: true,
    });
  }

  /**
   * Resolve and paint the avatar/gravatar face as the circular ground. `src`
   * wins; otherwise `email` is hashed to a gravatar URL. Async (SHA-256), so a
   * token guards against a later attribute change resolving out of order.
   */
  #applyFace(): void {
    const token = ++this.#faceToken;
    const button = this.#button;
    if (!button) return;

    const paint = (url: string | null): void => {
      if (token !== this.#faceToken) return; // superseded by a newer render
      const live = this.#button;
      if (!live) return;
      const existing = live.querySelector('.face');
      existing?.remove();
      if (url) {
        const img = document.createElement('img');
        img.className = 'face';
        img.setAttribute('part', 'face');
        img.alt = '';
        img.src = url;
        live.prepend(img);
        live.classList.add('has-face');
      } else {
        live.classList.remove('has-face');
      }
    };

    const src = this.src;
    if (src) {
      paint(src);
      return;
    }
    const email = this.email;
    if (!email || email.trim() === '') {
      paint(null);
      return;
    }
    // No face until the hash resolves — keep the rainbow ground meanwhile.
    paint(null);
    gravatarUrl(email, { size: GRAVATAR_PX })
      .then(paint)
      .catch(() => paint(null));
  }

  #render(): void {
    const busy = this.busy;
    const disabled = this.disabled;
    const label = escapeHtml(this.label ?? (busy ? 'Stop' : 'Send'));
    const inner = busy
      ? `<slot name="busy"><span class="stop" part="stop">${iconSvg('square', { size: GLYPH_SIZE })}</span></slot>`
      : `<slot><span class="glyph" part="glyph">${iconSvg('arrow-up', { size: GLYPH_SIZE })}</span></slot>`;

    this.#root.innerHTML = `<style>${STYLE}</style><button
      part="button"
      class="send${busy ? ' is-busy' : ''}"
      type="button"
      title="${label}"
      aria-label="${label}"
      ${disabled ? 'disabled' : ''}
    >${inner}</button>`;

    this.#button = this.#root.querySelector('button');
    this.#button?.addEventListener('click', this.#onClick);
    this.#applyFace();
  }
}

define('slicc-send-button', SliccSendButton);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-send-button': SliccSendButton;
  }
}
