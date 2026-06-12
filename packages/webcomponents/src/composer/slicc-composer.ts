import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import {
  type ComposerSpeech,
  createBuiltinComposerSpeech,
  type SpeechEngineStatus,
  type SpeechSession,
} from './speech.js';

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
/* narrow-chat (.shell.open): keep just model + thinking — drop the keyboard hint.
   The composed <slicc-composer-meta> keeps its hint in shadow DOM, so the
   light-DOM class hooks can't reach it — pierce via its exported part too,
   or the "⏎ send · ⇧⏎ newline" line overflows the narrowed chat column
   straight into the workbench pane. */
slicc-composer[open] .slicc-composer__hint,
slicc-composer[open] [data-composer-hint],
slicc-composer[open] slicc-composer-meta::part(hint) {
  display: none;
}

/* Push-to-talk "walkie-talkie" overlay. While the pointer is held on the
   textarea the band turns into one big active push button. The overlay is a
   direct host child (not the 680px inner band) so it covers the whole footer,
   and sits above it via z-index. Stage classes select the variant:
   .is-enable    — no mic permission yet: 5s hold-to-enable progress bar
   .is-prompting — the browser's permission prompt is up
   .is-denied    — permission blocked: instructions, no bar
   .is-recording — live dictation: pulsing mic, captions, picker, engine status
   .is-finalizing— released; the engine is producing the final transcript
   .is-picking   — released over the mic picker: interactive device choice */
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
  padding: 12px 16px;
  text-align: center;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  color: var(--ink);
  background: color-mix(in srgb, var(--ctx) 22%, color-mix(in srgb, var(--bg) 82%, transparent));
  backdrop-filter: blur(10px) saturate(1.4);
  -webkit-backdrop-filter: blur(10px) saturate(1.4);
}
slicc-composer .slicc-composer__ptt-microw {
  display: flex;
  align-items: center;
  gap: 10px;
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
}
/* Hold-to-enable: the bar sweeps over the SAME 5s the gesture timer counts
   (HOLD_TO_ENABLE_MS) — the animation is presentation, the timer is truth. */
slicc-composer .slicc-composer__ptt.is-enable .slicc-composer__ptt-bar-fill {
  animation-name: slicc-ptt-load;
  animation-duration: 5s;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}
slicc-composer .slicc-composer__ptt.is-prompting .slicc-composer__ptt-bar-fill {
  animation: none;
  transform: scaleX(1);
}
/* Live dictation: the big button reads as actively recording. */
slicc-composer .slicc-composer__ptt.is-recording .slicc-composer__ptt-mic {
  animation-name: slicc-ptt-pulse;
  animation-duration: 1.1s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
/* Closed-caption line under the mic: movie-CC styling (fixed dark pill +
   white text in both themes), trailing words only, single line. */
slicc-composer .slicc-composer__ptt-caption {
  max-width: min(520px, 86%);
  padding: 4px 12px;
  border-radius: 8px;
  background: rgba(12, 12, 14, 0.78);
  color: #fff;
  font-family: var(--ui);
  font-size: 14px;
  line-height: 1.45;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
slicc-composer .slicc-composer__ptt-caption[hidden] {
  display: none;
}
slicc-composer .slicc-composer__ptt-caption.is-error {
  background: color-mix(in srgb, #b91c1c 82%, black);
}
/* Engine status: the "better speech recognition downloading…" line. */
slicc-composer .slicc-composer__ptt-status {
  font-family: var(--ui);
  font-size: 11.5px;
  color: var(--txt-2);
}
slicc-composer .slicc-composer__ptt-status[hidden] {
  display: none;
}
/* Mic picker next to the mic circle (shown when >1 input exists): just a
   small muted triangle — no device label. A release OVER it flips the
   overlay into its interactive picking state, where the option menu opens. */
slicc-composer .slicc-composer__ptt-device {
  position: relative;
  display: inline-flex;
}
slicc-composer .slicc-composer__ptt-device[hidden] {
  display: none;
}
slicc-composer .slicc-composer__ptt-device-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--txt-3);
  cursor: pointer;
}
slicc-composer .slicc-composer__ptt-device-btn:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}
slicc-composer .slicc-composer__ptt-device-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  min-width: 170px;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--canvas);
  box-shadow:
    0 10px 28px -10px rgba(10, 10, 10, 0.22),
    0 2px 8px -4px rgba(10, 10, 10, 0.12);
  display: flex;
  flex-direction: column;
  z-index: 1;
}
slicc-composer .slicc-composer__ptt-device-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--ink);
  font-family: var(--ui);
  font-size: 12.5px;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}
slicc-composer .slicc-composer__ptt-device-item:hover,
slicc-composer .slicc-composer__ptt-device-item:focus-visible {
  background: var(--ghost);
  outline: none;
}
slicc-composer .slicc-composer__ptt-device-item .tick {
  margin-left: auto;
  display: inline-flex;
  color: var(--violet);
  visibility: hidden;
}
slicc-composer .slicc-composer__ptt-device-item[aria-checked='true'] .tick {
  visibility: visible;
}
slicc-composer .slicc-composer__ptt.is-picking {
  cursor: default;
}
@keyframes slicc-ptt-load {
  from { transform: scaleX(0); }
  to { transform: scaleX(1); }
}
@keyframes slicc-ptt-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.08); }
}
/* Reduced motion: no progress sweep and no mic pulse — hold the static state
   (the fill sits full) while the gesture stays fully functional (the
   hold-to-enable gate is timer-driven, not animation-driven). */
@media (prefers-reduced-motion: reduce) {
  slicc-composer .slicc-composer__ptt-bar-fill,
  slicc-composer .slicc-composer__ptt.is-enable .slicc-composer__ptt-bar-fill {
    animation-name: none;
    transform: scaleX(1);
  }
  slicc-composer .slicc-composer__ptt.is-recording .slicc-composer__ptt-mic {
    animation-name: none;
  }
}
`;

const STYLE_ID = 'slicc-composer-style';

/** Inject the scoped composer stylesheet into a document once (idempotent). */
function ensureComposerStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** How long the textarea must be held before the mic permission is requested.
 *  Mirrored by the `.is-enable` bar's 5s CSS sweep — keep the two in step. */
export const HOLD_TO_ENABLE_MS = 5000;

/** Grace window for the cached-permission check on mousedown: a fast
 *  'granted' goes straight to recording with no enable-stage flash. */
const PERMISSION_RACE_MS = 60;

/** The caption line keeps only the trailing words, like movie closed captions. */
const CAPTION_MAX_WORDS = 8;

/** localStorage key persisting the user's preferred microphone deviceId. */
const DEVICE_STORAGE_KEY = 'slicc-composer:mic-device';

/** The press lifecycle. `idle` means no overlay is mounted. */
type PttStage = 'idle' | 'enable' | 'prompting' | 'denied' | 'recording' | 'finalizing' | 'picking';

function readStoredDevice(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(DEVICE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeDevice(deviceId: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (deviceId) localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
    else localStorage.removeItem(DEVICE_STORAGE_KEY);
  } catch {
    /* private mode / quota — preference just doesn't persist */
  }
}

/** "ready in ~38s" / "~2m 10s" for the download status line. */
function formatEta(etaSeconds: number | null): string {
  if (etaSeconds == null || !Number.isFinite(etaSeconds)) return '';
  if (etaSeconds < 60) return `~${Math.max(1, Math.round(etaSeconds))}s`;
  const minutes = Math.floor(etaSeconds / 60);
  const seconds = Math.round(etaSeconds % 60);
  return `~${minutes}m ${seconds}s`;
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
 * composed by tag.
 *
 * Push-to-talk (opt-in via the `ptt` attribute): pressing and HOLDING any
 * slotted textarea turns the band into one big walkie-talkie button, in two
 * stages keyed to the microphone permission:
 *
 * 1. **Not granted** — a "Hold to enable push to talk" progress bar fills over
 *    five seconds ({@link HOLD_TO_ENABLE_MS}); a press held to completion
 *    requests microphone permission through the injected speech controller
 *    (triggering the browser prompt). A denied/blocked permission renders
 *    instructions instead of a bar.
 * 2. **Granted** — holding records: a pulsing mic, a closed-caption line
 *    streaming the last detected words, a microphone picker (when more than
 *    one input exists — a subtle triangle next to the mic; releasing OVER it
 *    opens the device menu instead of submitting), and an engine
 *    status line while a better on-device model downloads ("Better speech
 *    recognition downloading · ready in ~ETA"). Releasing stops the engine,
 *    appends the final transcript to the textarea, and submits it (via the
 *    slotted `slicc-input-card`'s `submit()` when present, else a composed
 *    `submit` CustomEvent from the textarea). A quick click stays a native
 *    caret press — no transcript, no submit. The pointer leaving the band
 *    cancels without inserting.
 *
 * The audio stack is pluggable: assign a {@link ComposerSpeech} to the `speech`
 * property (the webapp injects its whisper-upgradable controller); without one
 * the component falls back to the built-in Web Speech implementation from
 * `./speech.js`.
 *
 * The `open` host attribute mirrors the prototype's `.shell.open`: in the
 * narrow-chat layout the meta row's keyboard hint is hidden (anything carrying
 * the `data-composer-hint` attribute or the `.slicc-composer__hint` class),
 * keeping just the model + thinking controls.
 *
 * @attr open - boolean; narrow-chat variant (hides the meta keyboard hint), mirrors `.shell.open`
 * @attr ptt - boolean; OPT-IN: enables push-to-talk dictation on slotted
 *   textareas. Hosts that need plain caret presses leave it unset.
 * @prop {ComposerSpeech|null} speech - the injected speech controller (defaults
 *   to the built-in Web Speech implementation on first use)
 * @prop {string|null} device - preferred microphone deviceId (persisted to
 *   localStorage; capture-based engines only)
 * @csspart inner - the centered, `680px`-max `.composer-inner` band
 * @slot - default; the input card + meta row, rendered in DOM order
 */
export class SliccComposer extends HTMLElement {
  static readonly observedAttributes = ['open'];

  #inner!: HTMLElement;
  #built = false;

  /** The push-to-talk overlay while a gesture is active (null at rest). */
  #ptt: HTMLElement | null = null;
  /** Where the active press is in its lifecycle. */
  #stage: PttStage = 'idle';
  /** Whether the pointer is currently held. */
  #pressed = false;
  /** Monotonic press counter — async continuations from a stale press bail. */
  #token = 0;
  /** The textarea the active gesture started on (the dictation target). */
  #target: HTMLTextAreaElement | null = null;
  /** The live dictation session while recording. */
  #session: SpeechSession | null = null;
  /** Injected (or lazily-created builtin) speech controller. */
  #speech: ComposerSpeech | null = null;
  /** Cached permission snapshot from the controller. */
  #perm: PermissionState | 'unknown' = 'unknown';
  /** Preferred microphone deviceId (persisted). */
  #device: string | null = readStoredDevice();
  /** Hold-to-enable gate timer. */
  #enableTimer: ReturnType<typeof setTimeout> | null = null;
  /** Engine status subscription teardown (active while the overlay is up). */
  #statusUnsub: (() => void) | null = null;
  /** Latest engine status snapshot for the status line. */
  #status: SpeechEngineStatus | null = null;

  // Overlay element refs (valid while #ptt is mounted).
  #labelEl: HTMLElement | null = null;
  #captionEl: HTMLElement | null = null;
  #statusEl: HTMLElement | null = null;
  #deviceWrap: HTMLElement | null = null;
  #deviceMenu: HTMLElement | null = null;
  /** The microphones resolved for the active overlay (picker options). */
  #mics: { deviceId: string; label: string }[] = [];

  connectedCallback(): void {
    ensureComposerStyle(this.ownerDocument);
    this.#build();
    // Delegate the walkie-talkie gesture from the host so it works for whatever
    // textarea the slotted input card renders (light DOM is reachable here).
    this.addEventListener('mousedown', this.#onMouseDown);
  }

  disconnectedCallback(): void {
    this.removeEventListener('mousedown', this.#onMouseDown);
    // Tear down a gesture in flight so a detach never strands the overlay or
    // its document-level listeners.
    this.#session?.cancel();
    this.#session = null;
    this.#pressed = false;
    this.#target = null;
    this.#token++;
    if (this.#enableTimer) clearTimeout(this.#enableTimer);
    this.#enableTimer = null;
    this.#removePressListeners();
    this.#removePickingListeners();
    this.#teardownOverlay();
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

  /**
   * The speech controller behind push-to-talk. Hosts inject their own
   * (the webapp's controller upgrades to an on-device whisper model);
   * reading it lazily creates the built-in Web Speech fallback.
   */
  get speech(): ComposerSpeech {
    this.#speech ??= createBuiltinComposerSpeech();
    return this.#speech;
  }

  set speech(value: ComposerSpeech | null) {
    this.#speech = value;
    this.#perm = 'unknown';
  }

  /** Preferred microphone deviceId (capture-based engines only; persisted). */
  get device(): string | null {
    return this.#device;
  }

  set device(value: string | null) {
    this.#device = value;
    storeDevice(value);
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

  // ── Gesture lifecycle ─────────────────────────────────────────────

  /**
   * Begin the push-to-talk gesture: pressing a slotted textarea arms the
   * permission-staged hold. No `preventDefault` — a quick press-release keeps
   * its native caret placement (and an empty transcript never submits), so
   * clicking to type is unaffected.
   */
  #onMouseDown = (e: MouseEvent): void => {
    if (!this.hasAttribute('ptt')) return;
    if (this.#pressed || e.button !== 0) return;
    // A finalize/picking overlay is still settling — don't stack a new press.
    if (this.#stage === 'finalizing' || this.#stage === 'picking') return;
    const target = e.target as Element | null;
    const ta = target?.closest?.('textarea');
    if (!(ta instanceof HTMLTextAreaElement) || !this.contains(ta)) return;

    this.#pressed = true;
    this.#token++;
    this.#target = ta;
    const doc = this.ownerDocument;
    doc.addEventListener('mouseup', this.#onDocMouseUp);
    this.addEventListener('mouseleave', this.#onMouseLeave);

    void this.#beginPress(this.speech, this.#token);
  };

  /**
   * Route the fresh press by permission state. A cached/fast 'granted' goes
   * straight to recording; otherwise the hold-to-enable stage runs while the
   * (possibly slow) permission query settles in the background.
   */
  async #beginPress(speech: ComposerSpeech, token: number): Promise<void> {
    const settled = await Promise.race([
      speech.permission().then((state) => {
        this.#perm = state;
        return state;
      }),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), PERMISSION_RACE_MS)),
    ]);
    if (token !== this.#token || !this.#pressed) return;

    if (settled === 'granted') {
      this.#startRecording(speech, token);
      return;
    }
    if (settled === 'denied') {
      this.#showOverlay('denied');
      return;
    }

    // 'prompt', or the query is still settling — run the 5s enable gate.
    this.#showOverlay('enable');
    this.#enableTimer = setTimeout(() => {
      this.#enableTimer = null;
      this.#onHoldComplete(speech, token);
    }, HOLD_TO_ENABLE_MS);

    if (settled === 'pending') {
      // A slow query that lands 'granted' mid-hold upgrades the press in
      // place; 'denied' swaps in the blocked instructions.
      void speech.permission().then((state) => {
        this.#perm = state;
        if (token !== this.#token || !this.#pressed || this.#stage !== 'enable') return;
        if (state === 'granted') {
          this.#clearEnableTimer();
          this.#startRecording(speech, token);
        } else if (state === 'denied') {
          this.#clearEnableTimer();
          this.#showOverlay('denied');
        }
      });
    }
  }

  /** The 5s hold completed — request microphone permission. */
  #onHoldComplete(speech: ComposerSpeech, token: number): void {
    if (token !== this.#token || !this.#pressed || this.#stage !== 'enable') return;
    this.#showOverlay('prompting');
    void speech.requestPermission().then((granted) => {
      this.#perm = granted ? 'granted' : 'denied';
      if (granted) speech.warmup();
      if (token !== this.#token) return;
      if (granted && this.#pressed) {
        this.#startRecording(speech, token);
      } else if (granted) {
        // Released while the native prompt was up — armed for the next hold.
        this.#teardownOverlay();
      } else if (this.#pressed) {
        this.#showOverlay('denied');
      } else {
        this.#teardownOverlay();
      }
    });
  }

  /** Enter the live dictation stage (permission granted, pointer held). */
  #startRecording(speech: ComposerSpeech, token: number): void {
    this.#stage = 'recording';
    this.#showOverlay('recording');
    // First granted hold kicks the enhanced-model download in the background.
    speech.warmup();

    this.#statusUnsub?.();
    this.#statusUnsub = speech.onStatus((status) => {
      this.#status = status;
      this.#renderStatusLine();
    });

    void speech.microphones().then((mics) => {
      if (token !== this.#token) return;
      if (mics.length > 1) this.#renderDevicePicker(mics);
    });

    void speech
      .start({
        deviceId: this.#device ?? undefined,
        onPartial: (text) => {
          if (token === this.#token) this.#renderCaption(text);
        },
        onError: (message) => {
          if (token === this.#token) this.#renderCaption(message, true);
        },
      })
      .then((session) => {
        if (token !== this.#token || this.#stage !== 'recording') {
          session.cancel();
          return;
        }
        if (!this.#pressed) {
          // Released before the engine came up — nothing was heard.
          session.cancel();
          this.#target = null;
          this.#teardownOverlay();
          return;
        }
        this.#session = session;
      })
      .catch((err) => {
        if (token !== this.#token) return;
        this.#renderCaption(err instanceof Error ? err.message : String(err), true);
      });
  }

  /** A release anywhere ends the gesture; over the mic picker it opens it. */
  #onDocMouseUp = (e: MouseEvent): void => {
    if (!this.#pressed) return;
    if (
      this.#stage === 'recording' &&
      this.#deviceWrap &&
      !this.#deviceWrap.hidden &&
      e.composedPath().includes(this.#deviceWrap)
    ) {
      // Release over the picker: the user wants a different mic, not a send.
      this.#pressed = false;
      this.#removePressListeners();
      this.#session?.cancel();
      this.#session = null;
      this.#target = null;
      this.#enterPicking();
      return;
    }
    this.#endPress(true);
  };

  /**
   * The pointer left the host mid-press: tear down WITHOUT inserting. This is
   * the stuck-state guard — a release outside the host no longer reaches us
   * once the press is cancelled here.
   */
  #onMouseLeave = (): void => {
    this.#endPress(false);
  };

  /**
   * End an active press. On a real release (`finalize`) while recording, the
   * session stops and its transcript is appended + submitted; every other path
   * (cancel, enable-stage release, denied) tears down without inserting. The
   * prompting stage outlives the press — the permission continuation owns its
   * teardown so the user sees the prompt outcome.
   */
  #endPress(finalize: boolean): void {
    if (!this.#pressed) return;
    this.#pressed = false;
    this.#removePressListeners();

    switch (this.#stage) {
      case 'enable':
        this.#clearEnableTimer();
        this.#target = null;
        this.#teardownOverlay();
        return;
      case 'prompting':
        // Keep the overlay — #onHoldComplete's continuation tears it down.
        this.#target = null;
        return;
      case 'denied':
        this.#target = null;
        this.#teardownOverlay();
        return;
      case 'recording':
        break;
      default:
        this.#target = null;
        this.#teardownOverlay();
        return;
    }

    const session = this.#session;
    this.#session = null;
    if (!finalize) {
      session?.cancel();
      this.#target = null;
      this.#teardownOverlay();
      return;
    }
    if (!session) {
      // Quick click: the engine never came up — keep the caret behavior.
      this.#target = null;
      this.#teardownOverlay();
      return;
    }

    this.#stage = 'finalizing';
    this.#renderCaption('Transcribing…');
    const token = this.#token;
    session
      .stop()
      .then((text) => {
        if (token !== this.#token) return;
        this.#teardownOverlay();
        this.#commit(text);
      })
      .catch(() => {
        if (token !== this.#token) return;
        this.#teardownOverlay();
        this.#target = null;
      });
  }

  /** Append the final transcript to the textarea and submit it. */
  #commit(text: string): void {
    const ta = this.#target;
    this.#target = null;
    if (!ta) return;
    const transcript = text.trim();
    if (!transcript) {
      // Nothing heard — leave the press as a plain focus.
      ta.focus();
      return;
    }
    ta.value = ta.value
      ? /\s$/.test(ta.value)
        ? ta.value + transcript
        : `${ta.value} ${transcript}`
      : transcript;
    // Notify the host (e.g. slicc-input-card) so it syncs its value + autosize.
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();

    // Submit through the slotted input card's public contract when present
    // (keeps the empty/disabled guards single-sourced); otherwise emit the
    // same composed `submit` shape from the textarea for generic hosts.
    const card = ta.closest('slicc-input-card') as (HTMLElement & { submit?: () => void }) | null;
    if (card && typeof card.submit === 'function') {
      card.submit();
    } else {
      ta.dispatchEvent(
        new CustomEvent('submit', { bubbles: true, composed: true, detail: { value: ta.value } })
      );
    }
  }

  #clearEnableTimer(): void {
    if (this.#enableTimer) clearTimeout(this.#enableTimer);
    this.#enableTimer = null;
  }

  #removePressListeners(): void {
    this.ownerDocument.removeEventListener('mouseup', this.#onDocMouseUp);
    this.removeEventListener('mouseleave', this.#onMouseLeave);
  }

  // ── Device picking ────────────────────────────────────────────────

  /** Released over the mic picker: keep the overlay up, open the menu. */
  #enterPicking(): void {
    this.#stage = 'picking';
    this.#applyStageClass('picking');
    if (this.#labelEl) this.#labelEl.textContent = 'Choose a microphone';
    if (this.#captionEl) this.#captionEl.hidden = true;
    this.#openDeviceMenu();
    const doc = this.ownerDocument;
    doc.addEventListener('mousedown', this.#onPickingDocDown, true);
    doc.addEventListener('keydown', this.#onPickingKey, true);
  }

  /** Build + show the option menu under the picker triangle. */
  #openDeviceMenu(): void {
    const wrap = this.#deviceWrap;
    if (!wrap || this.#deviceMenu) return;
    const menu = h('div', { class: 'slicc-composer__ptt-device-menu', role: 'menu' });
    let focusRow: HTMLElement | null = null;
    for (const mic of this.#mics) {
      const selected = mic.deviceId === this.#device;
      const row = h(
        'button',
        {
          type: 'button',
          class: 'slicc-composer__ptt-device-item',
          role: 'menuitemradio',
          'aria-checked': selected ? 'true' : 'false',
          'data-device-id': mic.deviceId,
        },
        mic.label,
        h('span', { class: 'tick' }, iconEl('check', { size: 14 }))
      );
      row.addEventListener('click', () => {
        this.device = mic.deviceId;
        this.#exitPicking();
      });
      if (selected || !focusRow) focusRow = row;
      menu.appendChild(row);
    }
    this.#deviceMenu = menu;
    wrap.appendChild(menu);
    focusRow?.focus();
  }

  #onPickingDocDown = (e: MouseEvent): void => {
    if (this.#deviceWrap && e.composedPath().includes(this.#deviceWrap)) return;
    this.#exitPicking();
  };

  #onPickingKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.#exitPicking();
    }
  };

  #removePickingListeners(): void {
    const doc = this.ownerDocument;
    doc.removeEventListener('mousedown', this.#onPickingDocDown, true);
    doc.removeEventListener('keydown', this.#onPickingKey, true);
  }

  #exitPicking(): void {
    this.#removePickingListeners();
    this.#teardownOverlay();
  }

  // ── Overlay rendering ─────────────────────────────────────────────

  /** Ensure the overlay container exists and render the given stage into it. */
  #showOverlay(stage: Exclude<PttStage, 'idle' | 'finalizing' | 'picking'>): void {
    this.#stage = stage;
    if (!this.#ptt) {
      this.#ptt = h('div', { class: 'slicc-composer__ptt', 'data-ptt': true, role: 'button' });
      this.appendChild(this.#ptt);
    }
    this.#applyStageClass(stage);

    switch (stage) {
      case 'enable':
        this.#renderOverlayContent(
          iconEl('mic', { size: 28 }),
          'Hold to enable push to talk',
          this.#loadRow('Requesting microphone access when the bar fills')
        );
        this.#ptt.setAttribute('aria-label', 'Hold to enable push to talk');
        break;
      case 'prompting':
        this.#renderOverlayContent(
          iconEl('mic', { size: 28 }),
          'Allow microphone access in the browser prompt',
          this.#loadRow('Waiting for permission…')
        );
        this.#ptt.setAttribute('aria-label', 'Waiting for microphone permission');
        break;
      case 'denied':
        this.#renderOverlayContent(
          iconEl('mic-off', { size: 28 }),
          'Microphone access is blocked',
          h(
            'div',
            { class: 'slicc-composer__ptt-load-text' },
            'Enable the microphone for this site in your browser settings, then hold again.'
          )
        );
        this.#ptt.setAttribute('aria-label', 'Microphone access is blocked');
        break;
      case 'recording': {
        this.#deviceWrap = h('div', { class: 'slicc-composer__ptt-device', hidden: true });
        this.#captionEl = h('div', {
          class: 'slicc-composer__ptt-caption',
          'aria-live': 'polite',
          hidden: true,
        });
        this.#statusEl = h('div', { class: 'slicc-composer__ptt-status', hidden: true });
        const mic = h(
          'div',
          { class: 'slicc-composer__ptt-microw' },
          h('div', { class: 'slicc-composer__ptt-mic' }, iconEl('mic', { size: 28 })),
          this.#deviceWrap
        );
        this.#labelEl = h(
          'div',
          { class: 'slicc-composer__ptt-label' },
          'Listening — release to send'
        );
        this.#ptt.replaceChildren(mic, this.#labelEl, this.#captionEl, this.#statusEl);
        this.#ptt.setAttribute('aria-label', 'Listening — release to send');
        this.#renderStatusLine();
        break;
      }
    }
  }

  /** Standard non-recording overlay: mic circle, headline, one detail row. */
  #renderOverlayContent(icon: SVGSVGElement, label: string, detail: HTMLElement): void {
    if (!this.#ptt) return;
    this.#labelEl = h('div', { class: 'slicc-composer__ptt-label' }, label);
    this.#captionEl = null;
    this.#statusEl = null;
    this.#deviceWrap = null;
    this.#deviceMenu = null;
    this.#mics = [];
    this.#ptt.replaceChildren(
      h('div', { class: 'slicc-composer__ptt-mic' }, icon),
      this.#labelEl,
      detail
    );
  }

  /** The label + progress-bar row used by the enable/prompting stages. */
  #loadRow(text: string): HTMLElement {
    return h(
      'div',
      { class: 'slicc-composer__ptt-load' },
      h('span', { class: 'slicc-composer__ptt-load-text' }, text),
      h(
        'div',
        { class: 'slicc-composer__ptt-bar' },
        h('div', { class: 'slicc-composer__ptt-bar-fill' })
      )
    );
  }

  #applyStageClass(stage: PttStage): void {
    if (!this.#ptt) return;
    this.#ptt.classList.remove(
      'is-enable',
      'is-prompting',
      'is-denied',
      'is-recording',
      'is-finalizing',
      'is-picking'
    );
    if (stage !== 'idle') this.#ptt.classList.add(`is-${stage}`);
  }

  /** Closed-caption line: trailing words only, single line, error styling. */
  #renderCaption(text: string, isError = false): void {
    const caption = this.#captionEl;
    if (!caption) return;
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      caption.hidden = true;
      return;
    }
    caption.textContent = words.slice(-CAPTION_MAX_WORDS).join(' ');
    caption.classList.toggle('is-error', isError);
    caption.hidden = false;
  }

  /** The "better speech recognition downloading · ready in ~ETA" line. */
  #renderStatusLine(): void {
    const el = this.#statusEl;
    if (!el) return;
    const status = this.#status;
    if (status?.state === 'downloading') {
      const eta = formatEta(status.download?.etaSeconds ?? null);
      el.textContent = eta
        ? `Better speech recognition downloading · ready in ${eta}`
        : 'Better speech recognition downloading…';
      el.hidden = false;
    } else if (status?.state === 'ready' && status.engine === 'enhanced') {
      el.textContent = 'Enhanced speech recognition';
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  /**
   * Show the mic picker (called when >1 input device exists): just a small
   * muted triangle next to the mic circle — releasing the held press over it
   * opens the option menu instead of submitting.
   */
  #renderDevicePicker(mics: { deviceId: string; label: string }[]): void {
    const wrap = this.#deviceWrap;
    if (!wrap) return;
    this.#mics = mics;
    const toggle = h(
      'button',
      {
        type: 'button',
        class: 'slicc-composer__ptt-device-btn',
        'aria-label': 'Choose a microphone',
        'aria-haspopup': 'menu',
        title: 'Choose a microphone',
      },
      iconEl('chevron-down', { size: 12 })
    );
    // Keep picker clicks from reading as overlay interactions.
    toggle.addEventListener('mousedown', (e) => e.stopPropagation());
    wrap.replaceChildren(toggle);
    wrap.hidden = false;
  }

  /** Drop the overlay and every per-overlay subscription. */
  #teardownOverlay(): void {
    this.#statusUnsub?.();
    this.#statusUnsub = null;
    this.#ptt?.remove();
    this.#ptt = null;
    this.#labelEl = null;
    this.#captionEl = null;
    this.#statusEl = null;
    this.#deviceWrap = null;
    this.#deviceMenu = null;
    this.#mics = [];
    this.#stage = 'idle';
  }
}

define('slicc-composer', SliccComposer);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-composer': SliccComposer;
  }
}
