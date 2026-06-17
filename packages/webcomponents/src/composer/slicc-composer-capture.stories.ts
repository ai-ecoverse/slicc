import type { Meta, StoryObj } from '@storybook/web-components-vite';
// Compose the capture surface inside a real <slicc-composer> by tag — importing
// the sibling module registers the composer element so the markup below upgrades
// on mount. The capture element itself is light-DOM and fills its layout slot,
// so dropping it into the composer's 680px inner band reproduces the same "fill
// the composer area" pattern the drag-and-drop drop target uses.
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

/** Canvas dimensions for the fake video feed (4:3, matches the composer band). */
const FAKE_W = 640;
const FAKE_H = 480;

/** Hue + label pair for each fake device, keyed by deviceId. */
const FAKE_DEVICES = [
  { deviceId: 'demo-front', label: 'Demo front camera', facing: 'user', hue: 28 },
  { deviceId: 'demo-rear', label: 'Demo rear camera', facing: 'environment', hue: 200 },
] as const;

/** Fake mic options, keyed by deviceId. */
const FAKE_MICS = [
  { deviceId: 'demo-mic-internal', label: 'Demo built-in microphone' },
  { deviceId: 'demo-mic-usb', label: 'Demo USB condenser' },
] as const;

/** Pull `video.deviceId.exact` out of a MediaStreamConstraints.video union. */
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

/**
 * Make a video track by painting an animated, hued canvas at 15fps and capturing
 * it as a MediaStream. The deviceId + facingMode are stamped onto `getSettings()`
 * so the capture surface mirrors selfie cameras and the picker can drive
 * `switchCamera()` against the correct exact-id constraint.
 */
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

/**
 * Make a synthetic audio track: a 220Hz oscillator at near-zero gain piped into
 * a `MediaStreamDestination`, so MediaRecorder produces a multi-track WebM with
 * a real audio track but no actual microphone access. The track's `stop()` is
 * patched to also stop the oscillator so the AudioContext doesn't keep ticking.
 * The requested mic `deviceId` is stamped onto `getSettings()` so the capture
 * surface's mic picker reflects the active mic.
 */
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
    } catch {
      // already stopped — ignore.
    }
    origStop();
  };
  track.getSettings = () => ({ deviceId }) as MediaTrackSettings;
  return track;
}

/** Pull `audio.deviceId.exact` out of a MediaStreamConstraints.audio union. */
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

/**
 * A canvas-backed `CameraMediaProvider`: each fake "device" paints its own hued
 * animated canvas captured at 15fps, and `audio: true` (or a deviceId-pinned
 * constraint) adds a synthetic oscillator track so video recordings carry an
 * audio track without any real microphone permission prompt. Defaults to TWO
 * cameras + ONE mic so the camera picker is visible — pass `1` cameras or
 * `2`+ mics to exercise the other picker-visibility paths.
 */
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

/** Append a result preview (image thumbnail or playable video) to the thread. */
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

/**
 * Build the story shell: a chat-column layout (thread above, composer band
 * below) with the capture surface mounted INSIDE the composer's inner band so
 * it fills the band the way the drag-and-drop drop target does. The fake
 * provider stories auto-open on mount; the real-camera story shows an explicit
 * Open button so the permission prompt is gated by a user gesture.
 */
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
  // Hide until opened so the composer band reads as the chat footer at rest —
  // then the auto-open / button-trigger flips it into the live capture state.
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

  // Auto-open the fake-provider stories so reviewers see the live surface
  // inside the composer band immediately. rAF defers until connectedCallback
  // has injected the scoped stylesheet and the live preview can attach.
  if (useFake) requestAnimationFrame(openOnce);
  return shell;
}

/**
 * Photo mode against the fake provider — Snap returns a PNG data URL and the
 * surface closes back to the composer. The thumbnail appears in the thread
 * above so the round-trip result is visible without leaving the story.
 */
export const PhotoMode: Story = {
  args: { mode: 'photo', useFake: true, deviceCount: 2 },
  render: buildShell,
};

/**
 * Video mode against the fake provider — Record→Stop runs a real
 * MediaRecorder over the canvas stream (plus a synthetic audio track), so the
 * returned `Blob` carries both video and audio without any microphone
 * permission. The resulting WebM plays in the result block. Two fake mics so
 * the mic `<select>` is visible alongside the camera picker — switching it
 * swaps the recorded audio track on the fly.
 */
export const VideoMode: Story = {
  args: { mode: 'video', useFake: true, deviceCount: 2, micCount: 2 },
  render: buildShell,
};

/**
 * Single fake camera — the device picker is hidden because there is only one
 * `videoinput`. Mirrors the prototype's "no picker on single-camera laptops"
 * behavior.
 */
export const SingleCamera: Story = {
  args: { mode: 'photo', useFake: true, deviceCount: 1, micCount: 1 },
  render: buildShell,
};

/**
 * Two fake cameras + two fake mics — both pickers are wired into the fake
 * provider. The story opens in video mode so the mic `<select>` is visible
 * alongside the camera picker; switching cameras preserves the mic choice,
 * and switching mics swaps the live audio track without tearing down video.
 */
export const MultiCamera: Story = {
  args: { mode: 'video', useFake: true, deviceCount: 2, micCount: 2 },
  render: buildShell,
};

/**
 * Two fake mics in video mode — the mic picker is visible alongside the camera
 * picker. Switching the `<select>` swaps the live audio track on the same
 * stream and persists the choice in `preferred-audio-device` so camera
 * switches and photo→video promotions reuse it.
 */
export const MultiMicrophone: Story = {
  args: { mode: 'video', useFake: true, deviceCount: 2, micCount: 2 },
  render: buildShell,
};

/**
 * Real `navigator.mediaDevices` — the provider seam is `null`, so the
 * component falls back to the real browser stack. Storybook will prompt for
 * camera (and microphone, in video mode) permission when Open is pressed.
 */
export const RealCamera: Story = {
  args: { mode: 'photo', useFake: false, deviceCount: 0 },
  render: buildShell,
};
