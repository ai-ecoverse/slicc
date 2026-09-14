import type { Meta, StoryObj } from '@storybook/web-components-vite';

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

const DEMO_EMAIL = 'lars@trieloff.net';

const PLACEHOLDER = 'Ask sliccy, or describe a change — e.g. “make the landing hero feel warmer”…';

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

function metaRow(narrow: boolean): HTMLElement {
  const row = document.createElement('slicc-composer-meta');
  row.setAttribute('model', 'Opus 4.8');
  row.setAttribute('thinking', 'max');

  if (narrow) row.setAttribute('narrow', '');
  return row;
}

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

function wireInlineCapture(
  composer: SliccComposer,
  capture: SliccComposerCapture,
  thread: HTMLElement
): void {
  let active = false;
  composer.addEventListener('slicc-add', (event) => {
    const detail = (event as CustomEvent<SliccAddDetail>).detail;

    if (active || detail.kind !== 'capture' || !('mode' in detail)) return;
    if (detail.mode !== 'photo') return;
    active = true;
    void capture.open('photo').then((result) => {
      active = false;
      if (result) appendPhotoResult(thread, result);
    });
  });
}

function composer({ open }: ComposerArgs): HTMLElement {
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

  capture.style.cssText =
    'position:absolute;inset:0;z-index:10;max-height:none;aspect-ratio:auto;border-radius:0;';

  wireInlineCapture(el, capture, thread);

  shell.append(thread, el, capture);
  return shell;
}

export const Default: Story = {
  args: {},
  render: composer,
};

export const Narrow: Story = {
  args: { open: true },
  render: composer,
};

function tallThread(): HTMLElement {
  const thread = document.createElement('div');

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

function scrollUnder({ open }: ComposerArgs): HTMLElement {
  const shell = document.createElement('div');
  shell.style.cssText =
    'position:relative;height:460px;width:100%;background:var(--bg);overflow:hidden;font-family:var(--ui);';

  const el = document.createElement('slicc-composer') as SliccComposer;

  el.style.cssText = 'position:absolute;left:0;right:0;bottom:0;';
  if (open) el.setAttribute('open', '');
  el.append(inputCard(), metaRow(Boolean(open)));

  shell.append(tallThread(), el);
  return shell;
}

export const ScrollUnder: Story = {
  args: {},
  render: scrollUnder,
};

function scriptedSpeech(config: {
  permission: PermissionState;
  mics?: MicrophoneInfo[];
  downloading?: boolean;

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

const PTT_POINTER = {
  bubbles: true,
  isPrimary: true,
  pointerType: 'mouse',
  pointerId: 1,
} as const;

function armPress(el: SliccComposer): void {
  requestAnimationFrame(() => {
    const trigger = el.querySelector('textarea');
    trigger?.dispatchEvent(new PointerEvent('pointerdown', { ...PTT_POINTER, button: 0 }));
  });
}

function armAndOpenPicker(el: SliccComposer): void {
  requestAnimationFrame(() => {
    const trigger = el.querySelector('textarea');
    trigger?.dispatchEvent(new PointerEvent('pointerdown', { ...PTT_POINTER, button: 0 }));
    const tryOpen = (remaining: number): void => {
      const btn = el.querySelector('.slicc-composer__ptt-device-btn') as HTMLElement | null;
      if (btn) {
        btn.dispatchEvent(new PointerEvent('pointerup', PTT_POINTER));
      } else if (remaining > 0) {
        setTimeout(() => tryOpen(remaining - 1), 120);
      }
    };
    setTimeout(() => tryOpen(20), 220);
  });
}

export const PushToTalkEnable: Story = {
  args: {},
  render: ({ open }) => {
    const el = pttComposer(scriptedSpeech({ permission: 'prompt' }), open);
    armPress(el);
    return pttShell(
      'Hold the textarea: the 1s bar fills, then permission is requested (scripted to grant).',
      el
    );
  },
};

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

export const PushToTalkManyDevices: Story = {
  args: {},
  render: ({ open }) => {
    const mics = Array.from({ length: 8 }, (_, i) => ({
      deviceId: `mic-${i}`,
      label: `Microphone ${i + 1} — USB Audio Device`,
    }));
    const el = pttComposer(scriptedSpeech({ permission: 'granted', mics }), open);

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

export const PushToTalkLive: Story = {
  args: {},
  render: ({ open }) => {
    const el = document.createElement('slicc-composer') as SliccComposer;
    el.setAttribute('ptt', '');
    if (open) el.setAttribute('open', '');
    el.append(inputCard(), metaRow(Boolean(open)));
    return pttShell('Live: hold the textarea and speak (real mic permission + recognition).', el);
  },
};
