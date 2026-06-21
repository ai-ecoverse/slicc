import type { Meta, StoryObj } from '@storybook/web-components-vite';
// Compose the footer by tag from real library siblings — importing each module
// registers its custom element so the markup below upgrades on mount. The input
// card itself composes the add-menu + send-button; we still import those leaves
// directly so the custom send-button (with a gravatar `email`) we slot in is
// registered too, and so the meta row's model/thinking pills are available.
import '../add-menu/slicc-add-menu.js';
import type { SliccAddDetail } from '../add-menu/slicc-add-menu.js';
import '../primitives/slicc-send-button.js';
import './slicc-composer-capture.js';
import type {
  CameraMediaProvider,
  CaptureResult,
  SliccComposerCapture,
} from './slicc-composer-capture.js';
import './slicc-composer-meta.js';
import './slicc-composer.js';
import './slicc-input-card.js';
import type { SliccComposer } from './slicc-composer.js';
import type { ComposerSpeech, MicrophoneInfo, SpeechEngineStatus } from './speech.js';

interface ComposerArgs {
  open?: boolean;
}

const meta: Meta<ComposerArgs> = {
  title: 'Composer/Composer',
  component: 'slicc-composer',
  tags: ['autodocs'],
  argTypes: {
    open: {
      control: 'boolean',
      description: 'Narrow-chat variant (hides the meta keyboard hint); mirrors .shell.open',
    },
  },
};

export default meta;
type Story = StoryObj<ComposerArgs>;

/**
 * A realistic gravatar seed for the send button's face. The send button hashes
 * this with SHA-256 and paints the resolved gravatar as the circular ground
 * (falling back to the rainbow gradient until/unless it resolves).
 */
const DEMO_EMAIL = 'lars@trieloff.net';

/** Realistic, prototype-flavored placeholder copy for the composer textarea. */
const PLACEHOLDER = 'Ask sliccy, or describe a change — e.g. “make the landing hero feel warmer”…';

/**
 * Build the fully-populated `<slicc-input-card>`: a real card composing, via its
 * `toolbar` slot, the `<slicc-add-menu>` (which slides its searchbox in next to
 * the +/× trigger) and a `<slicc-send-button>` carrying a gravatar `email` so it
 * paints a real face. A flex spacer pushes the send button to the right edge,
 * matching the prototype `.toolbar` (`add-menu · spacer · send`).
 */
function inputCard(): HTMLElement {
  const card = document.createElement('slicc-input-card');
  card.setAttribute('placeholder', PLACEHOLDER);
  card.setAttribute(
    'value',
    'Audit the cold landing hero, then redesign it in a live sprinkle. ' +
      'Verify the before/after in the browser and open a PR.'
  );

  const addMenu = document.createElement('slicc-add-menu');
  addMenu.setAttribute('slot', 'toolbar');

  const spacer = document.createElement('div');
  spacer.setAttribute('slot', 'toolbar');
  spacer.style.flex = '1';

  const send = document.createElement('slicc-send-button');
  send.setAttribute('slot', 'toolbar');
  send.setAttribute('email', DEMO_EMAIL);

  card.append(addMenu, spacer, send);
  return card;
}

/** Build the populated `<slicc-composer-meta>` row (model + thinking + hint). */
function metaRow(narrow: boolean): HTMLElement {
  const row = document.createElement('slicc-composer-meta');
  row.setAttribute('model', 'Opus 4.8');
  row.setAttribute('thinking', 'max');
  // Narrow-chat: the composer's own [open] CSS hides any `.slicc-composer__hint`
  // / `[data-composer-hint]`, but the meta row keeps its hint inside a shadow
  // root — so also flag the row `narrow` to drop its hint in the tight column.
  if (narrow) row.setAttribute('narrow', '');
  return row;
}

/**
 * A canvas-backed `CameraMediaProvider` for photo-only capture in the composer
 * story: one fake `videoinput` paints a hued, animated canvas at 15fps and
 * `enumerateDevices()` returns the matching `MediaDeviceInfo`. Photo mode never
 * asks for audio, so no oscillator / mic track is needed here — the broader
 * multi-camera + video + mic variants live in `slicc-composer-capture.stories.ts`.
 * Keeps the inline-capture demo permission-free without dragging the full fake
 * provider over from the capture-surface story.
 */
function makeFakePhotoProvider(): CameraMediaProvider {
  return {
    getUserMedia: async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      let t = 0;
      const tick = setInterval(() => {
        t += 1;
        ctx.fillStyle = `hsl(28, 70%, ${55 + 10 * Math.sin(t / 10)}%)`;
        ctx.fillRect(0, 0, 640, 480);
        ctx.fillStyle = '#fff';
        ctx.font = '28px sans-serif';
        ctx.fillText('Demo camera', 24, 240);
        ctx.font = '14px monospace';
        ctx.fillText(`frame ${t}`, 24, 280);
      }, 80);
      const stream = new MediaStream();
      const track = canvas.captureStream(15).getVideoTracks()[0];
      const origStop = track.stop.bind(track);
      track.stop = () => {
        clearInterval(tick);
        origStop();
      };
      track.getSettings = () =>
        ({ deviceId: 'demo-front', facingMode: 'user' }) as MediaTrackSettings;
      stream.addTrack(track);
      return stream;
    },
    enumerateDevices: async () => [
      { kind: 'videoinput', deviceId: 'demo-front', label: 'Demo camera' } as MediaDeviceInfo,
    ],
  };
}

/**
 * Append a small thumbnail line to the faux thread so the add-menu → capture →
 * result round-trip is visible without leaving the story. Photo results carry
 * a PNG data URL; the block uses token-driven surfaces so it reads in both
 * light and dark themes.
 */
function appendPhotoResult(thread: HTMLElement, result: CaptureResult): void {
  if (result.kind !== 'image' || !result.dataUrl) return;
  const block = document.createElement('p');
  block.style.cssText =
    'margin:14px 0 0;padding:10px;border:1px solid var(--line);border-radius:10px;' +
    'background:var(--canvas);color:var(--ink);display:flex;align-items:center;gap:10px;';
  const img = document.createElement('img');
  img.src = result.dataUrl;
  img.alt = 'Captured photo';
  img.style.cssText = 'width:64px;height:48px;object-fit:cover;border-radius:6px;display:block;';
  const cap = document.createElement('span');
  cap.style.cssText = 'font-size:12px;color:var(--txt-2);';
  cap.textContent = `Snapped ${result.width}×${result.height} · ${result.mimeType}`;
  block.append(img, cap);
  thread.appendChild(block);
}

/**
 * Wire the add-menu's "Take a photo" quick-action to the inline capture
 * surface mounted as a full-area overlay on the chat-column shell: when
 * `slicc-add` bubbles up with `{ kind: 'capture', mode: 'photo' }`, un-hide
 * the surface (it covers the thread + composer band, mirroring the PTT
 * overlay / drop-zone pattern) and `open('photo')`. When the promise
 * resolves (snap or cancel — `#finishCapture` re-hides the surface itself),
 * surface any photo result in the thread. The composer band stays untouched
 * underneath the overlay, so no card/meta toggling is needed.
 */
function wireInlineCapture(
  composer: SliccComposer,
  capture: SliccComposerCapture,
  thread: HTMLElement
): void {
  let active = false;
  composer.addEventListener('slicc-add', (event) => {
    const detail = (event as CustomEvent<SliccAddDetail>).detail;
    // The detail union's catch-all variant overlaps with `kind: 'capture'`, so
    // narrow on the `mode` property's presence before reading it.
    if (active || detail.kind !== 'capture' || !('mode' in detail)) return;
    if (detail.mode !== 'photo') return;
    active = true;
    void capture.open('photo').then((result) => {
      active = false;
      if (result) appendPhotoResult(thread, result);
    });
  });
}

/**
 * Build a fully-populated composer mounted in a chat-column shell, so the
 * frosted footer band reads against a chat-thread-like surface above it (the
 * prototype layout). The footer is composed entirely from real library
 * components: `<slicc-input-card>` (add-menu + gravatar send button) + a
 * `<slicc-composer-meta>` row. Light/dark is driven by the global theme toolbar.
 *
 * The shell also hosts a `<slicc-composer-capture>` surface as a full-area
 * overlay (hidden at rest, fake camera provider so no real permission is
 * needed). It is appended to the shell — not into the composer band — and
 * given story-level inline styles that override the component's self-bounded
 * tag stylesheet so it fills the whole chat column (`position:absolute;
 * inset:0; z-index:10`), mirroring the PTT overlay and add-menu drop-zone
 * pattern. The add-menu's "Take a photo" quick-action drives it inline via
 * the bubbling `slicc-add` event — Snap or Cancel returns to the resting
 * composer and surfaces any photo result in the thread.
 */
function composer({ open }: ComposerArgs): HTMLElement {
  // A chat-column shell: faux thread above, composer footer pinned below.
  // `position:relative` anchors the absolutely-positioned capture overlay.
  const shell = document.createElement('div');
  shell.style.cssText =
    'position:relative;display:flex;flex-direction:column;height:460px;width:100%;background:var(--bg);overflow:hidden;font-family:var(--ui);';

  const thread = document.createElement('div');
  thread.style.cssText =
    'flex:1 1 auto;overflow:auto;padding:28px 24px;color:var(--txt-2);font-size:14px;line-height:1.5;';
  for (const [tone, text] of [
    ['ink', 'Make the landing hero feel warmer.'],
    [
      'mute',
      'On it — auditing the cold hero, then redesigning in a live sprinkle. I will verify before/after in the browser and open a PR.',
    ],
    [
      'mute',
      'The composer footer below frosts over this thread; opening the add-menu pops a results panel up and over these lines (z-index:2) without growing the band.',
    ],
  ] as const) {
    const p = document.createElement('p');
    p.textContent = text;
    p.style.cssText = tone === 'ink' ? 'margin:0 0 12px;color:var(--ink);' : 'margin:0 0 12px;';
    thread.appendChild(p);
  }

  const el = document.createElement('slicc-composer') as SliccComposer;
  if (open) el.setAttribute('open', '');
  el.append(inputCard(), metaRow(Boolean(open)));

  const capture = document.createElement('slicc-composer-capture') as SliccComposerCapture;
  capture.media = makeFakePhotoProvider();
  capture.setAttribute('mode', 'photo');
  capture.hidden = true;
  // Story-level overlay: inline styles win over the component's tag-selector
  // self-bounded box (4:3 / max 480px) so the surface fills the whole chat
  // column with its bottom control bar fully visible. Same pattern as the
  // PTT overlay (`.slicc-composer__ptt`) and the add-menu drop zone (`.drop`).
  capture.style.cssText =
    'position:absolute;inset:0;z-index:10;max-height:none;aspect-ratio:auto;border-radius:0;';

  wireInlineCapture(el, capture, thread);

  shell.append(thread, el, capture);
  return shell;
}

/**
 * Default — full-width chat. The frosted footer band composes a real
 * `<slicc-input-card>` (its `<slicc-add-menu>` toolbar + a gravatar
 * `<slicc-send-button>`) over a `<slicc-composer-meta>` row whose keyboard hint
 * (Enter to send, Shift+Enter for a newline) stays
 * visible. Every glyph is a real lucide `<svg>` from the composed components —
 * never an emoji. Flip the global theme toolbar for dark mode; widen via the
 * viewport toolbar.
 */
export const Default: Story = {
  args: {},
  render: composer,
};

/**
 * Narrow / shell-open — the 34% chat pane. The composer's `open` attribute (plus
 * the meta row's `narrow` flag) hides the keyboard hint, keeping just the model
 * pill and the thinking pill. Mirrors the prototype's `.shell.open .meta .hint`.
 */
export const Narrow: Story = {
  args: { open: true },
  render: composer,
};

/**
 * Build a tall, scrollable faux chat thread so the composer's frosted-glass band
 * has real content to scroll *under* it. Each turn is a plain paragraph; the
 * container scrolls, and a generous bottom padding lets the last lines slide
 * beneath the pinned composer rather than ending above it.
 */
function tallThread(): HTMLElement {
  const thread = document.createElement('div');
  // The scroll surface fills the shell; bottom padding clears the overlaid band
  // so the final lines can scroll fully underneath the frosted pane.
  thread.style.cssText =
    'position:absolute;inset:0;overflow-y:auto;padding:28px 24px 220px;' +
    'color:var(--txt-2);font-size:14px;line-height:1.5;';

  const turns = [
    ['user', 'Make the landing hero feel warmer.'],
    ['agent', 'On it — auditing the cold hero, then redesigning in a live sprinkle.'],
    ['user', 'Keep the headline, just shift the palette and the imagery mood.'],
    [
      'agent',
      'Pulling the current tokens; the hero leans on a flat slate background with no accent warmth.',
    ],
    ['user', 'Right. Warmer, but still calm — not a sunset gradient.'],
    [
      'agent',
      'Drafting a muted amber wash over the existing canvas, then verifying contrast for the CTA.',
    ],
    ['user', 'Scroll down — does the rest of the page still read against it?'],
    [
      'agent',
      'Checking the fold below: cards keep their surface, the warm wash only tints the hero band.',
    ],
    ['user', 'Good. Notice how these lines slide under the composer as they scroll.'],
    [
      'agent',
      'Exactly — the frosted band stays pinned; the thread blurs faintly beneath it (backdrop-filter).',
    ],
    ['user', 'Ship it once the before/after looks right.'],
    ['agent', 'Opening the PR with the before/after screenshots attached.'],
  ];

  for (const [role, text] of turns) {
    const p = document.createElement('p');
    p.textContent = text;
    p.style.cssText = role === 'user' ? 'margin:0 0 14px;color:var(--ink);' : 'margin:0 0 14px;';
    thread.appendChild(p);
  }
  return thread;
}

/**
 * Build a composer overlaid at the bottom of a scrollable thread, so the frosted
 * band actually sits *over* the scrolling chat content. As the thread scrolls,
 * its lines pass beneath the semi-transparent composer and read through the
 * `backdrop-filter` blur — the layered "scroll-under" look from the prototype.
 */
function scrollUnder({ open }: ComposerArgs): HTMLElement {
  const shell = document.createElement('div');
  shell.style.cssText =
    'position:relative;height:460px;width:100%;background:var(--bg);overflow:hidden;font-family:var(--ui);';

  const el = document.createElement('slicc-composer') as SliccComposer;
  // Pin the band to the bottom edge so the thread scrolls underneath it.
  el.style.cssText = 'position:absolute;left:0;right:0;bottom:0;';
  if (open) el.setAttribute('open', '');
  el.append(inputCard(), metaRow(Boolean(open)));

  shell.append(tallThread(), el);
  return shell;
}

/**
 * Scroll-under — the frosted-glass layering. The chat thread is a real scroll
 * surface; the composer is pinned over its bottom edge. Scroll the thread and
 * its lines pass *beneath* the semi-transparent band, blurred + tinted by the
 * composer's `backdrop-filter`. Flip the theme toolbar to confirm the frosted
 * tint recomputes from `--ctx`/`--bg` in both light and dark.
 */
export const ScrollUnder: Story = {
  args: {},
  render: scrollUnder,
};

/**
 * A scripted {@link ComposerSpeech} for deterministic push-to-talk stories: a
 * fixed permission state, a canned device list, looping caption partials while
 * a session is live, and (optionally) a ticking model-download ETA. No real
 * microphone or recognizer is touched — Storybook frames stay reproducible.
 */
function scriptedSpeech(config: {
  permission: PermissionState;
  mics?: MicrophoneInfo[];
  downloading?: boolean;
  /** Render the actionable failure line instead of downloading/ready. */
  unavailable?: string;
}): ComposerSpeech {
  let permission = config.permission;
  const statusSubs = new Set<(s: SpeechEngineStatus) => void>();
  let status: SpeechEngineStatus = config.unavailable
    ? { engine: 'builtin', state: 'unavailable', message: config.unavailable }
    : config.downloading
      ? {
          engine: 'builtin',
          state: 'downloading',
          download: { loaded: 38_000_000, total: 150_000_000, etaSeconds: 52 },
        }
      : { engine: 'enhanced', state: 'ready' };

  // The downloading variant ticks its ETA down like a live fetch would.
  if (config.downloading) {
    setInterval(() => {
      const download = status.download;
      if (status.state !== 'downloading' || !download?.etaSeconds) return;
      const etaSeconds = Math.max(1, download.etaSeconds - 1);
      const loaded = Math.min(download.total, download.loaded + 2_200_000);
      status = { ...status, download: { ...download, etaSeconds, loaded } };
      for (const cb of statusSubs) cb(status);
    }, 1000);
  }

  const SCRIPT =
    'make the landing hero feel warmer and add a clear call to action above the fold'.split(' ');

  return {
    permission: async () => permission,
    requestPermission: async () => {
      permission = 'granted';
      return true;
    },
    microphones: async () => config.mics ?? [{ deviceId: 'default', label: 'Built-in Microphone' }],
    start: async (opts) => {
      let i = 0;
      const timer = setInterval(() => {
        i = Math.min(i + 1, SCRIPT.length);
        opts.onPartial?.(SCRIPT.slice(0, i).join(' '));
      }, 350);
      return {
        stop: async () => {
          clearInterval(timer);
          return SCRIPT.slice(0, Math.max(i, 4)).join(' ');
        },
        cancel: () => clearInterval(timer),
      };
    },
    status: () => status,
    onStatus: (cb) => {
      statusSubs.add(cb);
      cb(status);
      return () => statusSubs.delete(cb);
    },
    warmup: () => {},
  };
}

/** Push-to-talk story scaffold: a short thread + an armed PTT composer. */
function pttShell(hint: string, el: SliccComposer): HTMLElement {
  const shell = document.createElement('div');
  shell.style.cssText =
    'display:flex;flex-direction:column;height:300px;width:100%;background:var(--bg);overflow:hidden;font-family:var(--ui);';
  const thread = document.createElement('div');
  thread.style.cssText = 'flex:1 1 auto;padding:24px;color:var(--txt-2);font-size:14px;';
  thread.textContent = hint;
  shell.append(thread, el);
  return shell;
}

function pttComposer(speech: ComposerSpeech, open?: boolean): SliccComposer {
  const el = document.createElement('slicc-composer') as SliccComposer;
  el.setAttribute('ptt', '');
  if (open) el.setAttribute('open', '');
  el.speech = speech;
  el.append(inputCard(), metaRow(Boolean(open)));
  return el;
}

/** Arm the gesture once the input card has upgraded and built its textarea. */
function armPress(el: SliccComposer): void {
  requestAnimationFrame(() => {
    const ta = el.querySelector('textarea');
    ta?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
}

/**
 * Drive the full gesture to its open device-menu, for the long-mic-list variant:
 * press (a real PointerEvent so the host's pointerdown handler engages), then —
 * once the recording overlay has rendered its picker — release over the picker
 * to open the option menu. Polls for the picker button since the mic list loads
 * asynchronously. If the engine never reaches the picking stage the story simply
 * renders the resting composer.
 */
function armAndOpenPicker(el: SliccComposer): void {
  const pointer = { bubbles: true, isPrimary: true, pointerType: 'mouse', pointerId: 1 } as const;
  requestAnimationFrame(() => {
    const ta = el.querySelector('textarea');
    ta?.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, button: 0 }));
    const tryOpen = (remaining: number): void => {
      const btn = el.querySelector('.slicc-composer__ptt-device-btn') as HTMLElement | null;
      if (btn) {
        btn.dispatchEvent(new PointerEvent('pointerup', pointer));
      } else if (remaining > 0) {
        setTimeout(() => tryOpen(remaining - 1), 120);
      }
    };
    setTimeout(() => tryOpen(20), 220);
  });
}

/**
 * Push-to-talk, stage 1 — no microphone permission yet. Holding the textarea
 * shows the "Hold to enable push to talk" bar filling over three seconds; a
 * press held to completion requests mic permission (scripted to grant here,
 * upgrading the held press straight into the recording stage). Release early
 * to cancel without prompting.
 */
export const PushToTalkEnable: Story = {
  args: {},
  render: ({ open }) => {
    const el = pttComposer(scriptedSpeech({ permission: 'prompt' }), open);
    armPress(el);
    return pttShell(
      'Hold the input below: the 3s bar fills, then permission is requested (scripted to grant).',
      el
    );
  },
};

/**
 * Push-to-talk, stage 2 — permission granted, dictating. The held band shows
 * the pulsing mic, the closed-caption line streaming the last detected words,
 * the microphone picker (two scripted devices — release OVER it to switch
 * mics instead of sending), and the "better speech recognition downloading ·
 * ready in ~ETA" line ticking down like a live model fetch. Release anywhere
 * else to append the transcript and submit.
 */
export const PushToTalkRecording: Story = {
  args: {},
  render: ({ open }) => {
    const el = pttComposer(
      scriptedSpeech({
        permission: 'granted',
        downloading: true,
        mics: [
          { deviceId: 'built-in', label: 'Built-in Microphone' },
          { deviceId: 'usb', label: 'Studio USB Mic' },
        ],
      }),
      open
    );
    armPress(el);
    return pttShell(
      'Recording: captions stream under the mic; release over the picker to switch devices.',
      el
    );
  },
};

/**
 * Push-to-talk, many devices — a long microphone list with the composer pinned
 * near the bottom of the viewport. Released over the picker, the option menu has
 * no room beneath it, so it flips upward and caps its height (scrolling the
 * overflow) to stay fully on-screen rather than clipping off the bottom edge.
 * Flip the global theme toolbar to confirm the flipped, scrollable menu reads in
 * both light and dark.
 */
export const PushToTalkManyDevices: Story = {
  args: {},
  render: ({ open }) => {
    const mics = Array.from({ length: 8 }, (_, i) => ({
      deviceId: `mic-${i}`,
      label: `Microphone ${i + 1} — USB Audio Device`,
    }));
    const el = pttComposer(scriptedSpeech({ permission: 'granted', mics }), open);
    // A tall shell pins the composer near the bottom of the iframe viewport, so
    // the menu measures little room below and flips up.
    const shell = document.createElement('div');
    shell.style.cssText =
      'display:flex;flex-direction:column;justify-content:flex-end;height:96vh;width:100%;' +
      'background:var(--bg);overflow:hidden;font-family:var(--ui);';
    const thread = document.createElement('div');
    thread.style.cssText = 'flex:1 1 auto;padding:24px;color:var(--txt-2);font-size:14px;';
    thread.textContent =
      'Many mics: release over the picker — the menu flips up and scrolls so it never runs off the bottom.';
    shell.append(thread, el);
    armAndOpenPicker(el);
    return shell;
  },
};

/**
 * Push-to-talk, enhanced engine unavailable — the on-device assets could not be
 * staged (e.g. offline) and aren't already present. Instead of silently hiding
 * the status line, the composer surfaces an actionable failure message while
 * dictation keeps working on the built-in recognizer.
 */
export const PushToTalkUnavailable: Story = {
  args: {},
  render: ({ open }) => {
    const el = pttComposer(
      scriptedSpeech({
        permission: 'granted',
        unavailable: 'Enhanced speech unavailable — offline. Reconnect and hold again to retry.',
      }),
      open
    );
    armPress(el);
    return pttShell(
      'Recording: the enhanced engine failed to stage — the failure line shows and builtin dictation still runs.',
      el
    );
  },
};

/**
 * Push-to-talk, live — no scripted controller: the component falls back to the
 * built-in Web Speech engine, so holding the textarea drives the REAL
 * permission prompt and recognizer (Chromium only; needs a microphone). Useful
 * for manually exercising the full gesture in Storybook.
 */
export const PushToTalkLive: Story = {
  args: {},
  render: ({ open }) => {
    const el = document.createElement('slicc-composer') as SliccComposer;
    el.setAttribute('ptt', '');
    if (open) el.setAttribute('open', '');
    el.append(inputCard(), metaRow(Boolean(open)));
    return pttShell('Live: hold the input and speak (real mic permission + recognition).', el);
  },
};
