import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Siblings from earlier waves — already registered; safe to import so the
// populated composer mirrors the prototype's footer (input card + meta row).
import '../../src/add-menu/slicc-add-menu.js';
import '../../src/composer/slicc-composer-meta.js';
import {
  FINALIZE_TIMEOUT_MS,
  HOLD_TO_ENABLE_MS,
  PERMISSION_REQUEST_TIMEOUT_MS,
  PTT_ENGAGE_MS,
  SliccComposer,
} from '../../src/composer/slicc-composer.js';
import '../../src/composer/slicc-input-card.js';
import type {
  ComposerSpeech,
  MicrophoneInfo,
  SpeechEngineStatus,
  SpeechSession,
  SpeechSessionOptions,
} from '../../src/composer/speech.js';
import '../../src/primitives/slicc-send-button.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';

/** The inner `.composer-inner` band the host renders into its light DOM. */
function innerOf(el: SliccComposer): HTMLElement {
  return el.querySelector('.slicc-composer__inner') as HTMLElement;
}

/**
 * Build a realistic, populated composer: an `.inputcard` carrying the add-menu
 * toolbar + send button, and a `.meta` row with model / thinking controls and a
 * keyboard `.hint` — matching the prototype footer markup.
 */
function makeComposer(): SliccComposer {
  const el = document.createElement('slicc-composer');
  // Push-to-talk is opt-in; these tests exercise it explicitly.
  el.setAttribute('ptt', '');
  // Give the band real width so the 680px-max + centering geometry resolves.
  el.style.cssText = 'width:1000px;display:block;';
  el.innerHTML = `
    <div class="inputcard">
      <textarea class="ta" rows="1" placeholder="Ask sliccy…"></textarea>
      <div class="toolbar">
        <slicc-add-menu></slicc-add-menu>
        <slicc-send-button></slicc-send-button>
      </div>
    </div>
    <div class="meta">
      <button class="ctl msel">Opus 4.8</button>
      <button class="ctl tsel">Sprofondato</button>
      <div class="mspacer"></div>
      <span class="hint slicc-composer__hint" data-composer-hint>⏎ send · ⇧⏎ newline</span>
    </div>`;
  return el;
}

/** A realistic PTT composer: a real `<slicc-input-card>` whose empty textarea is
 *  the push-to-talk hold trigger once the composer's `ptt` opt-in is on. */
function makePttComposer(): SliccComposer {
  const el = document.createElement('slicc-composer');
  el.setAttribute('ptt', '');
  el.style.cssText = 'width:1000px;display:block;';
  const card = document.createElement('slicc-input-card');
  card.setAttribute('placeholder', 'Ask sliccy…');
  el.appendChild(card);
  return el;
}

/** The push-to-talk hold trigger: the textarea (armed only from an empty
 *  composer). */
function pttTriggerOf(el: SliccComposer): HTMLTextAreaElement {
  return el.querySelector('textarea') as HTMLTextAreaElement;
}

/** Form a real, non-collapsed document text selection and notify listeners —
 *  models the user drag-selecting text. Returns a teardown that clears it. */
function formSelection(): () => void {
  const probe = document.createElement('p');
  probe.textContent = 'selected text';
  document.body.appendChild(probe);
  const range = document.createRange();
  range.selectNodeContents(probe);
  const sel = document.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  return () => {
    document.getSelection()?.removeAllRanges();
    probe.remove();
  };
}

describe('slicc-composer', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-composer')).toBe(SliccComposer);
  });

  it('renders into light DOM (no shadow root) with the inner band exposed as part="inner"', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    expect(el.shadowRoot).toBeNull();
    const inner = innerOf(el);
    expect(inner).not.toBeNull();
    expect(inner.getAttribute('part')).toBe('inner');
    // The `inner` getter returns that same band.
    expect(el.inner).toBe(inner);
  });

  it('relocates pre-existing slotted children (input card + meta row) into the inner band, in order', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const inner = innerOf(el);
    const card = inner.querySelector('.inputcard');
    const meta = inner.querySelector('.meta');
    expect(card).not.toBeNull();
    expect(meta).not.toBeNull();
    // DOM order preserved: input card precedes the meta row.
    expect(card!.compareDocumentPosition(meta!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The composed siblings live inside the band.
    expect(inner.querySelector('slicc-add-menu')).not.toBeNull();
    expect(inner.querySelector('slicc-send-button')).not.toBeNull();
  });

  it('appends nodes into the inner band via append()', () => {
    const el = document.createElement('slicc-composer') as SliccComposer;
    document.body.appendChild(el);
    const extra = document.createElement('div');
    extra.className = 'late';
    el.append(extra);
    expect(innerOf(el).querySelector('.late')).toBe(extra);
  });

  it('reflects the open attribute to the property and back', () => {
    const el = makeComposer();
    document.body.appendChild(el);

    expect(el.open).toBe(false);
    el.open = true;
    expect(el.hasAttribute('open')).toBe(true);
    expect(el.open).toBe(true);
    el.open = false;
    expect(el.hasAttribute('open')).toBe(false);

    el.setAttribute('open', '');
    expect(el.open).toBe(true);
  });

  it('survives detach + re-attach without rebuilding / duplicating the inner band', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const inner = innerOf(el);

    el.remove();
    document.body.appendChild(el);

    // Same band instance, exactly one band — children were not re-wrapped.
    expect(innerOf(el)).toBe(inner);
    expect(el.querySelectorAll('.slicc-composer__inner').length).toBe(1);
  });

  it('is a frosted footer band: top border, relative z-index 2, blurred backdrop', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const cs = getComputedStyle(el);

    // Top border from --line; the other edges stay borderless.
    expect(cs.borderTopStyle).toBe('solid');
    expect(cs.borderTopWidth).toBe('1px');
    expect(cs.borderBottomStyle).toBe('none');

    // z-index:2 over a positioned band so the add-menu results panel overlays
    // the thread (which sits at the default stacking level).
    expect(cs.position).toBe('relative');
    expect(cs.zIndex).toBe('2');

    // Frosted glass: blur + saturate backdrop filter.
    const backdrop =
      cs.backdropFilter || (cs as unknown as { webkitBackdropFilter: string }).webkitBackdropFilter;
    expect(backdrop).toContain('blur(18px)');
    expect(backdrop).toContain('saturate(1.4)');

    // Prototype band padding.
    expect(cs.paddingTop).toBe('14px');
    expect(cs.paddingLeft).toBe('16px');
  });

  it('tints the band background with --ctx over --bg (a resolved, non-transparent color-mix)', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const bg = getComputedStyle(el).backgroundColor;
    // color-mix resolves to a concrete color — not the keyword and not fully
    // transparent. Modern Chromium serializes it as color(srgb …), not rgb(…).
    expect(bg).not.toBe('transparent');
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(/(rgba?|color)\(/.test(bg)).toBe(true);
  });

  it('centers the inner band at max-width 680px so it slides with the chat column', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const inner = innerOf(el);
    const ics = getComputedStyle(inner);
    expect(ics.maxWidth).toBe('680px');
    // Inside the 1000px host the band is clamped to 680px and centered (auto margins).
    expect(inner.getBoundingClientRect().width).toBeCloseTo(680, 0);
    expect(ics.marginLeft).toBe(ics.marginRight);
  });

  it('default state: the meta keyboard hint is visible', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const hint = el.querySelector('.slicc-composer__hint') as HTMLElement;
    expect(getComputedStyle(hint).display).not.toBe('none');
  });

  it('open / narrow state: hides the meta keyboard hint (mirrors .shell.open .meta .hint)', () => {
    const el = makeComposer();
    el.setAttribute('open', '');
    document.body.appendChild(el);

    const hint = el.querySelector('.slicc-composer__hint') as HTMLElement;
    expect(getComputedStyle(hint).display).toBe('none');
    // Model + thinking controls stay visible in the narrow layout.
    const model = el.querySelector('.msel') as HTMLElement;
    expect(getComputedStyle(model).display).not.toBe('none');

    // Toggling back off restores the hint.
    el.open = false;
    expect(getComputedStyle(hint).display).not.toBe('none');
  });

  it('open state pierces the composed slicc-composer-meta shadow hint via ::part', () => {
    // The regression: the real meta row keeps its "⏎ send · ⇧⏎ newline"
    // hint in SHADOW DOM, where the light-DOM class hooks can't reach —
    // with the workbench open the hint overflowed the narrowed chat column
    // into the workbench pane.
    const el = document.createElement('slicc-composer') as SliccComposer;
    const meta = document.createElement('slicc-composer-meta');
    el.appendChild(meta);
    document.body.appendChild(el);

    const hint = meta.shadowRoot?.querySelector('.hint') as HTMLElement;
    expect(hint).toBeTruthy();
    expect(getComputedStyle(hint).display).not.toBe('none');

    el.setAttribute('open', '');
    expect(getComputedStyle(hint).display).toBe('none');

    el.removeAttribute('open');
    expect(getComputedStyle(hint).display).not.toBe('none');
  });

  it('also hides a hint matched by the data-composer-hint attribute when open', () => {
    const el = document.createElement('slicc-composer') as SliccComposer;
    el.setAttribute('open', '');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const hint = document.createElement('span');
    hint.setAttribute('data-composer-hint', '');
    hint.textContent = '⏎ send';
    meta.appendChild(hint);
    el.appendChild(meta);
    document.body.appendChild(el);

    expect(getComputedStyle(hint).display).toBe('none');
  });

  it('recomputes the frosted tint in dark mode (background differs from light)', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const light = getComputedStyle(el).backgroundColor;

    setTheme('dark');
    const dark = getComputedStyle(el).backgroundColor;
    // --bg flips dark, so the color-mix tint resolves to a different surface.
    expect(dark).not.toBe(light);
    expect(dark).not.toBe('rgba(0, 0, 0, 0)');
  });
});

// --- push-to-talk dictation gesture (two-stage, speech-controller-driven) ---

/** Call log + remote controls for a scripted ComposerSpeech test double. */
interface FakeSpeech {
  controller: ComposerSpeech;
  calls: {
    requestPermission: number;
    warmup: number;
    start: SpeechSessionOptions[];
    cancel: number;
    stop: number;
  };
  /** Push a streaming partial into the live session's caption callback. */
  emitPartial(text: string): void;
  /** Push an engine status update to subscribers. */
  emitStatus(status: SpeechEngineStatus): void;
}

function makeFakeSpeech(config: {
  permission?: PermissionState;
  grantOnRequest?: boolean;
  mics?: MicrophoneInfo[];
  transcript?: string;
  status?: SpeechEngineStatus;
}): FakeSpeech {
  let permission: PermissionState = config.permission ?? 'granted';
  let partial: ((text: string) => void) | null = null;
  const statusSubs = new Set<(s: SpeechEngineStatus) => void>();
  let status: SpeechEngineStatus = config.status ?? { engine: 'builtin', state: 'idle' };
  const calls: FakeSpeech['calls'] = {
    requestPermission: 0,
    warmup: 0,
    start: [],
    cancel: 0,
    stop: 0,
  };

  const controller: ComposerSpeech = {
    permission: async () => permission,
    requestPermission: async () => {
      calls.requestPermission++;
      const granted = config.grantOnRequest ?? true;
      permission = granted ? 'granted' : 'denied';
      return granted;
    },
    microphones: async () => config.mics ?? [{ deviceId: 'default', label: 'Built-in Microphone' }],
    start: async (opts) => {
      calls.start.push(opts);
      partial = opts.onPartial ?? null;
      return {
        stop: async () => {
          calls.stop++;
          return config.transcript ?? '';
        },
        cancel: () => {
          calls.cancel++;
        },
      };
    },
    status: () => status,
    onStatus: (cb) => {
      statusSubs.add(cb);
      cb(status);
      return () => statusSubs.delete(cb);
    },
    warmup: () => {
      calls.warmup++;
    },
  };

  return {
    controller,
    calls,
    emitPartial: (text) => partial?.(text),
    emitStatus: (next) => {
      status = next;
      for (const cb of statusSubs) cb(next);
    },
  };
}

describe('slicc-composer / push-to-talk', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
    localStorage.removeItem('slicc-composer:mic-device');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Engage the deferred press lifecycle + drain async stage transitions:
   *  press waits PTT_ENGAGE_MS before #beginPress runs, so advancing exactly
   *  the engage window after press(el) is what every "and then overlay X
   *  appears" assertion needs. Tests that intentionally release inside the
   *  engage window advance less and don't call flush() at all. */
  const flush = () => vi.advanceTimersByTimeAsync(PTT_ENGAGE_MS);

  /** The textarea the host renders / relocates into its light DOM. */
  function taOf(el: SliccComposer): HTMLTextAreaElement {
    return el.querySelector('textarea') as HTMLTextAreaElement;
  }

  /** Press-and-hold the (empty) textarea (primary pointer), arming the gesture.
   *  Defaults to mouse semantics; pass `'touch'` / `'pen'` to drive the
   *  same path from the corresponding modality. */
  function press(
    el: SliccComposer,
    pointerType: 'mouse' | 'touch' | 'pen' = 'mouse'
  ): HTMLTextAreaElement {
    pttTriggerOf(el).dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerType,
        pointerId: pointerType === 'mouse' ? 1 : 100,
      })
    );
    return taOf(el);
  }

  function release(pointerType: 'mouse' | 'touch' | 'pen' = 'mouse'): void {
    document.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        isPrimary: true,
        pointerType,
        pointerId: pointerType === 'mouse' ? 1 : 100,
      })
    );
  }

  /** System-cancel the active pointer (touch interrupted by scroll/system).
   *  Defaults to the same `'mouse'` pointer as `press` so cancel-after-mouse-press
   *  tests don't have to thread the type. */
  function pointerCancel(
    el: SliccComposer,
    pointerType: 'mouse' | 'touch' | 'pen' = 'mouse'
  ): void {
    el.dispatchEvent(
      new PointerEvent('pointercancel', {
        bubbles: true,
        pointerType,
        pointerId: pointerType === 'mouse' ? 1 : 100,
      })
    );
  }

  /** The active push-to-talk overlay, if any. */
  function pttOf(el: SliccComposer): HTMLElement | null {
    return el.querySelector('.slicc-composer__ptt');
  }

  function mount(fake: FakeSpeech): SliccComposer {
    const el = makePttComposer();
    el.speech = fake.controller;
    document.body.appendChild(el);
    return el;
  }

  // ── The trigger lives on the textarea, armed only from an empty composer ──

  it('renders no mic button in the toolbar (the gesture lives on the textarea)', () => {
    const el = mount(makeFakeSpeech({}));
    expect(el.querySelector('[data-ptt-trigger]')).toBeNull();
    expect(el.querySelector('slicc-input-card slicc-icon-button')).toBeNull();
  });

  it('pressing and holding the empty textarea arms push-to-talk', async () => {
    const el = mount(makeFakeSpeech({ permission: 'granted' }));
    press(el);
    await flush();
    expect(pttOf(el)).not.toBeNull();
  });

  it('pressing the textarea with existing text never arms (editing / selection stays free)', async () => {
    const el = mount(makeFakeSpeech({ permission: 'granted' }));
    taOf(el).value = 'already typed';
    press(el);
    await flush();
    expect(pttOf(el)).toBeNull();
  });

  it('a text selection forming during the engage window aborts the gesture (drag-select wins)', async () => {
    const el = mount(makeFakeSpeech({ permission: 'granted' }));
    press(el);
    // Mid-wait the user drag-selects text — a selection forms before the gesture
    // arms, so it bails and never flashes the overlay.
    const clear = formSelection();
    await flush();
    expect(pttOf(el)).toBeNull();
    clear();
  });

  // ── Stage 1: no permission yet ────────────────────────────────────

  it('without permission, holding shows the 3s "hold to enable" bar (no recording)', async () => {
    const fake = makeFakeSpeech({ permission: 'prompt' });
    const el = mount(fake);
    press(el);
    await flush();

    const ptt = pttOf(el);
    expect(ptt).not.toBeNull();
    expect(ptt!.classList.contains('is-enable')).toBe(true);
    expect(ptt!.querySelector('.slicc-composer__ptt-label')?.textContent).toBe(
      'Hold to enable push to talk'
    );
    expect(ptt!.querySelector('.slicc-composer__ptt-bar-fill')).not.toBeNull();
    // The 3s sweep is wired via the .is-enable stage class.
    const fill = ptt!.querySelector('.slicc-composer__ptt-bar-fill') as HTMLElement;
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      expect(getComputedStyle(fill).animationDuration).toBe('3s');
    }
    expect(fake.calls.requestPermission).toBe(0);
    expect(fake.calls.start.length).toBe(0);
  });

  it('holding through the 3s gate requests permission, then records while still held', async () => {
    const fake = makeFakeSpeech({ permission: 'prompt', grantOnRequest: true, transcript: 'hi' });
    const el = mount(fake);
    press(el);
    await flush();

    await vi.advanceTimersByTimeAsync(HOLD_TO_ENABLE_MS);
    expect(fake.calls.requestPermission).toBe(1);
    await flush();

    // Still pressed after the grant — the press upgrades to recording in place.
    const ptt = pttOf(el);
    expect(ptt?.classList.contains('is-recording')).toBe(true);
    expect(fake.calls.start.length).toBe(1);
    // The first granted hold kicks the enhanced-model warmup.
    expect(fake.calls.warmup).toBeGreaterThan(0);
  });

  it('releasing before the 3s gate never requests permission', async () => {
    const fake = makeFakeSpeech({ permission: 'prompt' });
    const el = mount(fake);
    press(el);
    await flush();

    await vi.advanceTimersByTimeAsync(1000);
    release();
    expect(pttOf(el)).toBeNull();

    // The cleared timer must not fire later.
    await vi.advanceTimersByTimeAsync(HOLD_TO_ENABLE_MS);
    expect(fake.calls.requestPermission).toBe(0);
  });

  it('a click released inside the engage window shows no overlay and never queries the speech controller', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    // permission() is the first thing #beginPress touches — spy on it to
    // catch a stray engage-timer fire even if no overlay is mounted.
    const permissionSpy = vi.spyOn(fake.controller, 'permission');
    const el = mount(fake);
    press(el);

    // Release strictly inside the engage window: the deferred lifecycle
    // is cancelled before it ever arms.
    await vi.advanceTimersByTimeAsync(PTT_ENGAGE_MS - 1);
    expect(pttOf(el)).toBeNull();
    release();
    expect(pttOf(el)).toBeNull();

    // Past the engage window: the cancelled timer must not fire.
    await vi.advanceTimersByTimeAsync(HOLD_TO_ENABLE_MS);
    expect(pttOf(el)).toBeNull();
    expect(permissionSpy).not.toHaveBeenCalled();
    expect(fake.calls.requestPermission).toBe(0);
    expect(fake.calls.start.length).toBe(0);
  });

  it('a blocked permission shows instructions instead of the enable bar', async () => {
    const fake = makeFakeSpeech({ permission: 'denied' });
    const el = mount(fake);
    press(el);
    await flush();

    const ptt = pttOf(el);
    expect(ptt?.classList.contains('is-denied')).toBe(true);
    expect(ptt?.querySelector('.slicc-composer__ptt-label')?.textContent).toBe(
      'Microphone access is blocked'
    );
    expect(ptt?.querySelector('.slicc-composer__ptt-bar-fill')).toBeNull();

    release();
    expect(pttOf(el)).toBeNull();
  });

  // ── Stage 2: permission granted ───────────────────────────────────

  it('with permission granted, holding records and releasing appends + submits as dictation', async () => {
    const fake = makeFakeSpeech({ permission: 'granted', transcript: 'make the hero warmer' });
    const el = mount(fake);
    const submits: Array<{ value: string; source?: string }> = [];
    el.addEventListener('submit', (e) => {
      submits.push((e as Event as CustomEvent<{ value: string; source?: string }>).detail);
    });

    const ta = press(el);
    await flush();

    const ptt = pttOf(el);
    expect(ptt?.classList.contains('is-recording')).toBe(true);
    expect(fake.calls.start.length).toBe(1);

    release();
    await flush();

    expect(pttOf(el)).toBeNull();
    expect(ta.value).toBe('make the hero warmer');
    // detail.source marks the turn voice-initiated — hosts speak the reply.
    expect(submits).toEqual([{ value: 'make the hero warmer', source: 'dictation' }]);
  });

  it('appends the transcript to input filled during the hold with a single joining space', async () => {
    // The gesture arms only from an empty composer; text added during the hold
    // (here set right after the press) is still appended to on release.
    const fake = makeFakeSpeech({ permission: 'granted', transcript: 'and add a CTA' });
    const el = mount(fake);
    const ta = press(el);
    ta.value = 'Warm up the hero';

    await flush();
    release();
    await flush();

    expect(ta.value).toBe('Warm up the hero and add a CTA');
  });

  it('an empty transcript stays a plain caret press: no append, no submit', async () => {
    const fake = makeFakeSpeech({ permission: 'granted', transcript: '' });
    const el = mount(fake);
    const submits: Event[] = [];
    el.addEventListener('submit', (e) => submits.push(e));

    const ta = press(el);
    await flush();
    release();
    await flush();

    expect(pttOf(el)).toBeNull();
    expect(ta.value).toBe('');
    expect(submits.length).toBe(0);
  });

  it('streams partials into the closed-caption line (trailing words only)', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    const el = mount(fake);
    press(el);
    await flush();

    fake.emitPartial('make the landing');
    const caption = pttOf(el)!.querySelector('.slicc-composer__ptt-caption') as HTMLElement;
    expect(caption.hidden).toBe(false);
    expect(caption.textContent).toBe('make the landing');

    // Long partials keep only the trailing words, like movie captions.
    fake.emitPartial('one two three four five six seven eight nine ten');
    expect(caption.textContent).toBe('three four five six seven eight nine ten');
  });

  it('pointercancel mid-recording cancels: no transcript, session cancelled', async () => {
    const fake = makeFakeSpeech({ permission: 'granted', transcript: 'never inserted' });
    const el = mount(fake);
    const ta = press(el);
    await flush();
    expect(pttOf(el)).not.toBeNull();

    pointerCancel(el, 'mouse');
    expect(pttOf(el)).toBeNull();
    expect(ta.value).toBe('');
    expect(fake.calls.cancel).toBe(1);
    expect(fake.calls.stop).toBe(0);

    // A subsequent release no longer reaches us (listeners removed).
    release();
    await flush();
    expect(ta.value).toBe('');
  });

  // ── Microphone picker ─────────────────────────────────────────────

  it('renders the mic picker (a subtle triangle, no label) only with >1 input device', async () => {
    const two = makeFakeSpeech({
      permission: 'granted',
      mics: [
        { deviceId: 'a', label: 'Built-in Microphone' },
        { deviceId: 'b', label: 'Studio USB' },
      ],
    });
    const el = mount(two);
    press(el);
    await flush();

    const wrap = pttOf(el)!.querySelector('.slicc-composer__ptt-device') as HTMLElement;
    expect(wrap.hidden).toBe(false);
    // Just the chevron-down glyph button — device labels stay out of the
    // recording overlay until the menu opens.
    expect(wrap.querySelector('.slicc-composer__ptt-device-btn svg')).not.toBeNull();
    expect(wrap.textContent).not.toContain('Studio USB');
    expect(wrap.querySelector('.slicc-composer__ptt-device-menu')).toBeNull();
    pointerCancel(el);

    const one = makeFakeSpeech({ permission: 'granted' });
    const el2 = mount(one);
    press(el2);
    await flush();
    const wrap2 = pttOf(el2)!.querySelector('.slicc-composer__ptt-device') as HTMLElement;
    expect(wrap2.hidden).toBe(true);
  });

  it('releasing over the picker opens the device menu instead of submitting; choosing persists', async () => {
    const fake = makeFakeSpeech({
      permission: 'granted',
      transcript: 'should not submit',
      mics: [
        { deviceId: 'a', label: 'Built-in Microphone' },
        { deviceId: 'b', label: 'Studio USB' },
      ],
    });
    const el = mount(fake);
    const submits: Event[] = [];
    el.addEventListener('submit', (e) => submits.push(e));
    const ta = press(el);
    await flush();

    const toggle = pttOf(el)!.querySelector('.slicc-composer__ptt-device-btn') as HTMLElement;
    // Release OVER the picker: the gesture flips into its interactive
    // device-choice state — no transcript, no submit, menu open.
    toggle.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        isPrimary: true,
        pointerType: 'mouse',
        pointerId: 1,
      })
    );
    expect(pttOf(el)).not.toBeNull();
    expect(pttOf(el)!.classList.contains('is-picking')).toBe(true);
    expect(fake.calls.cancel).toBe(1);
    expect(submits.length).toBe(0);
    expect(ta.value).toBe('');

    const rows = pttOf(el)!.querySelectorAll('.slicc-composer__ptt-device-item');
    expect(rows.length).toBe(2);
    expect(rows[1].textContent).toContain('Studio USB');

    // Choosing a device persists it and closes the overlay.
    (rows[1] as HTMLElement).click();
    expect(pttOf(el)).toBeNull();
    expect(el.device).toBe('b');
    expect(localStorage.getItem('slicc-composer:mic-device')).toBe('b');

    // The next session starts on the chosen device, now shown as checked.
    press(el);
    await flush();
    expect(fake.calls.start.at(-1)?.deviceId).toBe('b');
    pttOf(el)!
      .querySelector('.slicc-composer__ptt-device-btn')!
      .dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          isPrimary: true,
          pointerType: 'mouse',
          pointerId: 1,
        })
      );
    const checked = pttOf(el)!.querySelector(
      '.slicc-composer__ptt-device-item[aria-checked="true"]'
    );
    expect(checked?.getAttribute('data-device-id')).toBe('b');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });

  it('release over the picker still opens the menu when pointer capture retargets pointerup to the host (no submit)', async () => {
    // Under real pointer capture the release `pointerup` is retargeted to
    // the capture host (slicc-composer), so `composedPath` no longer contains
    // the picker. The geometry hit-test (elementFromPoint) must keep the
    // release-over-the-picker path working.
    const fake = makeFakeSpeech({
      permission: 'granted',
      transcript: 'should not submit',
      mics: [
        { deviceId: 'a', label: 'Built-in Microphone' },
        { deviceId: 'b', label: 'Studio USB' },
      ],
    });
    const el = mount(fake);
    const submits: Event[] = [];
    el.addEventListener('submit', (e) => submits.push(e));
    // Touch path — pointer capture is what creates the retarget in the wild.
    const ta = press(el, 'touch');
    await flush();

    const wrap = pttOf(el)!.querySelector('.slicc-composer__ptt-device') as HTMLElement;
    expect(wrap.hidden).toBe(false);
    const rect = wrap.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    // Verify the geometry actually lands on (or inside) the picker so the
    // fallback hit-test has something to find.
    const hit = document.elementFromPoint(clientX, clientY);
    expect(hit != null && wrap.contains(hit)).toBe(true);

    // Dispatch the release ON THE HOST (capture-retarget) with coordinates
    // over the picker. The composedPath will not include #deviceWrap.
    el.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        isPrimary: true,
        pointerType: 'touch',
        pointerId: 100,
        clientX,
        clientY,
      })
    );

    expect(pttOf(el)).not.toBeNull();
    expect(pttOf(el)!.classList.contains('is-picking')).toBe(true);
    expect(fake.calls.cancel).toBe(1);
    expect(submits.length).toBe(0);
    expect(ta.value).toBe('');
  });

  // ── Engine status line ────────────────────────────────────────────

  it('shows the enhanced-model download status with its ETA while recording', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    const el = mount(fake);
    press(el);
    await flush();

    const status = pttOf(el)!.querySelector('.slicc-composer__ptt-status') as HTMLElement;
    expect(status.hidden).toBe(true);

    fake.emitStatus({
      engine: 'builtin',
      state: 'downloading',
      download: { loaded: 50_000_000, total: 150_000_000, etaSeconds: 45 },
    });
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Better speech recognition downloading · ready in ~45s');

    fake.emitStatus({ engine: 'enhanced', state: 'ready' });
    expect(status.textContent).toBe('Enhanced speech recognition');
  });

  it('shows the preparing line while staging (downloading without a byte snapshot)', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    const el = mount(fake);
    press(el);
    await flush();

    const status = pttOf(el)!.querySelector('.slicc-composer__ptt-status') as HTMLElement;
    fake.emitStatus({ engine: 'builtin', state: 'downloading' });
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Preparing enhanced speech…');
    expect(status.classList.contains('is-error')).toBe(false);
    pointerCancel(el);
  });

  it('renders an actionable message (not a hidden line) when the engine is unavailable', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    const el = mount(fake);
    press(el);
    await flush();

    const status = pttOf(el)!.querySelector('.slicc-composer__ptt-status') as HTMLElement;
    fake.emitStatus({
      engine: 'builtin',
      state: 'unavailable',
      message: 'Enhanced speech unavailable: offline',
    });
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Enhanced speech unavailable: offline');
    expect(status.classList.contains('is-error')).toBe(true);

    // A bare `unavailable` with no message still hides the line.
    fake.emitStatus({ engine: 'builtin', state: 'unavailable' });
    expect(status.hidden).toBe(true);
    pointerCancel(el);
  });
});

describe('slicc-composer / push-to-talk edge paths', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
    localStorage.removeItem('slicc-composer:mic-device');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = () => vi.advanceTimersByTimeAsync(PTT_ENGAGE_MS);

  function press(
    el: SliccComposer,
    pointerType: 'mouse' | 'touch' | 'pen' = 'mouse'
  ): HTMLTextAreaElement {
    pttTriggerOf(el).dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerType,
        pointerId: pointerType === 'mouse' ? 1 : 100,
      })
    );
    return el.querySelector('textarea') as HTMLTextAreaElement;
  }

  function release(pointerType: 'mouse' | 'touch' | 'pen' = 'mouse'): void {
    document.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        isPrimary: true,
        pointerType,
        pointerId: pointerType === 'mouse' ? 1 : 100,
      })
    );
  }

  function pointerCancel(
    el: SliccComposer,
    pointerType: 'mouse' | 'touch' | 'pen' = 'mouse'
  ): void {
    el.dispatchEvent(
      new PointerEvent('pointercancel', {
        bubbles: true,
        pointerType,
        pointerId: pointerType === 'mouse' ? 1 : 100,
      })
    );
  }

  function pttOf(el: SliccComposer): HTMLElement | null {
    return el.querySelector('.slicc-composer__ptt');
  }

  function mount(fake: FakeSpeech): SliccComposer {
    const el = makePttComposer();
    el.speech = fake.controller;
    document.body.appendChild(el);
    return el;
  }

  it('a slow permission query runs the enable stage, then upgrades in place on granted', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    let resolvePermission!: (state: PermissionState) => void;
    const deferred = new Promise<PermissionState>((res) => {
      resolvePermission = res;
    });
    fake.controller.permission = () => deferred;
    const el = mount(fake);
    press(el);

    // Engage delay + the 60ms race window elapse with the query still
    // pending → enable stage.
    await vi.advanceTimersByTimeAsync(PTT_ENGAGE_MS + 100);
    expect(pttOf(el)?.classList.contains('is-enable')).toBe(true);

    // The query lands 'granted' mid-hold: the press upgrades straight to
    // recording without waiting out the 3s gate.
    resolvePermission('granted');
    await flush();
    expect(pttOf(el)?.classList.contains('is-recording')).toBe(true);
    expect(fake.calls.requestPermission).toBe(0);
    pointerCancel(el);
  });

  it('a slow permission query that lands denied swaps in the blocked instructions', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    let resolvePermission!: (state: PermissionState) => void;
    fake.controller.permission = () =>
      new Promise<PermissionState>((res) => {
        resolvePermission = res;
      });
    const el = mount(fake);
    press(el);
    await vi.advanceTimersByTimeAsync(PTT_ENGAGE_MS + 100);

    resolvePermission('denied');
    await flush();
    expect(pttOf(el)?.classList.contains('is-denied')).toBe(true);
    release();
    expect(pttOf(el)).toBeNull();
  });

  it('releasing while the permission prompt is up keeps the overlay; a grant arms silently', async () => {
    const fake = makeFakeSpeech({ permission: 'prompt' });
    let resolveRequest!: (granted: boolean) => void;
    fake.controller.requestPermission = () =>
      new Promise<boolean>((res) => {
        resolveRequest = res;
      });
    const el = mount(fake);
    press(el);
    await flush();
    await vi.advanceTimersByTimeAsync(HOLD_TO_ENABLE_MS);
    expect(pttOf(el)?.classList.contains('is-prompting')).toBe(true);

    // The native prompt steals the pointer — the release must NOT kill the
    // in-flight permission request.
    release();
    expect(pttOf(el)).not.toBeNull();

    resolveRequest(true);
    await flush();
    // Granted after release: armed for the next hold, no recording started.
    expect(pttOf(el)).toBeNull();
    expect(fake.calls.start.length).toBe(0);
  });

  it('a denied prompt while still holding shows the blocked instructions', async () => {
    const fake = makeFakeSpeech({ permission: 'prompt', grantOnRequest: false });
    const el = mount(fake);
    press(el);
    await flush();
    await vi.advanceTimersByTimeAsync(HOLD_TO_ENABLE_MS);
    await flush();

    expect(pttOf(el)?.classList.contains('is-denied')).toBe(true);
    expect(fake.calls.start.length).toBe(0);
    release();
    expect(pttOf(el)).toBeNull();
  });

  it('bounds a stalled permission request with a timeout and recovers to a surfaced error', async () => {
    // EXT2: the site grant succeeds but getUserMedia({audio:true}) never settles.
    const fake = makeFakeSpeech({ permission: 'prompt' });
    fake.controller.requestPermission = () => new Promise<boolean>(() => {});
    const el = mount(fake);
    press(el);
    await flush();
    await vi.advanceTimersByTimeAsync(HOLD_TO_ENABLE_MS);
    // The overlay sits at prompting while the request hangs.
    expect(pttOf(el)?.classList.contains('is-prompting')).toBe(true);

    // Just before the bound elapses it is still prompting (no premature flip).
    await vi.advanceTimersByTimeAsync(PERMISSION_REQUEST_TIMEOUT_MS - 1);
    expect(pttOf(el)?.classList.contains('is-prompting')).toBe(true);

    // The bound fires → the overlay recovers to a surfaced error, never frozen.
    await vi.advanceTimersByTimeAsync(1);
    const ptt = pttOf(el);
    expect(ptt).not.toBeNull();
    expect(ptt!.classList.contains('is-prompting')).toBe(false);
    expect(ptt!.classList.contains('is-denied')).toBe(true);
    expect(ptt!.querySelector('.slicc-composer__ptt-label')?.textContent).toBe(
      'Microphone unavailable'
    );
    expect(ptt!.textContent).toContain("Microphone didn't respond");
    expect(fake.calls.start.length).toBe(0);

    // Releasing from the recovered state clears the overlay cleanly.
    release();
    expect(pttOf(el)).toBeNull();
  });

  it('a rejected permission request surfaces an error and tears down (no silent no-op)', async () => {
    const fake = makeFakeSpeech({ permission: 'prompt' });
    fake.controller.requestPermission = async () => {
      throw new Error('getUserMedia exploded');
    };
    const el = mount(fake);
    press(el);
    await flush();
    await vi.advanceTimersByTimeAsync(HOLD_TO_ENABLE_MS);
    await flush();

    const ptt = pttOf(el);
    expect(ptt?.classList.contains('is-denied')).toBe(true);
    // The rejection message is surfaced, not swallowed.
    expect(ptt?.textContent).toContain('getUserMedia exploded');
    expect(fake.calls.start.length).toBe(0);

    release();
    expect(pttOf(el)).toBeNull();
  });

  it('releasing during prompting while the request stalls still recovers via the bounded timeout', async () => {
    const fake = makeFakeSpeech({ permission: 'prompt' });
    fake.controller.requestPermission = () => new Promise<boolean>(() => {});
    const el = mount(fake);
    press(el);
    await flush();
    await vi.advanceTimersByTimeAsync(HOLD_TO_ENABLE_MS);
    expect(pttOf(el)?.classList.contains('is-prompting')).toBe(true);

    // The native prompt steals the pointer: a release here intentionally keeps
    // the overlay (the continuation owns teardown).
    release();
    expect(pttOf(el)).not.toBeNull();

    // But the bound guarantees the released gesture is never left orphaned: a
    // stalled request times out and tears the overlay down with no recording.
    await vi.advanceTimersByTimeAsync(PERMISSION_REQUEST_TIMEOUT_MS);
    expect(pttOf(el)).toBeNull();
    expect(fake.calls.start.length).toBe(0);
  });

  it('Escape and outside clicks exit the device-picking state', async () => {
    const mics = [
      { deviceId: 'a', label: 'Built-in' },
      { deviceId: 'b', label: 'USB' },
    ];
    const fake = makeFakeSpeech({ permission: 'granted', mics });
    const el = mount(fake);
    press(el);
    await flush();
    const toggle = () => pttOf(el)!.querySelector('.slicc-composer__ptt-device-btn') as HTMLElement;
    toggle().dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        isPrimary: true,
        pointerType: 'mouse',
        pointerId: 1,
      })
    );
    expect(pttOf(el)!.classList.contains('is-picking')).toBe(true);
    expect(pttOf(el)!.querySelector('.slicc-composer__ptt-device-menu')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(pttOf(el)).toBeNull();

    // Again, exiting via a click outside the picker this time.
    press(el);
    await flush();
    toggle().dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        isPrimary: true,
        pointerType: 'mouse',
        pointerId: 1,
      })
    );
    expect(pttOf(el)!.classList.contains('is-picking')).toBe(true);
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        isPrimary: true,
        pointerType: 'mouse',
        pointerId: 1,
      })
    );
    expect(pttOf(el)).toBeNull();
  });

  it('flips the device menu upward and caps its height when the composer sits at the viewport bottom', async () => {
    const mics = Array.from({ length: 8 }, (_, i) => ({
      deviceId: `m${i}`,
      label: `Microphone ${i + 1}`,
    }));
    const fake = makeFakeSpeech({ permission: 'granted', mics });
    const el = mount(fake);
    // Pin the composer to the very bottom of the viewport: no room below.
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;display:block;';
    press(el);
    await flush();

    const toggle = pttOf(el)!.querySelector('.slicc-composer__ptt-device-btn') as HTMLElement;
    toggle.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        isPrimary: true,
        pointerType: 'mouse',
        pointerId: 1,
      })
    );
    const menu = pttOf(el)!.querySelector('.slicc-composer__ptt-device-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    // No room below → the menu anchors upward instead of off the bottom edge.
    expect(menu.classList.contains('slicc-composer__ptt-device-menu--up')).toBe(true);
    // A bounded max-height is applied so an extreme device count scrolls.
    const cap = Number.parseFloat(menu.style.maxHeight);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(320);
    // And the rendered menu stays fully on-screen (top edge not clipped).
    expect(menu.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });

  it('keeps the device menu opening downward (no flip) when there is ample room below', async () => {
    const mics = [
      { deviceId: 'a', label: 'Built-in' },
      { deviceId: 'b', label: 'USB' },
    ];
    const fake = makeFakeSpeech({ permission: 'granted', mics });
    const el = mount(fake);
    // Pin to the top of the viewport: plenty of room beneath the picker.
    el.style.cssText = 'position:fixed;left:0;right:0;top:0;display:block;';
    press(el);
    await flush();

    const toggle = pttOf(el)!.querySelector('.slicc-composer__ptt-device-btn') as HTMLElement;
    toggle.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        isPrimary: true,
        pointerType: 'mouse',
        pointerId: 1,
      })
    );
    const menu = pttOf(el)!.querySelector('.slicc-composer__ptt-device-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.classList.contains('slicc-composer__ptt-device-menu--up')).toBe(false);
    // Still centered horizontally (existing styling intact).
    expect(getComputedStyle(menu).transform).not.toBe('none');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });

  it('detaching mid-recording cancels the session and strands nothing', async () => {
    const fake = makeFakeSpeech({ permission: 'granted', transcript: 'lost' });
    const el = mount(fake);
    const ta = press(el);
    await flush();
    expect(pttOf(el)).not.toBeNull();

    el.remove();
    expect(el.querySelector('.slicc-composer__ptt')).toBeNull();
    expect(fake.calls.cancel).toBe(1);

    // A release after the detach must not insert anything.
    release();
    await flush();
    expect(ta.value).toBe('');
  });

  it('a release while start() is still in flight stops + transcribes the late session (no quick-click drop)', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    let resolveStart!: (s: SpeechSession) => void;
    let stopCount = 0;
    let cancelCount = 0;
    const lateSession: SpeechSession = {
      stop: async () => {
        stopCount++;
        return 'late words';
      },
      cancel: () => {
        cancelCount++;
      },
    };
    // The enhanced engine resolves start() asynchronously — hold it open so we
    // can release the press BEFORE the session comes up.
    fake.controller.start = (opts) => {
      fake.calls.start.push(opts);
      return new Promise<SpeechSession>((res) => {
        resolveStart = res;
      });
    };
    const el = mount(fake);
    const ta = press(el);
    await flush();
    // start() is in flight: the recording overlay is up but no session yet.
    expect(fake.calls.start.length).toBe(1);
    expect(pttOf(el)?.classList.contains('is-recording')).toBe(true);

    // Release BEFORE start() resolves: the old code dropped this as a
    // quick-click and the late .then cancelled the session. Now it's awaited.
    release();
    resolveStart(lateSession);
    await flush();

    expect(stopCount).toBe(1);
    expect(cancelCount).toBe(0);
    expect(ta.value).toBe('late words');
    expect(pttOf(el)).toBeNull();
  });

  it('a pointercancel while start() is in flight cancels the late session (no transcript)', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    let resolveStart!: (s: SpeechSession) => void;
    let stopCount = 0;
    let cancelCount = 0;
    const lateSession: SpeechSession = {
      stop: async () => {
        stopCount++;
        return 'unheard';
      },
      cancel: () => {
        cancelCount++;
      },
    };
    fake.controller.start = (opts) => {
      fake.calls.start.push(opts);
      return new Promise<SpeechSession>((res) => {
        resolveStart = res;
      });
    };
    const el = mount(fake);
    const ta = press(el);
    await flush();
    expect(fake.calls.start.length).toBe(1);

    pointerCancel(el, 'mouse');
    resolveStart(lateSession);
    await flush();

    expect(cancelCount).toBe(1);
    expect(stopCount).toBe(0);
    expect(ta.value).toBe('');
    expect(pttOf(el)).toBeNull();
  });

  it('formats minute-scale ETAs and the no-ETA download line', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    const el = mount(fake);
    press(el);
    await flush();
    const status = pttOf(el)!.querySelector('.slicc-composer__ptt-status') as HTMLElement;

    fake.emitStatus({
      engine: 'builtin',
      state: 'downloading',
      download: { loaded: 0, total: 150, etaSeconds: 130 },
    });
    expect(status.textContent).toBe('Better speech recognition downloading · ready in ~2m 10s');

    fake.emitStatus({
      engine: 'builtin',
      state: 'downloading',
      download: { loaded: 0, total: 0, etaSeconds: null },
    });
    expect(status.textContent).toBe('Better speech recognition downloading…');
    pointerCancel(el);
  });

  it('hides the caption again when a partial collapses to nothing', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    const el = mount(fake);
    press(el);
    await flush();
    const caption = pttOf(el)!.querySelector('.slicc-composer__ptt-caption') as HTMLElement;

    fake.emitPartial('hello');
    expect(caption.hidden).toBe(false);
    fake.emitPartial('   ');
    expect(caption.hidden).toBe(true);
    pointerCancel(el);
  });

  it('does not double-space when the existing input already ends with whitespace', async () => {
    const fake = makeFakeSpeech({ permission: 'granted', transcript: 'world' });
    const el = mount(fake);
    const ta = press(el);
    ta.value = 'hello ';
    await flush();
    release();
    await flush();
    expect(ta.value).toBe('hello world');
  });

  it('submits through a slotted slicc-input-card via its public submit()', async () => {
    const el = document.createElement('slicc-composer') as SliccComposer;
    el.setAttribute('ptt', '');
    el.style.cssText = 'width:1000px;display:block;';
    const card = document.createElement('slicc-input-card');
    el.append(card);
    const fake = makeFakeSpeech({ permission: 'granted', transcript: 'via the card' });
    el.speech = fake.controller;
    document.body.appendChild(el);

    const submits: string[] = [];
    el.addEventListener('submit', (e) => {
      submits.push((e as Event as CustomEvent<{ value: string }>).detail.value);
    });

    press(el);
    await flush();
    release();
    await flush();
    expect(submits).toEqual(['via the card']);
    expect((card as HTMLElement & { value: string }).value).toBe('via the card');
  });

  it('the input-card submit path also marks the turn as dictation', async () => {
    const el = document.createElement('slicc-composer') as SliccComposer;
    el.setAttribute('ptt', '');
    el.style.cssText = 'width:1000px;display:block;';
    el.append(document.createElement('slicc-input-card'));
    el.speech = makeFakeSpeech({ permission: 'granted', transcript: 'spoken' }).controller;
    document.body.appendChild(el);

    const sources: Array<string | undefined> = [];
    el.addEventListener('submit', (e) => {
      sources.push((e as Event as CustomEvent<{ source?: string }>).detail.source);
    });
    press(el);
    await flush();
    release();
    await flush();
    expect(sources).toEqual(['dictation']);
  });

  it('shows engine errors in the caption (error styling) when start() rejects', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    fake.controller.start = async () => {
      throw new Error('engine exploded');
    };
    const el = mount(fake);
    press(el);
    await flush();

    const caption = pttOf(el)!.querySelector('.slicc-composer__ptt-caption') as HTMLElement;
    expect(caption.hidden).toBe(false);
    expect(caption.classList.contains('is-error')).toBe(true);
    expect(caption.textContent).toContain('exploded');

    // Releasing tears down without inserting anything.
    const ta = el.querySelector('textarea') as HTMLTextAreaElement;
    release();
    await flush();
    expect(pttOf(el)).toBeNull();
    expect(ta.value).toBe('');
  });

  it('bounds the finalize chain so a start() that never settles cannot pin "Transcribing…" (EXT2)', async () => {
    // EXT2 UI backstop: speech.start() never resolves (e.g. an unbounded second
    // getUserMedia). The release must still recover instead of hanging forever
    // at the finalizing "Transcribing…" caption.
    const fake = makeFakeSpeech({ permission: 'granted' });
    fake.controller.start = () => new Promise<SpeechSession>(() => {});
    const el = mount(fake);
    press(el);
    await flush();
    // Recording: start() is in flight and will never settle.
    expect(pttOf(el)?.classList.contains('is-recording')).toBe(true);

    release();
    await flush();
    // Released → the overlay shows the "Transcribing…" finalize caption, but the
    // chain is still pending (start() never resolved).
    const finalizing = pttOf(el);
    expect(finalizing).not.toBeNull();
    expect(finalizing?.querySelector('.slicc-composer__ptt-caption')?.textContent).toBe(
      'Transcribing…'
    );

    // Partway to the bound it is still up (no premature teardown).
    await vi.advanceTimersByTimeAsync(FINALIZE_TIMEOUT_MS - 5000);
    expect(pttOf(el)).not.toBeNull();

    // Past the bound → the overlay tears down and the gesture recovers to idle.
    await vi.advanceTimersByTimeAsync(5000);
    expect(pttOf(el)).toBeNull();
  });

  it('tears down without inserting when the final stop() rejects', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    const start = fake.controller.start.bind(fake.controller);
    fake.controller.start = async (opts) => {
      await start(opts);
      return {
        stop: async () => {
          throw new Error('transcription lost');
        },
        cancel: () => {},
      };
    };
    const el = mount(fake);
    const ta = press(el);
    await flush();
    release();
    await flush();
    expect(pttOf(el)).toBeNull();
    expect(ta.value).toBe('');
  });

  it('exposes device and speech as properties (device persists, speech resets perm)', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    const el = mount(fake);
    expect(el.device).toBeNull();
    el.device = 'usb-1';
    expect(localStorage.getItem('slicc-composer:mic-device')).toBe('usb-1');
    el.device = null;
    expect(localStorage.getItem('slicc-composer:mic-device')).toBeNull();

    // Swapping the controller invalidates the cached permission snapshot:
    // the next press queries the NEW controller.
    const fresh = makeFakeSpeech({ permission: 'granted', transcript: 'fresh' });
    el.speech = fresh.controller;
    expect(el.speech).toBe(fresh.controller);
    const ta = press(el);
    await flush();
    release();
    await flush();
    expect(ta.value).toBe('fresh');
  });
});

describe('slicc-composer / push-to-talk touch path', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
    localStorage.removeItem('slicc-composer:mic-device');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = () => vi.advanceTimersByTimeAsync(PTT_ENGAGE_MS);

  function taOf(el: SliccComposer): HTMLTextAreaElement {
    return el.querySelector('textarea') as HTMLTextAreaElement;
  }

  function touchPress(el: SliccComposer): HTMLTextAreaElement {
    pttTriggerOf(el).dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerType: 'touch',
        pointerId: 100,
      })
    );
    return taOf(el);
  }

  function touchRelease(): void {
    document.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        isPrimary: true,
        pointerType: 'touch',
        pointerId: 100,
      })
    );
  }

  function touchCancel(el: SliccComposer): void {
    el.dispatchEvent(
      new PointerEvent('pointercancel', {
        bubbles: true,
        pointerType: 'touch',
        pointerId: 100,
      })
    );
  }

  function pttOf(el: SliccComposer): HTMLElement | null {
    return el.querySelector('.slicc-composer__ptt');
  }

  function mount(fake: FakeSpeech): SliccComposer {
    const el = makePttComposer();
    el.speech = fake.controller;
    document.body.appendChild(el);
    return el;
  }

  it('a touch tap inside the engage window places the caret and shows NO overlay', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    const el = mount(fake);
    const submits: Event[] = [];
    el.addEventListener('submit', (e) => submits.push(e));

    const ta = touchPress(el);
    // Release before the engage timer fires — the press is torn down with no
    // overlay ever mounted and no speech session touched.
    await vi.advanceTimersByTimeAsync(PTT_ENGAGE_MS - 10);
    touchRelease();
    await flush();

    expect(pttOf(el)).toBeNull();
    expect(ta.value).toBe('');
    expect(fake.calls.start.length).toBe(0);
    expect(submits.length).toBe(0);
  });

  it('a touch hold past the engage window records and submits with source: dictation', async () => {
    const fake = makeFakeSpeech({ permission: 'granted', transcript: 'voiced on touch' });
    const el = mount(fake);
    const submits: Array<{ value: string; source?: string }> = [];
    el.addEventListener('submit', (e) => {
      submits.push((e as Event as CustomEvent<{ value: string; source?: string }>).detail);
    });

    const ta = touchPress(el);
    await flush();
    expect(pttOf(el)?.classList.contains('is-recording')).toBe(true);
    expect(fake.calls.start.length).toBe(1);

    touchRelease();
    await flush();

    expect(pttOf(el)).toBeNull();
    expect(ta.value).toBe('voiced on touch');
    expect(submits).toEqual([{ value: 'voiced on touch', source: 'dictation' }]);
  });

  it('a touch hold on an ungranted controller engages the enable bar (same as mouse)', async () => {
    const fake = makeFakeSpeech({ permission: 'prompt' });
    const el = mount(fake);
    touchPress(el);
    await flush();
    expect(pttOf(el)?.classList.contains('is-enable')).toBe(true);
    touchCancel(el);
    expect(pttOf(el)).toBeNull();
  });

  it('pointercancel mid-touch-recording tears down without inserting', async () => {
    const fake = makeFakeSpeech({ permission: 'granted', transcript: 'should never land' });
    const el = mount(fake);
    const ta = touchPress(el);
    await flush();
    expect(pttOf(el)?.classList.contains('is-recording')).toBe(true);

    touchCancel(el);
    expect(pttOf(el)).toBeNull();
    expect(ta.value).toBe('');
    expect(fake.calls.cancel).toBe(1);
    expect(fake.calls.stop).toBe(0);

    // A late release after cancel must not insert anything either.
    touchRelease();
    await flush();
    expect(ta.value).toBe('');
  });

  it('suppresses scroll-pan / long-press callout on the empty textarea (touch ergonomics)', () => {
    // touch-action is locked at the start of a pointer sequence, so it must sit
    // on the empty textarea (the hold target) up front for a touch hold to
    // record instead of starting a pan. A non-empty textarea keeps native touch
    // handling so scrolling / selection of existing text work.
    const el = mount(makeFakeSpeech({ permission: 'granted' }));
    expect(getComputedStyle(taOf(el)).touchAction).toBe('none');
    taOf(el).value = 'has text';
    expect(getComputedStyle(taOf(el)).touchAction).not.toBe('none');
  });

  it('a non-primary second touch finger does not start a new press', async () => {
    const fake = makeFakeSpeech({ permission: 'granted' });
    const el = mount(fake);

    pttTriggerOf(el).dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        isPrimary: false,
        pointerType: 'touch',
        pointerId: 200,
      })
    );
    await flush();
    expect(pttOf(el)).toBeNull();
    expect(fake.calls.start.length).toBe(0);
  });
});

describe('slicc-composer / ptt opt-in', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  it('without the ptt attribute, pressing the textarea stays native (no overlay, no transcript)', () => {
    const el = document.createElement('slicc-composer');
    el.style.cssText = 'width:1000px;display:block;';
    const ta = document.createElement('textarea');
    ta.className = 'ta';
    el.append(ta);
    document.body.appendChild(el);

    ta.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerType: 'mouse',
        pointerId: 1,
        cancelable: true,
      })
    );
    expect(el.querySelector('.slicc-composer__ptt')).toBeNull();

    document.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        isPrimary: true,
        pointerType: 'mouse',
        pointerId: 1,
      })
    );
    expect(ta.value).toBe('');
    el.remove();
  });

  it('with ptt enabled, touch-action:none sits on the EMPTY textarea AT REST (the hold target)', () => {
    // touch-action is locked at the start of a pointer sequence, so it must be
    // on the hold target (the empty textarea) up front. Once the textarea has
    // text it is left free so a click-drag selects text instead of arming.
    const el = makePttComposer();
    document.body.appendChild(el);
    const ta = el.querySelector('textarea') as HTMLTextAreaElement;
    expect(getComputedStyle(ta).touchAction).toBe('none');
    ta.value = 'typed';
    expect(getComputedStyle(ta).touchAction).not.toBe('none');
    el.remove();
  });

  it('without the ptt attribute the textarea keeps native touch-action', () => {
    const el = document.createElement('slicc-composer');
    el.style.cssText = 'width:1000px;display:block;';
    const card = document.createElement('slicc-input-card');
    el.append(card);
    document.body.appendChild(el);
    // No ptt → the [ptt]-scoped touch-action rule must NOT bleed onto the textarea.
    expect(getComputedStyle(el.querySelector('textarea') as HTMLElement).touchAction).not.toBe(
      'none'
    );
    el.remove();
  });
});
