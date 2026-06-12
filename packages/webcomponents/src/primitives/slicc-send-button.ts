import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { gravatarUrl } from '../internal/gravatar.js';
import { iconEl } from '../internal/icons.js';

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
 * Idle micro-interactions on the arrow glyph, driven by JS-toggled classes so
 * they stay deterministic + testable (the browser's :hover / :active states are
 * not synthesizable from script). On hover the arrow wiggles in anticipation;
 * on press it dips down a couple px (preparing to leap); release fires the
 * 'whoosh' fly-out below. The is-hover wiggle yields to is-whoosh via :not().
 */
.glyph.is-hover:not(.is-whoosh) {
  animation: slicc-send-wiggle 720ms ease-in-out infinite;
}
.glyph.is-press:not(.is-whoosh) {
  animation: none;
  transform: translateY(2px);
}
@keyframes slicc-send-wiggle {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  25%      { transform: translateY(-1px) rotate(-7deg); }
  75%      { transform: translateY(-1px) rotate(7deg); }
}

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
 * Busy slow fill: a solid (currentColor) copy of the stop square, stacked over
 * the outline copy, is revealed by an animated clip-path that runs twelve
 * alternating phases — six fills, each sweeping the square solid from a
 * different direction (inside-out, left-to-right, top-to-bottom, right-to-left,
 * bottom-to-top, top-left corner), each immediately followed by a clear that
 * drains the square back to empty along the inverse of that direction. Each
 * phase takes 10s for a 120s loop. Every fill peaks at the full square and
 * every clear bottoms out empty, so the invisible hand-offs between phases (and
 * across the loop) carry no visible snap. The fill's static (no-animation) state
 * is fully filled, so reduced motion shows a solid square.
 */
.stop { position: relative; }
.stop-fill {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  clip-path: inset(0 0 0 0);
}
.stop-fill svg rect { fill: currentColor; }
.send.is-busy .stop-fill { animation: slicc-send-fill 120s linear infinite; }
@keyframes slicc-send-fill {
  /* 1 · FILL inside-out (0–10s): grows from the centre to full */
  0%      { clip-path: inset(50% 50% 50% 50%); }
  8.33%   { clip-path: inset(0 0 0 0); }
  /* 2 · CLEAR outside-in (10–20s): collapses from full back to the centre */
  16.66%  { clip-path: inset(50% 50% 50% 50%); }
  /* 3 · FILL left-to-right (20–30s) */
  16.67%  { clip-path: inset(0 100% 0 0); }
  25%     { clip-path: inset(0 0 0 0); }
  /* 4 · CLEAR right-to-left drain (30–40s): empties back toward the left */
  33.33%  { clip-path: inset(0 100% 0 0); }
  /* 5 · FILL top-to-bottom (40–50s) */
  33.34%  { clip-path: inset(0 0 100% 0); }
  41.66%  { clip-path: inset(0 0 0 0); }
  /* 6 · CLEAR bottom-to-top drain (50–60s): empties back toward the top */
  50%     { clip-path: inset(0 0 100% 0); }
  /* 7 · FILL right-to-left (60–70s) */
  50.01%  { clip-path: inset(0 0 0 100%); }
  58.33%  { clip-path: inset(0 0 0 0); }
  /* 8 · CLEAR left-to-right drain (70–80s): empties back toward the right */
  66.66%  { clip-path: inset(0 0 0 100%); }
  /* 9 · FILL bottom-to-top (80–90s) */
  66.67%  { clip-path: inset(100% 0 0 0); }
  75%     { clip-path: inset(0 0 0 0); }
  /* 10 · CLEAR top-to-bottom drain (90–100s): empties back toward the bottom */
  83.33%  { clip-path: inset(100% 0 0 0); }
  /* 11 · FILL diagonal from the top-left corner (100–110s) */
  83.34%  { clip-path: inset(0 100% 100% 0); }
  91.66%  { clip-path: inset(0 0 0 0); }
  /* 12 · CLEAR back to the top-left corner (110–120s) */
  100%    { clip-path: inset(0 100% 100% 0); }
}

/*
 * Respect prefers-reduced-motion: no motion, just the state swap. The idle
 * wiggle/press, the whoosh, the busy pulse and the busy fill all hold a static
 * state (the fill stays solid), and events are unaffected.
 */
@media (prefers-reduced-motion: reduce) {
  .glyph.is-whoosh,
  .glyph.is-hover,
  .glyph.is-press,
  .send.is-busy .stop,
  .send.is-busy .stop-fill {
    animation: none;
  }
  .glyph.is-press { transform: none; }
}
`;
const SHEET = sheet(STYLE);

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
 * - default — clickable; idle micro-interactions make the arrow wiggle in
 *   anticipation on hover and dip down a couple px on press, then on
 *   release/click it whooshes UP (translate + fade, then reset) and emits
 *   `send`.
 * - `disabled` — non-interactive (e.g. empty composer input); emits nothing.
 * - `busy` — streaming; shows a white lucide `square` (stop) glyph that breathes
 *   with a soft pulse while a solid fill runs twelve alternating phases — six
 *   directional fills (inside-out, left-to-right, top-to-bottom, right-to-left,
 *   bottom-to-top, top-left corner), each followed by a clear that drains the
 *   square back to empty along the inverse direction (10s each, a 120s loop).
 *   Emits `stop` on click.
 *
 * `prefers-reduced-motion: reduce` suppresses all motion — the state simply
 * swaps with no animation (the busy fill holds a static, fully-filled square).
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
    this.#root.adoptedStyleSheets = [SHEET];
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

  /** The default-state arrow glyph, or `null` while busy / not rendered. */
  #glyph(): HTMLElement | null {
    return this.#root.querySelector<HTMLElement>('.glyph');
  }

  // Idle micro-interactions: hover anticipation (wiggle) + press dip. Skipped
  // while disabled or busy (no arrow glyph then). Release runs the whoosh.
  #onPointerEnter = (): void => {
    if (this.disabled || this.busy) return;
    this.#glyph()?.classList.add('is-hover');
  };

  #onPointerLeave = (): void => {
    const glyph = this.#glyph();
    glyph?.classList.remove('is-hover', 'is-press');
  };

  #onPointerDown = (): void => {
    if (this.disabled || this.busy) return;
    const glyph = this.#glyph();
    glyph?.classList.add('is-press');
    glyph?.classList.remove('is-hover');
  };

  #onPointerUp = (): void => {
    this.#glyph()?.classList.remove('is-press');
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
    const label = this.label ?? (busy ? 'Stop' : 'Send');
    const inner = busy
      ? h(
          'slot',
          { name: 'busy' },
          h(
            'span',
            { class: 'stop', part: 'stop' },
            iconEl('square', { size: GLYPH_SIZE }),
            // A solid copy of the square, revealed/drained by the 12-phase fill/clear.
            h('span', { class: 'stop-fill' }, iconEl('square', { size: GLYPH_SIZE }))
          )
        )
      : h(
          'slot',
          null,
          h('span', { class: 'glyph', part: 'glyph' }, iconEl('arrow-up', { size: GLYPH_SIZE }))
        );

    const button = h(
      'button',
      {
        part: 'button',
        class: `send${busy ? ' is-busy' : ''}`,
        type: 'button',
        title: label,
        'aria-label': label,
        disabled: disabled || undefined,
      },
      inner
    ) as HTMLButtonElement;

    this.#root.replaceChildren(button);
    this.#button = button;
    this.#button.addEventListener('click', this.#onClick);
    this.#button.addEventListener('pointerenter', this.#onPointerEnter);
    this.#button.addEventListener('pointerleave', this.#onPointerLeave);
    this.#button.addEventListener('pointerdown', this.#onPointerDown);
    this.#button.addEventListener('pointerup', this.#onPointerUp);
    this.#applyFace();
  }
}

define('slicc-send-button', SliccSendButton);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-send-button': SliccSendButton;
  }
}
