import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/**
 * Scoped, document-level stylesheet for `<slicc-composer>`. Light-DOM hosts
 * cannot carry an inline `<style>` in a shadow root, so the chrome is injected
 * once into the host document (idempotent) and selected by the host tag.
 *
 * Lifted faithfully from the prototype (`proto/StellarRubySwift.html` `.composer`
 * / `.composer-inner`): the footer band of the chat column. A frosted-glass band
 * tinted by the per-context `--ctx` accent over a translucent `--bg`, with a top
 * `--line` border and `position: relative; z-index: 2` so the add-menu results
 * panel that pops up out of the band overlays the chat thread (which sits at the
 * default stacking level) instead of growing the footer height. The inner column
 * is a constant `680px`-max centered band, so — like the thread above it — it
 * slides left with the chat pane as the workbench opens rather than re-centering.
 *
 * The `open` host attribute mirrors the prototype's `.shell.open`: in the
 * narrow-chat layout the meta row's keyboard `.hint` is hidden, keeping just the
 * model + thinking controls (the prototype's `.shell.open .meta .hint`).
 *
 * Everything is var-driven (`--ctx` / `--bg` / `--line` / `--ui`) so dark mode
 * flips automatically via the inherited theme scope — `--bg` darkens and `--ctx`
 * is recomputed per context, so the frosted tint and `color-mix` background
 * recompute with no explicit dark override. `backdrop-filter` blurs + saturates
 * whatever (chat thread / shader / sprinkles) sits behind the glass.
 */
const STYLE = `
slicc-composer {
  flex: 0 0 auto;
  display: block;
  box-sizing: border-box;
  font-family: var(--ui);
  border-top: 1px solid var(--line);
  background: color-mix(in srgb, var(--ctx) 12%, color-mix(in srgb, var(--bg) 68%, transparent));
  backdrop-filter: blur(18px) saturate(1.4);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
  padding: 14px 16px 14px;
  position: relative;
  z-index: 2;
}
slicc-composer[hidden] {
  display: none;
}
slicc-composer > .slicc-composer__inner {
  box-sizing: border-box;
  max-width: 680px;
  margin: 0 auto;
}
/* narrow-chat (.shell.open): keep just model + thinking — drop the keyboard hint. */
slicc-composer[open] .slicc-composer__hint,
slicc-composer[open] [data-composer-hint] {
  display: none;
}

/* Push-to-talk "walkie-talkie" overlay. While the pointer is held on the
   textarea the band turns into one big active push button: a centered mic over
   the frosted band, a dictation prompt, and a (simulated) model-load progress
   bar. The overlay is a direct host child (not the 680px inner band) so it
   covers the whole footer, and sits above it via z-index. */
slicc-composer .slicc-composer__ptt {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  box-sizing: border-box;
  padding: 16px;
  text-align: center;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  color: var(--ink);
  background: color-mix(in srgb, var(--ctx) 22%, color-mix(in srgb, var(--bg) 82%, transparent));
  backdrop-filter: blur(10px) saturate(1.4);
  -webkit-backdrop-filter: blur(10px) saturate(1.4);
}
slicc-composer .slicc-composer__ptt-mic {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  color: var(--ctx);
  background: color-mix(in srgb, var(--ctx) 16%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ctx) 32%, transparent);
}
slicc-composer .slicc-composer__ptt-label {
  font-family: var(--ui);
  font-size: 15px;
  font-weight: 600;
}
slicc-composer .slicc-composer__ptt-load {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: min(280px, 70%);
}
slicc-composer .slicc-composer__ptt-load-text {
  font-family: var(--ui);
  font-size: 12px;
  color: var(--txt-2);
}
slicc-composer .slicc-composer__ptt-bar {
  width: 100%;
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  background: color-mix(in srgb, var(--ink) 12%, transparent);
}
slicc-composer .slicc-composer__ptt-bar-fill {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  transform-origin: left center;
  background: var(--ctx);
  animation-name: slicc-ptt-load;
  animation-duration: 1.2s;
  animation-timing-function: ease-out;
  animation-fill-mode: forwards;
}
/* Listening affordance: model ready — drop the loader, pulse the mic so the big
   button reads as actively recording. */
slicc-composer .slicc-composer__ptt.is-listening .slicc-composer__ptt-load {
  display: none;
}
slicc-composer .slicc-composer__ptt.is-listening .slicc-composer__ptt-mic {
  animation-name: slicc-ptt-pulse;
  animation-duration: 1.1s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
@keyframes slicc-ptt-load {
  from { transform: scaleX(0); }
  to { transform: scaleX(1); }
}
@keyframes slicc-ptt-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.08); }
}
/* Reduced motion: no progress sweep and no mic pulse — hold the static ready
   state (the fill sits full) while the gesture stays fully functional. */
@media (prefers-reduced-motion: reduce) {
  slicc-composer .slicc-composer__ptt-bar-fill {
    animation-name: none;
    transform: scaleX(1);
  }
  slicc-composer .slicc-composer__ptt.is-listening .slicc-composer__ptt-mic {
    animation-name: none;
  }
}
`;

const STYLE_ID = 'slicc-composer-style';

/**
 * Representative dictated sentence inserted into the textarea on a real release.
 * This is the presentational library — there is no real ASR — so the gesture
 * simulates a transcript with prototype-flavored copy.
 */
const TRANSCRIPT =
  'Make the landing hero feel warmer, and add a clear call to action above the fold.';

/** Inject the scoped composer stylesheet into a document once (idempotent). */
function ensureComposerStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * `<slicc-composer>` — the chat footer band from the prototype (`.composer` +
 * `.composer-inner`). A frosted-glass footer container that slots the input card
 * + meta row of the composer and centers them in a constant `680px`-max column,
 * so the band slides left with the chat pane (like the thread above it) instead
 * of re-centering as the workbench opens.
 *
 * Light DOM (no shadow root): the host renders its own `.slicc-composer__inner`
 * column and relocates any light children into it, so the host app can style the
 * footer and slot arbitrary content — e.g. an `.inputcard` (with the
 * `<slicc-add-menu>` toolbar + `<slicc-send-button>`) and a `.meta` row,
 * composed by tag. The component is a pure container: no events of its own; its
 * job is the frosted band + `z-index: 2` layering that lets the add-menu results
 * panel pop up out of the footer and overlay the thread.
 *
 * The `open` host attribute mirrors the prototype's `.shell.open`: in the
 * narrow-chat layout the meta row's keyboard hint is hidden (anything carrying
 * the `data-composer-hint` attribute or the `.slicc-composer__hint` class),
 * keeping just the model + thinking controls.
 *
 * @attr open - boolean; narrow-chat variant (hides the meta keyboard hint), mirrors `.shell.open`
 * @csspart inner - the centered, `680px`-max `.composer-inner` band
 * @slot - default; the input card + meta row, rendered in DOM order
 */
export class SliccComposer extends HTMLElement {
  static readonly observedAttributes = ['open'];

  #inner!: HTMLElement;
  #built = false;

  /** The push-to-talk overlay while a press is active (null at rest). */
  #ptt: HTMLElement | null = null;
  /** Whether a push-to-talk gesture is currently held. */
  #pressed = false;
  /** The textarea the active gesture started on (the dictation target). */
  #target: HTMLTextAreaElement | null = null;

  connectedCallback(): void {
    ensureComposerStyle(this.ownerDocument);
    this.#build();
    // Delegate the walkie-talkie gesture from the host so it works for whatever
    // textarea the slotted input card renders (light DOM is reachable here).
    this.addEventListener('mousedown', this.#onMouseDown);
  }

  disconnectedCallback(): void {
    this.removeEventListener('mousedown', this.#onMouseDown);
    // Tear down a press in flight so a detach never strands the overlay or its
    // document-level listeners.
    this.#endPress(false);
  }

  attributeChangedCallback(): void {
    // `open` is reflected to the host attribute and driven entirely by CSS
    // (`slicc-composer[open] …`), so nothing to re-render here — but keep the
    // callback so the attribute participates in the observed lifecycle.
  }

  /**
   * Whether the narrow-chat variant is active (hides the meta keyboard hint).
   * Mirrors the prototype's `.shell.open`.
   */
  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    if (value) this.setAttribute('open', '');
    else this.removeAttribute('open');
  }

  /** The centered, `680px`-max `.composer-inner` band (`part="inner"`). */
  get inner(): HTMLElement {
    this.#build();
    return this.#inner;
  }

  /** Append a child node into the inner band, preserving DOM order. */
  append(...nodes: (Node | string)[]): void {
    this.#build();
    this.#inner.append(...nodes);
  }

  /**
   * Build the inner band once and relocate any pre-existing light children into
   * it. Idempotent — safe across re-connects (light DOM survives a move, so the
   * already-built `.slicc-composer__inner` is reused rather than rebuilt).
   */
  #build(): void {
    if (this.#built) return;
    this.#built = true;

    const existing = this.querySelector(':scope > .slicc-composer__inner');
    if (existing instanceof HTMLElement) {
      this.#inner = existing;
      return;
    }

    // Collect children that existed before we owned the subtree.
    const incoming = Array.from(this.childNodes);

    this.#inner = this.ownerDocument.createElement('div');
    this.#inner.className = 'slicc-composer__inner';
    this.#inner.setAttribute('part', 'inner');

    for (const node of incoming) this.#inner.appendChild(node);
    this.appendChild(this.#inner);
  }

  /**
   * Begin the push-to-talk gesture: pressing the textarea turns the band into a
   * big walkie-talkie button (mic + dictation prompt + simulated model-load
   * progress bar). Only the primary button on a textarea inside this host arms
   * it; the press is held until release or the pointer leaves.
   */
  #onMouseDown = (e: MouseEvent): void => {
    if (this.#pressed || e.button !== 0) return;
    const target = e.target as Element | null;
    const ta = target?.closest?.('textarea');
    if (!(ta instanceof HTMLTextAreaElement) || !this.contains(ta)) return;

    // Suppress the native caret/selection so the press reads purely as a button.
    e.preventDefault();
    this.#pressed = true;
    this.#target = ta;
    this.#ptt = this.#buildPtt();
    this.appendChild(this.#ptt);

    const doc = this.ownerDocument;
    doc.addEventListener('mouseup', this.#onDocMouseUp);
    this.addEventListener('mouseleave', this.#onMouseLeave);

    // Simulated model load: the CSS sweeps the bar; on completion the button
    // flips to its listening affordance. Reduced-motion skips the sweep and is
    // ready instantly (the CSS holds the fill full).
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      this.#enterListening();
    } else {
      const fill = this.#ptt.querySelector('.slicc-composer__ptt-bar-fill');
      fill?.addEventListener('animationend', () => this.#enterListening(), { once: true });
    }
  };

  /** Flip the held button from loading to its active listening affordance. */
  #enterListening(): void {
    if (!this.#pressed || !this.#ptt) return;
    this.#ptt.classList.remove('is-loading');
    this.#ptt.classList.add('is-listening');
    this.#ptt.setAttribute('aria-label', 'Listening — release to dictate');
  }

  /** A real release anywhere ends the gesture and inserts the transcript. */
  #onDocMouseUp = (): void => {
    this.#endPress(true);
  };

  /**
   * The pointer left the host mid-press: tear the overlay down WITHOUT inserting
   * a transcript. This is the stuck-state guard — a release outside the host no
   * longer reaches us once the press is cancelled here.
   */
  #onMouseLeave = (): void => {
    this.#endPress(false);
  };

  /**
   * End an active press: drop the overlay + document/host listeners and, on a
   * real release (`insert`), populate the dictation target with the transcript.
   * Idempotent and safe to call when no press is active.
   */
  #endPress(insert: boolean): void {
    if (!this.#pressed) return;
    this.#pressed = false;

    this.ownerDocument.removeEventListener('mouseup', this.#onDocMouseUp);
    this.removeEventListener('mouseleave', this.#onMouseLeave);

    this.#ptt?.remove();
    this.#ptt = null;

    const ta = this.#target;
    this.#target = null;
    if (insert && ta) {
      ta.value = ta.value ? `${ta.value} ${TRANSCRIPT}` : TRANSCRIPT;
      // Notify any host (e.g. slicc-input-card) so it syncs its value + autosize.
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
    }
  }

  /**
   * Build the push-to-talk overlay: a centered mic, the dictation prompt, and
   * the simulated model-load row (label + progress bar). innerHTML-free.
   */
  #buildPtt(): HTMLElement {
    return h(
      'div',
      {
        class: 'slicc-composer__ptt is-loading',
        'data-ptt': true,
        role: 'button',
        'aria-pressed': 'true',
        'aria-label': 'Push to talk to dictate',
      },
      h('div', { class: 'slicc-composer__ptt-mic' }, iconEl('mic', { size: 28 })),
      h('div', { class: 'slicc-composer__ptt-label' }, 'Keep mouse pressed to dictate'),
      h(
        'div',
        { class: 'slicc-composer__ptt-load' },
        h('span', { class: 'slicc-composer__ptt-load-text' }, 'Loading speech recognition model'),
        h(
          'div',
          { class: 'slicc-composer__ptt-bar' },
          h('div', { class: 'slicc-composer__ptt-bar-fill' })
        )
      )
    );
  }
}

define('slicc-composer', SliccComposer);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-composer': SliccComposer;
  }
}
