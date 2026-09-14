import type { Meta, StoryObj } from '@storybook/web-components-vite';

import './slicc-composer-capture.js';
import './slicc-composer.js';
import type { SliccComposer } from './slicc-composer.js';
import type {
  CameraMediaProvider,
  CaptureMode,
  CaptureResult,
  SliccComposerCapture,
} from './slicc-composer-capture.js';

interface CaptureArgs {
  mode?: CaptureMode;
  deviceCount?: number;
  micCount?: number;
  useFake?: boolean;
}

const meta: Meta<CaptureArgs> = {
  title: 'Composer/CaptureSurface',
  component: 'slicc-composer-capture',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  argTypes: {
    mode: {
      control: 'inline-radio',
      options: ['photo', 'video'],
      description: 'Initial capture mode (still photo or recorded video).',
    },
    deviceCount: {
      control: { type: 'number', min: 1, max: 2 },
      description: 'How many fake cameras the provider exposes (picker hidden at 1).',
    },
    micCount: {
      control: { type: 'number', min: 1, max: 2 },
      description: 'How many fake mics the provider exposes (picker hidden at 1).',
    },
    useFake: {
      control: 'boolean',
      description: 'Use the canvas-backed fake provider (off → real navigator.mediaDevices).',
    },
  },
};
export default meta;
type Story = StoryObj<CaptureArgs>;

const FAKE_W = 640;
const FAKE_H = 480;

const FAKE_DEVICES = [
  { deviceId: 'demo-front', label: 'Demo front camera', facing: 'user', hue: 28 },
  { deviceId: 'demo-rear', label: 'Demo rear camera', facing: 'environment', hue: 200 },
] as const;

const FAKE_MICS = [
  { deviceId: 'demo-mic-internal', label: 'Demo built-in microphone' },
  { deviceId: 'demo-mic-usb', label: 'Demo USB condenser' },
] as const;

function extractExactDeviceId(video: MediaStreamConstraints['video']): string | undefined {
  if (typeof video !== 'object' || video === null) return undefined;
  if (!('deviceId' in video)) return undefined;
  const d = (video as MediaTrackConstraints).deviceId;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && 'exact' in d) {
    const exact = (d as { exact?: string | string[] }).exact;
    return Array.isArray(exact) ? exact[0] : exact;
  }
  return undefined;
}

function makeFakeVideoTrack(device: (typeof FAKE_DEVICES)[number]): MediaStreamTrack {
  const canvas = document.createElement('canvas');
  canvas.width = FAKE_W;
  canvas.height = FAKE_H;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  let t = 0;
  const tick = setInterval(() => {
    t += 1;
    ctx.fillStyle = `hsl(${device.hue}, 70%, ${55 + 10 * Math.sin(t / 10)}%)`;
    ctx.fillRect(0, 0, FAKE_W, FAKE_H);
    ctx.fillStyle = '#fff';
    ctx.font = '28px sans-serif';
    ctx.fillText(device.label, 24, 240);
    ctx.font = '14px monospace';
    ctx.fillText(`frame ${t}`, 24, 280);
  }, 80);
  const stream = canvas.captureStream(15);
  const track = stream.getVideoTracks()[0];
  const origStop = track.stop.bind(track);
  track.stop = () => {
    clearInterval(tick);
    origStop();
  };
  track.getSettings = () =>
    ({ deviceId: device.deviceId, facingMode: device.facing }) as MediaTrackSettings;
  return track;
}

function makeFakeAudioTrack(deviceId: string): MediaStreamTrack {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  osc.frequency.value = 220;
  const gain = ctx.createGain();
  gain.gain.value = 0.00001;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  const track = dest.stream.getAudioTracks()[0];
  const origStop = track.stop.bind(track);
  track.stop = () => {
    try {
      osc.stop();
    } catch {}
    origStop();
  };
  track.getSettings = () => ({ deviceId }) as MediaTrackSettings;
  return track;
}

function extractExactAudioId(audio: MediaStreamConstraints['audio']): string | undefined {
  if (typeof audio !== 'object' || audio === null) return undefined;
  if (!('deviceId' in audio)) return undefined;
  const d = (audio as MediaTrackConstraints).deviceId;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && 'exact' in d) {
    const exact = (d as { exact?: string | string[] }).exact;
    return Array.isArray(exact) ? exact[0] : exact;
  }
  return undefined;
}

function makeFakeProvider(deviceCount: number, micCount: number): CameraMediaProvider {
  const devices = FAKE_DEVICES.slice(0, Math.max(1, Math.min(deviceCount, FAKE_DEVICES.length)));
  const mics = FAKE_MICS.slice(0, Math.max(1, Math.min(micCount, FAKE_MICS.length)));
  return {
    getUserMedia: async (constraints) => {
      const stream = new MediaStream();
      if (constraints.video) {
        const exact = extractExactDeviceId(constraints.video) ?? devices[0].deviceId;
        const device = devices.find((d) => d.deviceId === exact) ?? devices[0];
        stream.addTrack(makeFakeVideoTrack(device));
      }
      if (constraints.audio) {
        const exactMic = extractExactAudioId(constraints.audio) ?? mics[0].deviceId;
        const mic = mics.find((m) => m.deviceId === exactMic) ?? mics[0];
        stream.addTrack(makeFakeAudioTrack(mic.deviceId));
      }
      return stream;
    },
    enumerateDevices: async () => [
      ...devices.map(
        (d) => ({ kind: 'videoinput', deviceId: d.deviceId, label: d.label }) as MediaDeviceInfo
      ),
      ...mics.map(
        (m) => ({ kind: 'audioinput', deviceId: m.deviceId, label: m.label }) as MediaDeviceInfo
      ),
    ],
  };
}

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function appendResult(thread: HTMLElement, result: CaptureResult): void {
  const block = document.createElement('div');
  block.style.cssText =
    'margin-top:14px;padding:12px;border:1px solid var(--line);border-radius:10px;' +
    'background:var(--canvas);color:var(--ink);';
  const cap = document.createElement('p');
  cap.style.cssText = 'margin:0 0 8px;font-size:12px;color:var(--txt-2);';
  if (result.kind === 'image' && result.dataUrl) {
    cap.textContent = `Snapped ${result.width}×${result.height} · ${result.mimeType}`;
    const img = document.createElement('img');
    img.src = result.dataUrl;
    img.alt = 'Captured photo';
    img.style.cssText = 'max-width:280px;display:block;border-radius:8px;';
    block.append(cap, img);
  } else if (result.kind === 'video' && result.dataUrl) {
    const tracks = result.blob ? ` · ${(result.blob.size / 1024).toFixed(1)} KB` : '';
    cap.textContent =
      `Recorded ${formatDuration(result.durationMs)} · ` +
      `${result.width}×${result.height} · ${result.mimeType}${tracks}`;
    const vid = document.createElement('video');
    vid.src = result.dataUrl;
    vid.controls = true;
    vid.playsInline = true;
    vid.style.cssText = 'max-width:360px;display:block;border-radius:8px;';
    block.append(cap, vid);
  }
  thread.appendChild(block);
  thread.scrollTop = thread.scrollHeight;
}

function buildShell(args: CaptureArgs): HTMLElement {
  const mode: CaptureMode = args.mode === 'video' ? 'video' : 'photo';
  const useFake = args.useFake !== false;
  const deviceCount = args.deviceCount ?? 2;
  const micCount = args.micCount ?? 1;

  const shell = document.createElement('div');
  shell.style.cssText =
    'display:flex;flex-direction:column;height:560px;width:100%;background:var(--bg);' +
    'overflow:hidden;font-family:var(--ui);';

  const thread = document.createElement('div');
  thread.style.cssText =
    'flex:1 1 auto;overflow:auto;padding:28px 24px;color:var(--txt-2);' +
    'font-size:14px;line-height:1.5;';
  const intro = document.createElement('p');
  intro.style.cssText = 'margin:0 0 12px;color:var(--ink);';
  intro.textContent = useFake
    ? 'Inline capture surface, inside the composer band below — canvas-backed fake stream, no permission needed. Snap (photo) or Record / Stop (video); the result appears in this thread.'
    : 'Inline capture surface against the real navigator.mediaDevices — the browser will ask for camera access when you press Open.';
  thread.appendChild(intro);

  const composer = document.createElement('slicc-composer') as SliccComposer;
  const capture = document.createElement('slicc-composer-capture') as SliccComposerCapture;
  if (useFake) capture.media = makeFakeProvider(deviceCount, micCount);
  capture.setAttribute('mode', mode);

  capture.hidden = true;
  composer.append(capture);

  const openOnce = (): void => {
    void capture.open(mode).then((result) => {
      if (result) appendResult(thread, result);
    });
  };

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.textContent = useFake ? 'Reopen capture…' : 'Open camera…';
  trigger.style.cssText =
    'font:500 13px var(--ui);padding:8px 14px;border:1px solid var(--line);border-radius:9px;' +
    'background:var(--canvas);color:var(--ink);cursor:pointer;margin-top:6px;align-self:flex-start;';
  trigger.addEventListener('click', openOnce);
  thread.appendChild(trigger);

  shell.append(thread, composer);

  if (useFake) requestAnimationFrame(openOnce);
  return shell;
}

export const PhotoMode: Story = {
  args: { mode: 'photo', useFake: true, deviceCount: 2 },
  render: buildShell,
};

export const VideoMode: Story = {
  args: { mode: 'video', useFake: true, deviceCount: 2, micCount: 2 },
  render: buildShell,
};

export const SingleCamera: Story = {
  args: { mode: 'photo', useFake: true, deviceCount: 1, micCount: 1 },
  render: buildShell,
};

export const MultiCamera: Story = {
  args: { mode: 'video', useFake: true, deviceCount: 2, micCount: 2 },
  render: buildShell,
};

export const MultiMicrophone: Story = {
  args: { mode: 'video', useFake: true, deviceCount: 2, micCount: 2 },
  render: buildShell,
};

export const RealCamera: Story = {
  args: { mode: 'photo', useFake: false, deviceCount: 0 },
  render: buildShell,
};
