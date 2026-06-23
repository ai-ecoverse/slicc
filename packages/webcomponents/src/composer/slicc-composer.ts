import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import { shouldShowDevicePicker } from './devices.js';
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
   .is-enable    — no mic permission yet: 3s hold-to-enable progress bar
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
  /* Touch ergonomics: the overlay covers the whole footer once a hold has
     engaged, so swallow the gesture here — no scroll-pan stealing the hold,
     no iOS long-press callout / selection menu on top of the recording UI. */
  touch-action: none;
  -webkit-touch-callout: none;
  color: var(--ink);
  background: color-mix(in srgb, var(--ctx) 22%, color-mix(in srgb, var(--bg) 82%, transparent));
  backdrop-filter: blur(10px) saturate(1.4);
  -webkit-backdrop-filter: blur(10px) saturate(1.4);
}
/* Touch-action is locked by the browser at the START of a pointer sequence,
   so suppressing scroll-pan / iOS long-press callout mid-gesture (on
   pointerdown) is ignored for the in-flight touch — a finger that drifts can
   still start a pan and fire pointercancel. Apply those at the [ptt]-enabled
   state so they're in effect BEFORE any touch begins. Selection suppression
   stays scoped to the active hold so the resting textarea keeps normal
   selection. */
slicc-composer[ptt] textarea {
  touch-action: none;
  -webkit-touch-callout: none;
}
slicc-composer[data-ptt-pressed] textarea {
  user-select: none;
  -webkit-user-select: none;
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
/* Hold-to-enable: the bar sweeps over the SAME 3s the gesture timer counts
   (HOLD_TO_ENABLE_MS) — the animation is presentation, the timer is truth. */
slicc-composer .slicc-composer__ptt.is-enable .slicc-composer__ptt-bar-fill {
  animation-name: slicc-ptt-load;
  animation-duration: 3s;
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
slicc-composer .slicc-composer__ptt-status.is-error {
  color: color-mix(in srgb, #f87171 88%, white);
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
  overflow-y: auto;
  z-index: 1;
}
/* Flip upward when there isn't enough room below the picker (set by
   #positionDeviceMenu after measuring against the viewport). */
slicc-composer .slicc-composer__ptt-device-menu--up {
  top: auto;
  bottom: calc(100% + 6px);
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
 *  Mirrored by the `.is-enable` bar's 3s CSS sweep — keep the two in step. */
export const HOLD_TO_ENABLE_MS = 3000;

/** Grace window for the cached-permission check on mousedown: a fast
 *  'granted' goes straight to recording with no enable-stage flash. */
const PERMISSION_RACE_MS = 60;

/** Delay between mousedown and arming the push-to-talk lifecycle. A pure
 *  click whose release lands within this window never flashes the overlay
 *  or touches the speech controller, so plain caret presses stay silent. */
export const PTT_ENGAGE_MS = 100;

/** Upper bound on the mic-permission request. A two-layer permission model can
 *  leave `getUserMedia({audio:true})` never settling (the browser/site grant
 *  succeeds but capture stalls) — without a bound the prompting overlay would
 *  freeze forever at "Waiting for permission…". When this elapses the request
 *  is treated as failed so the gesture always recovers. */
export const PERMISSION_REQUEST_TIMEOUT_MS = 10_000;

/** Reject with `error` when `promise` has not settled within `ms`. The timer is
 *  cleared on settle, and a late settle of an already-timed-out promise is a
 *  no-op, so neither side leaks an unhandled rejection or a dangling timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, error: Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

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
 *    three seconds ({@link HOLD_TO_ENABLE_MS}); a press held to completion
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
  /** The pointerId of the active press (for capture + multi-pointer filtering). */
  #pointerId: number | null = null;
  /** The live dictation session while recording. */
  #session: SpeechSession | null = null;
  /** An in-flight `speech.start()` (enhanced engines resolve asynchronously).
   *  A release/cancel/reset that lands before it resolves takes ownership of
   *  this promise (nulling it) and awaits it to stop/cancel the session, so a
   *  late `.then` never cancels a session the user wants finalized. */
  #startingSession: Promise<SpeechSession> | null = null;
  /** Injected (or lazily-created builtin) speech controller. */
  #speech: ComposerSpeech | null = null;
  /** Cached permission snapshot from the controller. */
  #perm: PermissionState | 'unknown' = 'unknown';
  /** Preferred microphone deviceId (persisted). */
  #device: string | null = readStoredDevice();
  /** Hold-to-enable gate timer. */
  #enableTimer: ReturnType<typeof setTimeout> | null = null;
  /** Engage-delay timer: defers the press lifecycle until the pointer has
   *  been held past {@link PTT_ENGAGE_MS} so a pure click never flashes. */
  #engageTimer: ReturnType<typeof setTimeout> | null = null;
  /** Engine status subscription teardown (active while the overlay is up). */
  #statusUnsub: (() => void) | null = null;
  /** Latest engine status snapshot for the status line. */
  #status: SpeechEngineStatus | null = null;
  /** A surfaced message for the `denied` overlay when the request stalled or
   *  rejected (vs. a genuine browser block). Null falls back to the standard
   *  "blocked in settings" instructions. Reset each prompt cycle / teardown. */
  #permissionError: string | null = null;

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
    // Pointer Events unify mouse + touch + pen and fire once (no synthetic
    // 300ms mouse double-fire on mobile), so a single listener covers all
    // input modalities.
    this.addEventListener('pointerdown', this.#onPointerDown);
  }

  disconnectedCallback(): void {
    this.removeEventListener('pointerdown', this.#onPointerDown);
    // Tear down a gesture in flight so a detach never strands the overlay or
    // its document-level listeners.
    this.#session?.cancel();
    this.#session = null;
    this.#cancelPendingStart();
    this.#pressed = false;
    this.#target = null;
    this.#token++;
    this.#releasePointerCapture();
    this.#clearEngageTimer();
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
   * tapping to type is unaffected on every input modality (mouse, touch, pen).
   *
   * Gated to the PRIMARY pointer (`isPrimary`) so a second touch finger doesn't
   * try to stack a press. The primary-button guard (`button === 0`) is safe for
   * touch/pen too — both report button 0 on a primary press.
   */
  #onPointerDown = (e: PointerEvent): void => {
    if (!this.hasAttribute('ptt')) return;
    if (!e.isPrimary) return;
    if (this.#pressed || e.button !== 0) return;
    // A finalize/picking overlay is still settling — don't stack a new press.
    if (this.#stage === 'finalizing' || this.#stage === 'picking') return;
    const target = e.target as Element | null;
    const ta = target?.closest?.('textarea');
    if (!(ta instanceof HTMLTextAreaElement) || !this.contains(ta)) return;

    this.#pressed = true;
    this.#token++;
    this.#target = ta;
    this.#pointerId = e.pointerId;
    // Capture the pointer on the host so the release `pointerup` is delivered
    // here even if the finger drifts off the textarea (or off the host). This
    // is the primary stuck-state guard for touch — pointer capture is the
    // mechanism, `pointercancel` covers the system-interrupt cases. In
    // synthetic test envs the underlying pointer doesn't exist and the call
    // throws; the doc-level `pointerup` listener still ends the gesture.
    try {
      this.setPointerCapture(e.pointerId);
    } catch {
      /* no real pointer (synthetic event / unsupported) — capture is best-effort */
    }
    // Marker attribute scoping the touch-action / iOS callout suppression to
    // the active hold (see the STYLE block). Cleared when the press releases.
    this.setAttribute('data-ptt-pressed', '');

    const doc = this.ownerDocument;
    doc.addEventListener('pointerup', this.#onDocPointerUp);
    this.addEventListener('pointercancel', this.#onPointerCancel);

    // Defer the press lifecycle so a pure tap (released within the engage
    // window) never flashes the overlay nor touches the speech controller.
    const engageToken = this.#token;
    this.#engageTimer = setTimeout(() => {
      this.#engageTimer = null;
      void this.#beginPress(this.speech, engageToken);
    }, PTT_ENGAGE_MS);
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

    // 'prompt', or the query is still settling — run the 3s enable gate.
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

  /** The 3s hold completed — request microphone permission. The request is
   *  bounded by a timeout and a catch so a stalled or rejected grant can never
   *  freeze the overlay at the prompting stage: it always resolves to recording,
   *  a surfaced denied/error state, or a clean teardown. */
  #onHoldComplete(speech: ComposerSpeech, token: number): void {
    if (token !== this.#token || !this.#pressed || this.#stage !== 'enable') return;
    this.#permissionError = null;
    this.#showOverlay('prompting');
    withTimeout(
      speech.requestPermission(),
      PERMISSION_REQUEST_TIMEOUT_MS,
      new Error("Microphone didn't respond. Check your mic, then hold again.")
    )
      .then((granted) => {
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
      })
      .catch((err: unknown) => {
        // A stalled (timed-out) or rejected permission request must still
        // recover the overlay — surface the failure when still held, otherwise
        // tear down silently (the press was already released).
        this.#perm = 'denied';
        if (token !== this.#token) return;
        if (this.#pressed) {
          this.#permissionError = err instanceof Error ? err.message : String(err);
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
      if (shouldShowDevicePicker(mics)) this.#renderDevicePicker(mics);
    });

    const startPromise = speech.start({
      deviceId: this.#device ?? undefined,
      onPartial: (text) => {
        if (token === this.#token) this.#renderCaption(text);
      },
      onError: (message) => {
        if (token === this.#token) this.#renderCaption(message, true);
      },
    });
    this.#startingSession = startPromise;
    startPromise
      .then((session) => {
        // A release/cancel/reset that lands while start() is still in flight
        // takes ownership of the pending start (it nulls #startingSession and
        // awaits this same promise to stop/cancel the session). Bail when
        // ownership has moved so we neither double-handle nor cancel a session
        // the user wants finalized.
        if (this.#startingSession !== startPromise) return;
        this.#startingSession = null;
        if (token !== this.#token || this.#stage !== 'recording') {
          session.cancel();
          return;
        }
        this.#session = session;
      })
      .catch((err) => {
        if (this.#startingSession !== startPromise) return;
        this.#startingSession = null;
        if (token !== this.#token) return;
        this.#renderCaption(err instanceof Error ? err.message : String(err), true);
      });
  }

  /** Abort an in-flight `speech.start()` once it resolves (teardown paths that
   *  don't finalize: detach, pointercancel, picker open). */
  #cancelPendingStart(): void {
    const pending = this.#startingSession;
    this.#startingSession = null;
    if (pending) {
      void pending.then(
        (session) => session.cancel(),
        () => {}
      );
    }
  }

  /** A release anywhere ends the gesture; over the mic picker it opens it. */
  #onDocPointerUp = (e: PointerEvent): void => {
    if (!this.#pressed) return;
    // Filter unrelated pointers (a non-primary touch finger releasing while
    // the captured primary press is still active).
    if (this.#pointerId != null && e.pointerId !== this.#pointerId) return;
    // Under pointer capture (the real-finger case) the release `pointerup` is
    // retargeted to the capture host, so `composedPath` no longer contains the
    // picker even when the finger lifted over it. Fall back to geometry via
    // `elementFromPoint` so the captured path still detects the hit. The
    // composedPath check stays first as the cheap synthetic-test +
    // non-captured-mouse path.
    const wrap = this.#deviceWrap;
    let overPicker = false;
    if (this.#stage === 'recording' && wrap && !wrap.hidden) {
      if (e.composedPath().includes(wrap)) {
        overPicker = true;
      } else {
        const hit = this.ownerDocument.elementFromPoint(e.clientX, e.clientY);
        overPicker = hit != null && wrap.contains(hit);
      }
    }
    if (overPicker) {
      // Release over the picker: the user wants a different mic, not a send.
      this.#pressed = false;
      this.#releasePointerCapture();
      this.#removePressListeners();
      this.#session?.cancel();
      this.#session = null;
      this.#cancelPendingStart();
      this.#target = null;
      this.#enterPicking();
      return;
    }
    this.#endPress(true);
  };

  /**
   * The active pointer was cancelled by the system mid-press (touch interrupted
   * by a scroll/system gesture, captured pointer lost). Tear down WITHOUT
   * inserting — equivalent to the previous `mouseleave` cancel path. The
   * "pointer left the host" stuck-state guard is now handled by pointer capture
   * (the host keeps receiving pointer events even when the finger drifts off),
   * so a dedicated `pointerleave` listener is intentionally not bound.
   */
  #onPointerCancel = (e: PointerEvent): void => {
    if (this.#pointerId != null && e.pointerId !== this.#pointerId) return;
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
    // A release within the engage window cancels the deferred lifecycle so
    // #beginPress never runs for this press (stage stays 'idle' below).
    this.#clearEngageTimer();
    this.#releasePointerCapture();
    this.#removePressListeners();

    switch (this.#stage) {
      case 'enable':
        this.#clearEnableTimer();
        this.#target = null;
        this.#teardownOverlay();
        return;
      case 'prompting':
        // Keep the overlay — the native prompt steals the pointer, so a release
        // here is expected. #onHoldComplete's continuation owns teardown and is
        // now bounded by a timeout, so it always recovers (no orphaned overlay).
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
    // Take ownership of an in-flight start() so its late `.then` won't cancel
    // a session this release wants finalized (the enhanced engine resolves
    // start() asynchronously — the user can release before it does).
    const pending = this.#startingSession;
    this.#startingSession = null;
    if (!finalize) {
      session?.cancel();
      if (pending)
        void pending.then(
          (s) => s.cancel(),
          () => {}
        );
      this.#target = null;
      this.#teardownOverlay();
      return;
    }
    if (!session && !pending) {
      // Quick click: the engine never came up — keep the caret behavior.
      this.#target = null;
      this.#teardownOverlay();
      return;
    }

    this.#stage = 'finalizing';
    this.#renderCaption('Transcribing…');
    const token = this.#token;
    // An already-resolved session stops immediately; a still-in-flight start
    // is awaited first so the captured audio is transcribed (not dropped).
    const resolved = session ? Promise.resolve(session) : (pending as Promise<SpeechSession>);
    resolved
      .then((s) => s.stop())
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
    // Either way `detail.source = 'dictation'` marks the turn as
    // voice-initiated so hosts can speak the reply back.
    const card = ta.closest('slicc-input-card') as
      | (HTMLElement & { submit?: (source?: string) => void })
      | null;
    if (card && typeof card.submit === 'function') {
      card.submit('dictation');
    } else {
      ta.dispatchEvent(
        new CustomEvent('submit', {
          bubbles: true,
          composed: true,
          detail: { value: ta.value, source: 'dictation' },
        })
      );
    }
  }

  #clearEnableTimer(): void {
    if (this.#enableTimer) clearTimeout(this.#enableTimer);
    this.#enableTimer = null;
  }

  #clearEngageTimer(): void {
    if (this.#engageTimer) clearTimeout(this.#engageTimer);
    this.#engageTimer = null;
  }

  #removePressListeners(): void {
    this.ownerDocument.removeEventListener('pointerup', this.#onDocPointerUp);
    this.removeEventListener('pointercancel', this.#onPointerCancel);
  }

  /** Release the captured primary pointer and clear the armed marker. */
  #releasePointerCapture(): void {
    const id = this.#pointerId;
    this.#pointerId = null;
    this.removeAttribute('data-ptt-pressed');
    if (id == null) return;
    try {
      this.releasePointerCapture(id);
    } catch {
      /* not captured (release races teardown, or capture never took) */
    }
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
    doc.addEventListener('pointerdown', this.#onPickingDocDown, true);
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
    this.#positionDeviceMenu(menu, wrap);
    focusRow?.focus();
  }

  /** Keep the open menu fully on-screen: flip it upward when there isn't
   *  enough room below the picker, and cap its height to the available
   *  space (with a sane ceiling) so an extreme device count scrolls
   *  instead of overflowing the bottom of the viewport. */
  #positionDeviceMenu(menu: HTMLElement, wrap: HTMLElement): void {
    const GAP = 6;
    const MARGIN = 8;
    const CEILING = 320;
    const rect = wrap.getBoundingClientRect();
    const viewportH = window.innerHeight || document.documentElement.clientHeight;
    const spaceBelow = viewportH - rect.bottom - GAP - MARGIN;
    const spaceAbove = rect.top - GAP - MARGIN;
    const openUp = menu.offsetHeight > spaceBelow && spaceAbove > spaceBelow;
    menu.classList.toggle('slicc-composer__ptt-device-menu--up', openUp);
    const available = Math.max(openUp ? spaceAbove : spaceBelow, 0);
    menu.style.maxHeight = `${Math.min(CEILING, available)}px`;
  }

  #onPickingDocDown = (e: PointerEvent): void => {
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
    doc.removeEventListener('pointerdown', this.#onPickingDocDown, true);
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
      case 'denied': {
        const headline = this.#permissionError
          ? 'Microphone unavailable'
          : 'Microphone access is blocked';
        const detail =
          this.#permissionError ??
          'Enable the microphone for this site in your browser settings, then hold again.';
        this.#renderOverlayContent(
          iconEl('mic-off', { size: 28 }),
          headline,
          h('div', { class: 'slicc-composer__ptt-load-text' }, detail)
        );
        this.#ptt.setAttribute('aria-label', headline);
        break;
      }
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
      if (status.download) {
        const eta = formatEta(status.download.etaSeconds ?? null);
        el.textContent = eta
          ? `Better speech recognition downloading · ready in ${eta}`
          : 'Better speech recognition downloading…';
      } else {
        // Staging the on-device assets (R10) — no byte totals yet.
        el.textContent = 'Preparing enhanced speech…';
      }
      el.classList.remove('is-error');
      el.hidden = false;
    } else if (status?.state === 'ready' && status.engine === 'enhanced') {
      el.textContent = 'Enhanced speech recognition';
      el.classList.remove('is-error');
      el.hidden = false;
    } else if (status?.state === 'unavailable' && status.message) {
      // Surface the actionable failure instead of silently hiding the line.
      el.textContent = status.message;
      el.classList.add('is-error');
      el.hidden = false;
    } else {
      el.classList.remove('is-error');
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
    // Keep picker presses from reading as overlay interactions.
    toggle.addEventListener('pointerdown', (e) => e.stopPropagation());
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
    this.#permissionError = null;
    this.#stage = 'idle';
  }
}

define('slicc-composer', SliccComposer);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-composer': SliccComposer;
  }
}
