import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import { pickDefaultMicId, shouldShowDevicePicker } from './devices.js';
import {
  type ComposerSpeech,
  createBuiltinComposerSpeech,
  type SpeechEngineStatus,
  type SpeechSession,
} from './speech.js';

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
/* Keyboard mode: the band is not taking typing, and it says so by receding.
   A dimmed card is the difference between "there is no caret here" and "the
   caret is somewhere you cannot see" — the question the mode exists to answer.
   The HUD keeps full strength by living OUTSIDE this subtree: it is pinned to
   the chat column, a sibling of the band, so the one thing at full contrast is
   the one thing the keyboard is talking to. Pointer events stay live: clicking
   into the composer is still how you leave the mode. */
slicc-composer[keys] > .slicc-composer__inner > * {
  opacity: 0.55;
  transition: opacity 160ms ease;
}
@media (prefers-reduced-motion: reduce) {
  slicc-composer[keys] > .slicc-composer__inner > * {
    transition: none;
  }
}
/* Full-bleed band inside the dock-tree shell: the VISUAL band extends past
   the chat column's right edge — under the floating tool pane, up to the
   frame clip — while the composer's content column is untouched (an open
   pane still pushes the textarea/labels left). The paint moves host →
   ::before so the extension is one continuous tint/blur with no seam at the
   column edge; the pseudo's z-index:-1 keeps it under the composer's own
   content inside the host's stacking context. The chrome tool tile
   (z-index 3, slicc-dock-tree.ts) and the dock rail (z-index 3,
   slicc-shell.ts) float ABOVE the band, which outranks them at the
   composer's z-index 2 otherwise. Extends RIGHT only: leftward it would
   paint over the freezer rail, which sits below the app column. */
.slicc-shell slicc-composer {
  border-top: none;
  background: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.slicc-shell slicc-composer::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: -100vw;
  z-index: -1;
  pointer-events: none;
  border-top: 1px solid var(--line);
  background: color-mix(in srgb, var(--ctx) 12%, color-mix(in srgb, var(--bg) 68%, transparent));
  backdrop-filter: blur(18px) saturate(1.4);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
}
/* Keyboard-mode HUD: same rightward bleed, same stacking. Scoped to the
   dock-tree shell so panel-layouts (sibling slicc-panels, no z-index 3
   tile wrapper) never get a 100vw bar painted over the adjacent tool panel. */
.slicc-shell slicc-key-hud::after {
  content: "";
  position: absolute;
  top: -1px;
  bottom: 0;
  left: 100%;
  width: 100vw;
  background: inherit;
  border-top: inherit;
  backdrop-filter: inherit;
  -webkit-backdrop-filter: inherit;
  pointer-events: none;
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
   .is-enable    — no mic permission yet: 1s hold-to-enable progress bar
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
/* Touch-action is locked by the browser at the START of a pointer sequence, so
   suppress scroll-pan / iOS long-press callout on the textarea BEFORE any touch
   begins — a finger that drifts mid-hold can otherwise start a pan and fire
   pointercancel. Scoped to an EMPTY composer (the placeholder is showing): that
   is the only state push-to-talk arms in, so a non-empty textarea keeps native
   touch scrolling and text selection. */
slicc-composer[ptt] textarea:placeholder-shown {
  touch-action: none;
  -webkit-touch-callout: none;
}
slicc-composer .slicc-composer__ptt-microw {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
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
/* Hold-to-enable: the bar sweeps over the SAME 1s the gesture timer counts
   (HOLD_TO_ENABLE_MS) — the animation is presentation, the timer is truth. */
slicc-composer .slicc-composer__ptt.is-enable .slicc-composer__ptt-bar-fill {
  animation-name: slicc-ptt-load;
  animation-duration: 1s;
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
  /* Anchored just to the right of the centered 56px mic circle (half-width
     28px + 10px gap) and absolutely positioned so it never participates in
     the row's centered layout — the mic circle stays put whether or not the
     picker chevron is showing. */
  position: absolute;
  top: 50%;
  left: 50%;
  margin-left: 38px;
  transform: translateY(-50%);
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

function ensureComposerStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export const HOLD_TO_ENABLE_MS = 1000;

const PERMISSION_RACE_MS = 60;

export const PTT_ENGAGE_MS = 400;

export const PERMISSION_REQUEST_TIMEOUT_MS = 10_000;

export const FINALIZE_TIMEOUT_MS = 45_000;

export const MIC_ENUMERATION_TIMEOUT_MS = 1500;

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

const CAPTION_MAX_WORDS = 8;

const DEVICE_STORAGE_KEY = 'slicc-composer:mic-device';

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
  } catch {}
}

function formatEta(etaSeconds: number | null): string {
  if (etaSeconds == null || !Number.isFinite(etaSeconds)) return '';
  if (etaSeconds < 60) return `~${Math.max(1, Math.round(etaSeconds))}s`;
  const minutes = Math.floor(etaSeconds / 60);
  const seconds = Math.round(etaSeconds % 60);
  return `~${minutes}m ${seconds}s`;
}

export class SliccComposer extends HTMLElement {
  static readonly observedAttributes = ['open'];

  #inner!: HTMLElement;
  #built = false;

  #ptt: HTMLElement | null = null;

  #stage: PttStage = 'idle';

  #pressed = false;

  #token = 0;

  #target: HTMLTextAreaElement | null = null;

  #pointerId: number | null = null;

  #handsFree = false;

  #session: SpeechSession | null = null;

  #startingSession: Promise<SpeechSession> | null = null;

  #speech: ComposerSpeech | null = null;

  #perm: PermissionState | 'unknown' = 'unknown';

  #device: string | null = readStoredDevice();

  #activeDevice: string | null = null;

  #enableTimer: ReturnType<typeof setTimeout> | null = null;

  #engageTimer: ReturnType<typeof setTimeout> | null = null;

  #statusUnsub: (() => void) | null = null;

  #status: SpeechEngineStatus | null = null;

  #permissionError: string | null = null;

  #labelEl: HTMLElement | null = null;
  #captionEl: HTMLElement | null = null;
  #statusEl: HTMLElement | null = null;
  #deviceWrap: HTMLElement | null = null;
  #deviceMenu: HTMLElement | null = null;

  #mics: { deviceId: string; label: string }[] = [];

  connectedCallback(): void {
    ensureComposerStyle(this.ownerDocument);
    this.#build();

    this.addEventListener('pointerdown', this.#onPointerDown);
  }

  disconnectedCallback(): void {
    this.removeEventListener('pointerdown', this.#onPointerDown);

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

  attributeChangedCallback(): void {}

  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    if (value) this.setAttribute('open', '');
    else this.removeAttribute('open');
  }

  get speech(): ComposerSpeech {
    this.#speech ??= createBuiltinComposerSpeech();
    return this.#speech;
  }

  set speech(value: ComposerSpeech | null) {
    this.#speech = value;
    this.#perm = 'unknown';
  }

  get device(): string | null {
    return this.#device;
  }

  set device(value: string | null) {
    this.#device = value;
    storeDevice(value);
  }

  get inner(): HTMLElement {
    this.#build();
    return this.#inner;
  }

  append(...nodes: (Node | string)[]): void {
    this.#build();
    this.#inner.append(...nodes);
  }

  #build(): void {
    if (this.#built) return;
    this.#built = true;

    const existing = this.querySelector(':scope > .slicc-composer__inner');
    if (existing instanceof HTMLElement) {
      this.#inner = existing;
      return;
    }

    const incoming = Array.from(this.childNodes);

    this.#inner = this.ownerDocument.createElement('div');
    this.#inner.className = 'slicc-composer__inner';
    this.#inner.setAttribute('part', 'inner');

    for (const node of incoming) this.#inner.appendChild(node);
    this.appendChild(this.#inner);
  }

  #onPointerDown = (e: PointerEvent): void => {
    if (!this.hasAttribute('ptt')) return;
    if (!e.isPrimary) return;
    if (this.#pressed || e.button !== 0) return;

    if (this.#stage === 'finalizing' || this.#stage === 'picking') return;
    const target = e.target as Element | null;
    const ta = target?.closest?.('textarea');
    if (!(ta instanceof HTMLTextAreaElement) || !this.contains(ta)) return;

    if (ta.value !== '') return;

    this.#pressed = true;
    this.#token++;
    this.#target = ta;
    this.#pointerId = e.pointerId;

    try {
      this.setPointerCapture(e.pointerId);
    } catch {}
    const doc = this.ownerDocument;
    doc.addEventListener('pointerup', this.#onDocPointerUp);
    this.addEventListener('pointercancel', this.#onPointerCancel);

    doc.addEventListener('selectionchange', this.#onEngageSelectionAbort);

    const engageToken = this.#token;
    this.#engageTimer = setTimeout(() => {
      this.#clearEngageTimer();
      void this.#beginPress(this.speech, engageToken);
    }, PTT_ENGAGE_MS);
  };

  toggleHandsFree(): boolean {
    if (this.#pressed) {
      if (this.#handsFree) this.#endPress(true);
      return false;
    }
    return this.#startHandsFree();
  }

  #startHandsFree(): boolean {
    if (!this.hasAttribute('ptt')) return false;

    if (this.#stage === 'finalizing' || this.#stage === 'picking') return false;
    const ta = this.querySelector('textarea');

    if (!(ta instanceof HTMLTextAreaElement) || ta.value !== '') return false;
    this.#pressed = true;
    this.#handsFree = true;
    this.#token++;
    this.#target = ta;
    void this.#beginPress(this.speech, this.#token);
    return true;
  }

  #onEngageSelectionAbort = (): void => {
    if (!this.#engageTimer) return;
    const sel = this.ownerDocument.getSelection();
    if (!sel || sel.isCollapsed || sel.toString() === '') return;
    this.#pressed = false;
    this.#token++;
    this.#target = null;
    this.#clearEngageTimer();
    this.#releasePointerCapture();
    this.#removePressListeners();
  };

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

    this.#showOverlay('enable');
    this.#enableTimer = setTimeout(() => {
      this.#enableTimer = null;
      this.#onHoldComplete(speech, token);
    }, HOLD_TO_ENABLE_MS);

    if (settled === 'pending') {
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
          this.#teardownOverlay();
        } else if (this.#pressed) {
          this.#showOverlay('denied');
        } else {
          this.#teardownOverlay();
        }
      })
      .catch((err: unknown) => {
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

  #startRecording(speech: ComposerSpeech, token: number): void {
    this.#stage = 'recording';
    this.#showOverlay('recording');

    speech.warmup();

    this.#statusUnsub?.();
    this.#statusUnsub = speech.onStatus((status) => {
      this.#status = status;
      this.#renderStatusLine();
    });

    const micsPromise = speech.microphones();
    micsPromise
      .then((mics) => {
        if (token !== this.#token) return;
        if (this.#device == null) this.#activeDevice = pickDefaultMicId(mics);
        if (shouldShowDevicePicker(mics)) this.#renderDevicePicker(mics);
      })
      .catch(() => {});

    const deviceChoice =
      this.#device != null
        ? Promise.resolve<string | null>(this.#device)
        : withTimeout(
            micsPromise,
            MIC_ENUMERATION_TIMEOUT_MS,
            new Error('microphone enumeration timed out')
          )
            .then((mics) => pickDefaultMicId(mics))
            .catch(() => null);

    const startPromise = deviceChoice.then((deviceId) =>
      speech.start({
        deviceId: deviceId ?? undefined,
        onPartial: (text) => {
          if (token === this.#token) this.#renderCaption(text);
        },
        onError: (message) => {
          if (token === this.#token) this.#renderCaption(message, true);
        },
      })
    );
    this.#startingSession = startPromise;
    startPromise
      .then((session) => {
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

  #cancelPendingStart(): void {
    const pending = this.#startingSession;
    this.#startingSession = null;
    if (pending !== null) {
      void pending.then(
        (session) => session.cancel(),
        () => {}
      );
    }
  }

  #onDocPointerUp = (e: PointerEvent): void => {
    if (!this.#pressed) return;

    if (this.#pointerId != null && e.pointerId !== this.#pointerId) return;

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

  #onPointerCancel = (e: PointerEvent): void => {
    if (this.#pointerId != null && e.pointerId !== this.#pointerId) return;
    this.#endPress(false);
  };

  #endPress(finalize: boolean): void {
    if (!this.#pressed) return;
    this.#pressed = false;
    this.#handsFree = false;

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

    const pending = this.#startingSession;
    this.#startingSession = null;
    if (!finalize) {
      session?.cancel();
      if (pending !== null)
        void pending.then(
          (s) => s.cancel(),
          () => {}
        );
      this.#target = null;
      this.#teardownOverlay();
      return;
    }
    if (!session && pending === null) {
      this.#target = null;
      this.#teardownOverlay();
      return;
    }

    this.#stage = 'finalizing';
    this.#renderCaption('Transcribing…');
    const token = this.#token;

    const resolved = session ? Promise.resolve(session) : (pending as Promise<SpeechSession>);

    withTimeout(
      resolved.then((s) => s.stop()),
      FINALIZE_TIMEOUT_MS,
      new Error('finalize timed out')
    )
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

  #commit(text: string): void {
    const ta = this.#target;
    this.#target = null;
    if (!ta) return;
    const transcript = text.trim();
    if (!transcript) {
      ta.focus();
      return;
    }
    ta.value = ta.value
      ? /\s$/.test(ta.value)
        ? ta.value + transcript
        : `${ta.value} ${transcript}`
      : transcript;

    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();

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
    this.ownerDocument.removeEventListener('selectionchange', this.#onEngageSelectionAbort);
  }

  #removePressListeners(): void {
    this.ownerDocument.removeEventListener('pointerup', this.#onDocPointerUp);
    this.removeEventListener('pointercancel', this.#onPointerCancel);
  }

  #releasePointerCapture(): void {
    const id = this.#pointerId;
    this.#pointerId = null;
    if (id == null) return;
    try {
      this.releasePointerCapture(id);
    } catch {}
  }

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

  #openDeviceMenu(): void {
    const wrap = this.#deviceWrap;
    if (!wrap || this.#deviceMenu) return;
    const menu = h('div', { class: 'slicc-composer__ptt-device-menu', role: 'menu' });
    let focusRow: HTMLElement | null = null;
    const highlighted = this.#device ?? this.#activeDevice;
    for (const mic of this.#mics) {
      const selected = mic.deviceId === highlighted;
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

  #showOverlay(stage: Exclude<PttStage, 'idle' | 'finalizing' | 'picking'>): void {
    this.#stage = stage;
    if (!this.#ptt) {
      this.#ptt = h('div', { class: 'slicc-composer__ptt', 'data-ptt': true, role: 'button' });
      this.appendChild(this.#ptt);
    }
    this.#applyStageClass(stage);

    switch (stage) {
      case 'enable': {
        const label = this.#handsFree ? 'Enabling push to talk' : 'Hold to enable push to talk';
        this.#renderOverlayContent(
          iconEl('mic', { size: 28 }),
          label,
          this.#loadRow('Requesting microphone access when the bar fills')
        );
        this.#ptt.setAttribute('aria-label', label);
        break;
      }
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
        const listening = this.#handsFree
          ? 'Listening — press again to send'
          : 'Listening — release to send';
        this.#labelEl = h('div', { class: 'slicc-composer__ptt-label' }, listening);
        this.#ptt.replaceChildren(mic, this.#labelEl, this.#captionEl, this.#statusEl);
        this.#ptt.setAttribute('aria-label', listening);
        this.#renderStatusLine();
        break;
      }
    }
  }

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
        el.textContent = 'Preparing enhanced speech…';
      }
      el.classList.remove('is-error');
      el.hidden = false;
    } else if (status?.state === 'ready' && status.engine === 'enhanced') {
      el.textContent = 'Enhanced speech recognition';
      el.classList.remove('is-error');
      el.hidden = false;
    } else if (status?.state === 'unavailable' && status.message) {
      el.textContent = status.message;
      el.classList.add('is-error');
      el.hidden = false;
    } else {
      el.classList.remove('is-error');
      el.hidden = true;
    }
  }

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

    toggle.addEventListener('pointerdown', (e) => e.stopPropagation());
    wrap.replaceChildren(toggle);
    wrap.hidden = false;
  }

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
    this.#activeDevice = null;
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
