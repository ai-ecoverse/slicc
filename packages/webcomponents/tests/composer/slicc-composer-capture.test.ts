import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CameraMediaProvider,
  type CaptureResult,
  type RecorderFactory,
  SliccComposerCapture,
} from '../../src/composer/slicc-composer-capture.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

interface FakeDevice {
  deviceId: string;
  label: string;
  facing?: string;
}

interface FakeProvider extends CameraMediaProvider {
  calls: MediaStreamConstraints[];
  streams: MediaStream[];
}

/** An oscillator-backed audio track — `track.stop()` flips it to `'ended'`. */
function makeAudioTrack(): MediaStreamTrack {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const dst = ctx.createMediaStreamDestination();
  osc.connect(dst);
  osc.start();
  return dst.stream.getAudioTracks()[0];
}

/**
 * A drawable MediaStream with optional audio. Chromium gives the canvas a
 * genuine video track (so play / drawImage / toDataURL all work) and the audio
 * track is a real, stoppable MediaStreamTrack — exactly what the capture
 * surface tears down on exit.
 */
function makeStream(deviceId: string, facingMode: string | undefined, audio: boolean): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 48;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#c2410c';
  ctx.fillRect(0, 0, 64, 48);
  const stream = canvas.captureStream(10);
  const tick = setInterval(() => ctx.fillRect(0, 0, 64, 48), 50);
  const track = stream.getVideoTracks()[0];
  const stop = track.stop.bind(track);
  track.stop = () => {
    clearInterval(tick);
    stop();
  };
  track.getSettings = () => ({ deviceId, facingMode }) as MediaTrackSettings;
  if (audio) stream.addTrack(makeAudioTrack());
  return stream;
}

function makeAudioOnlyStream(): MediaStream {
  const stream = new MediaStream();
  stream.addTrack(makeAudioTrack());
  return stream;
}

interface FakeMic {
  deviceId: string;
  label: string;
}

/**
 * Audio-only stream tagged with `getSettings().deviceId` so the capture
 * surface's mic picker can reflect the active mic.
 */
function makeAudioStreamFor(deviceId: string): MediaStream {
  const stream = makeAudioOnlyStream();
  const track = stream.getAudioTracks()[0];
  track.getSettings = () => ({ deviceId }) as MediaTrackSettings;
  return stream;
}

function makeProvider(devices: FakeDevice[], mics: FakeMic[] = []): FakeProvider {
  const provider: FakeProvider = {
    calls: [],
    streams: [],
    getUserMedia: async (constraints) => {
      provider.calls.push(constraints);
      const v = constraints.video;
      const a = constraints.audio;
      const audioRequested = a !== undefined && a !== false;
      let stream: MediaStream;
      if (!v && audioRequested) {
        const exactMic =
          typeof a === 'object' && a !== null && 'deviceId' in a
            ? ((a as MediaTrackConstraints).deviceId as { exact: string }).exact
            : (mics[0]?.deviceId ?? 'mic-default');
        stream = makeAudioStreamFor(exactMic);
      } else {
        const exact =
          typeof v === 'object' && v !== null && 'deviceId' in v
            ? (v.deviceId as { exact: string }).exact
            : devices[0].deviceId;
        const device = devices.find((d) => d.deviceId === exact) ?? devices[0];
        stream = makeStream(device.deviceId, device.facing, audioRequested);
        if (audioRequested) {
          const audioTrack = stream.getAudioTracks()[0];
          const exactMic =
            typeof a === 'object' && a !== null && 'deviceId' in a
              ? ((a as MediaTrackConstraints).deviceId as { exact: string }).exact
              : (mics[0]?.deviceId ?? 'mic-default');
          if (audioTrack)
            audioTrack.getSettings = () => ({ deviceId: exactMic }) as MediaTrackSettings;
        }
      }
      provider.streams.push(stream);
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
  return provider;
}

/** A deterministic recorder seam — pushes a chunk on stop, then `onstop`. */
class FakeRecorder extends EventTarget {
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  stream: MediaStream;
  constructor(stream: MediaStream, opts?: MediaRecorderOptions) {
    super();
    this.stream = stream;
    this.mimeType = opts?.mimeType ?? 'video/webm';
  }
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }),
    } as BlobEvent);
    this.onstop?.();
  }
}

function makeRecorderFactory(): { factory: RecorderFactory; recorders: FakeRecorder[] } {
  const recorders: FakeRecorder[] = [];
  const factory: RecorderFactory = (stream, opts) => {
    const rec = new FakeRecorder(stream, opts);
    recorders.push(rec);
    return rec as unknown as MediaRecorder;
  };
  return { factory, recorders };
}

const TWO_CAMERAS: FakeDevice[] = [
  { deviceId: 'cam-front', label: 'FaceTime HD', facing: 'user' },
  { deviceId: 'cam-rear', label: 'Iris Rear', facing: 'environment' },
];

const TWO_MICS: FakeMic[] = [
  { deviceId: 'mic-internal', label: 'MacBook Microphone' },
  { deviceId: 'mic-usb', label: 'USB Condenser' },
];

function mount(provider?: CameraMediaProvider): SliccComposerCapture {
  const el = document.createElement('slicc-composer-capture') as SliccComposerCapture;
  if (provider) el.media = provider;
  document.body.appendChild(el);
  return el;
}

function videoOf(el: SliccComposerCapture): HTMLVideoElement {
  return el.querySelector('[part="video"]') as HTMLVideoElement;
}

function pickerOf(el: SliccComposerCapture): HTMLSelectElement {
  return el.querySelector('[part="picker"]') as HTMLSelectElement;
}

function micPickerOf(el: SliccComposerCapture): HTMLSelectElement {
  return el.querySelector('[part="audio-picker"]') as HTMLSelectElement;
}

function primaryOf(el: SliccComposerCapture): HTMLButtonElement {
  return el.querySelector('[part="snap"], [part="record"], [part="stop"]') as HTMLButtonElement;
}

describe('slicc-composer-capture', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-composer-capture')).toBe(SliccComposerCapture);
  });

  it('reflects `mode` attribute ↔ property (default photo)', () => {
    const el = mount();
    expect(el.mode).toBe('photo');
    el.mode = 'video';
    expect(el.getAttribute('mode')).toBe('video');
    el.setAttribute('mode', 'photo');
    expect(el.mode).toBe('photo');
    el.mode = null;
    expect(el.hasAttribute('mode')).toBe(false);
  });

  it('reflects `preferred-device` attribute ↔ property', () => {
    const el = mount();
    expect(el.preferredDevice).toBeNull();
    el.preferredDevice = 'cam-rear';
    expect(el.getAttribute('preferred-device')).toBe('cam-rear');
    el.setAttribute('preferred-device', 'cam-front');
    expect(el.preferredDevice).toBe('cam-front');
    el.preferredDevice = null;
    expect(el.hasAttribute('preferred-device')).toBe(false);
  });

  it('hides the camera picker for one camera and shows it for two', async () => {
    const elOne = mount(makeProvider([TWO_CAMERAS[0]]));
    const pendingOne = elOne.open('photo');
    await vi.waitFor(() => {
      expect(videoOf(elOne).srcObject).toBeTruthy();
    });
    expect(pickerOf(elOne).hidden).toBe(true);
    elOne.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await pendingOne;

    const elTwo = mount(makeProvider(TWO_CAMERAS));
    const pendingTwo = elTwo.open('photo');
    await vi.waitFor(() => {
      expect(videoOf(elTwo).srcObject).toBeTruthy();
    });
    const picker = pickerOf(elTwo);
    expect(picker.hidden).toBe(false);
    expect([...picker.options].map((o) => o.textContent)).toEqual(['FaceTime HD', 'Iris Rear']);
    elTwo.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await pendingTwo;
  });

  it('open("photo") + Snap resolves an image result, fires slicc-capture, ends every track', async () => {
    const provider = makeProvider(TWO_CAMERAS);
    const el = mount(provider);
    const captures: CaptureResult[] = [];
    el.addEventListener('slicc-capture', (e) =>
      captures.push((e as CustomEvent<CaptureResult>).detail)
    );

    const pending = el.open('photo');
    await vi.waitFor(() => {
      expect(videoOf(el).videoWidth).toBeGreaterThan(0);
    });
    // Photo mode requests video-only — no mic.
    expect(provider.calls[0]).toEqual({ video: true, audio: false });

    primaryOf(el).click();
    const result = (await pending) as CaptureResult;
    expect(result.kind).toBe('image');
    expect(result.mimeType).toBe('image/png');
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(captures).toEqual([result]);
    for (const track of provider.streams[0].getTracks()) {
      expect(track.readyState).toBe('ended');
    }
    expect(el.hidden).toBe(true);
  });

  it('switching cameras through the picker emits slicc-capture-device-change', async () => {
    const provider = makeProvider(TWO_CAMERAS);
    const el = mount(provider);
    el.preferredDevice = 'cam-rear';
    const changes: Array<{ deviceId: string; kind: string }> = [];
    el.addEventListener('slicc-capture-device-change', (e) =>
      changes.push((e as CustomEvent<{ deviceId: string; kind: string }>).detail)
    );

    const pending = el.open('photo');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    expect(provider.calls[0]).toEqual({
      video: { deviceId: { exact: 'cam-rear' } },
      audio: false,
    });
    // Environment-facing camera previews unmirrored.
    expect(videoOf(el).hasAttribute('data-mirrored')).toBe(false);

    const picker = pickerOf(el);
    picker.value = 'cam-front';
    picker.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(changes).toEqual([{ deviceId: 'cam-front', kind: 'camera' }]);
    });
    // Switching re-requests video-only (existing audio, if any, is preserved).
    expect(provider.calls.at(-1)).toEqual({ video: { deviceId: { exact: 'cam-front' } } });
    // The replaced video track stopped; selfie view is mirrored on the new one.
    expect(provider.streams[0].getVideoTracks()[0].readyState).toBe('ended');
    expect(videoOf(el).hasAttribute('data-mirrored')).toBe(true);

    el.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await pending;
  });

  it('open("video") requests audio+video, Record→Stop resolves a video result with duration', async () => {
    const provider = makeProvider(TWO_CAMERAS);
    const { factory, recorders } = makeRecorderFactory();
    const el = mount(provider);
    el.recorderFactory = factory;
    const captures: CaptureResult[] = [];
    el.addEventListener('slicc-capture', (e) =>
      captures.push((e as CustomEvent<CaptureResult>).detail)
    );

    const pending = el.open('video');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    // Video mode requests audio AND video so the recorded stream carries mic.
    expect(provider.calls[0]).toEqual({ video: true, audio: true });
    expect(provider.streams[0].getAudioTracks().length).toBe(1);

    // Record.
    primaryOf(el).click();
    await vi.waitFor(() => {
      expect(recorders.length).toBe(1);
      expect(recorders[0].state).toBe('recording');
      expect(el.querySelector('[part="stop"]')).toBeTruthy();
    });
    // Let the wall clock advance so durationMs > 0.
    await new Promise((r) => setTimeout(r, 25));

    // Stop.
    primaryOf(el).click();
    const result = (await pending) as CaptureResult;
    expect(result.kind).toBe('video');
    expect(result.mimeType).toMatch(/^video\/webm/);
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob?.size).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(captures).toEqual([result]);
    // Both video AND audio tracks ended on the way out.
    for (const track of provider.streams[0].getTracks()) {
      expect(track.readyState).toBe('ended');
    }
  });

  it('Cancel button resolves null and emits slicc-capture-cancel (no slicc-capture)', async () => {
    const provider = makeProvider(TWO_CAMERAS);
    const el = mount(provider);
    let captureSeen = 0;
    let cancelSeen = 0;
    el.addEventListener('slicc-capture', () => captureSeen++);
    el.addEventListener('slicc-capture-cancel', () => cancelSeen++);

    const pending = el.open('video');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    el.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await expect(pending).resolves.toBeNull();
    expect(cancelSeen).toBe(1);
    expect(captureSeen).toBe(0);
    for (const track of provider.streams[0].getTracks()) {
      expect(track.readyState).toBe('ended');
    }
  });

  it('Escape key resolves null and emits slicc-capture-cancel', async () => {
    const provider = makeProvider(TWO_CAMERAS);
    const el = mount(provider);
    let cancelSeen = 0;
    el.addEventListener('slicc-capture-cancel', () => cancelSeen++);

    const pending = el.open('video');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(pending).resolves.toBeNull();
    expect(cancelSeen).toBe(1);
    for (const track of provider.streams[0].getTracks()) {
      expect(track.readyState).toBe('ended');
    }
  });

  it('disconnectedCallback stops every video AND audio track and resolves null', async () => {
    const provider = makeProvider(TWO_CAMERAS);
    const el = mount(provider);
    const pending = el.open('video');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    expect(provider.streams[0].getAudioTracks().length).toBe(1);
    expect(provider.streams[0].getVideoTracks()[0].readyState).toBe('live');
    expect(provider.streams[0].getAudioTracks()[0].readyState).toBe('live');

    el.remove();
    await expect(pending).resolves.toBeNull();
    for (const track of provider.streams[0].getTracks()) {
      expect(track.readyState).toBe('ended');
    }
  });

  it('resolves null when no media provider is reachable', async () => {
    const el = mount();
    el.media = {
      getUserMedia: async () => {
        throw new Error('denied');
      },
      enumerateDevices: async () => [],
    };
    await expect(el.open('photo')).resolves.toBeNull();
  });

  it('reflects `preferred-audio-device` attribute ↔ property', () => {
    const el = mount();
    expect(el.preferredAudioDevice).toBeNull();
    el.preferredAudioDevice = 'mic-usb';
    expect(el.getAttribute('preferred-audio-device')).toBe('mic-usb');
    el.setAttribute('preferred-audio-device', 'mic-internal');
    expect(el.preferredAudioDevice).toBe('mic-internal');
    el.preferredAudioDevice = null;
    expect(el.hasAttribute('preferred-audio-device')).toBe(false);
  });

  it('hides the mic picker in photo mode even with multiple mics', async () => {
    const el = mount(makeProvider(TWO_CAMERAS, TWO_MICS));
    const pending = el.open('photo');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    // Picker exists in the DOM but is hidden — photo mode never records mic.
    expect(micPickerOf(el).hidden).toBe(true);
    el.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await pending;
  });

  it('hides the mic picker in video mode with only one mic', async () => {
    const el = mount(makeProvider(TWO_CAMERAS, [TWO_MICS[0]]));
    const pending = el.open('video');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    expect(micPickerOf(el).hidden).toBe(true);
    el.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await pending;
  });

  it('shows the mic picker in video mode with ≥2 mics, labeled and reflecting the active mic', async () => {
    const el = mount(makeProvider(TWO_CAMERAS, TWO_MICS));
    const pending = el.open('video');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    const picker = micPickerOf(el);
    expect(picker.hidden).toBe(false);
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      'MacBook Microphone',
      'USB Condenser',
    ]);
    // First mic is the default since no preferred-audio-device was set.
    expect(picker.value).toBe('mic-internal');
    el.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await pending;
  });

  it('opens with `preferred-audio-device` pinned to the requested mic', async () => {
    const provider = makeProvider(TWO_CAMERAS, TWO_MICS);
    const el = mount(provider);
    el.preferredAudioDevice = 'mic-usb';

    const pending = el.open('video');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    expect(provider.calls[0]).toEqual({
      video: true,
      audio: { deviceId: { exact: 'mic-usb' } },
    });
    expect(micPickerOf(el).value).toBe('mic-usb');
    el.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await pending;
  });

  it('switching mics swaps the live audio track, persists the choice, and emits microphone change', async () => {
    const provider = makeProvider(TWO_CAMERAS, TWO_MICS);
    const el = mount(provider);
    const changes: Array<{ deviceId: string; kind: string }> = [];
    el.addEventListener('slicc-capture-device-change', (e) =>
      changes.push((e as CustomEvent<{ deviceId: string; kind: string }>).detail)
    );

    const pending = el.open('video');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    const stream = provider.streams[0];
    const originalAudio = stream.getAudioTracks()[0];
    expect(originalAudio.readyState).toBe('live');

    const picker = micPickerOf(el);
    picker.value = 'mic-usb';
    picker.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(changes).toEqual([{ deviceId: 'mic-usb', kind: 'microphone' }]);
    });
    // Old track stopped, new track installed on the same live stream.
    expect(originalAudio.readyState).toBe('ended');
    const audioTracks = stream.getAudioTracks();
    expect(audioTracks.length).toBe(1);
    expect(audioTracks[0].getSettings?.().deviceId).toBe('mic-usb');
    // Preference persists for later opens / promotions.
    expect(el.preferredAudioDevice).toBe('mic-usb');
    // The audio-only swap call pinned the requested mic.
    expect(provider.calls.at(-1)).toEqual({ audio: { deviceId: { exact: 'mic-usb' } } });

    el.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await pending;
  });

  it('disables the mic picker while recording and re-enables it on stop', async () => {
    const provider = makeProvider(TWO_CAMERAS, TWO_MICS);
    const { factory, recorders } = makeRecorderFactory();
    const el = mount(provider);
    el.recorderFactory = factory;

    const pending = el.open('video');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    const picker = micPickerOf(el);
    expect(picker.disabled).toBe(false);

    // Record.
    primaryOf(el).click();
    await vi.waitFor(() => {
      expect(recorders.length).toBe(1);
      expect(recorders[0].state).toBe('recording');
    });
    expect(picker.disabled).toBe(true);

    // Stop.
    primaryOf(el).click();
    await pending;
    // After assembly, the picker is unlocked again — even though the element
    // is hidden, the disabled state has been cleared for the next session.
    expect(picker.disabled).toBe(false);
  });

  it('switching mics replaces the live audio track instance on the stream', async () => {
    const provider = makeProvider(TWO_CAMERAS, TWO_MICS);
    const el = mount(provider);

    const pending = el.open('video');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    const stream = provider.streams[0];
    const originalAudio = stream.getAudioTracks()[0];
    expect(originalAudio.getSettings?.().deviceId).toBe('mic-internal');

    const picker = micPickerOf(el);
    picker.value = 'mic-usb';
    picker.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(stream.getAudioTracks()[0].getSettings?.().deviceId).toBe('mic-usb');
    });
    const swapped = stream.getAudioTracks()[0];
    // Track identity changed (different MediaStreamTrack instance) AND the
    // old track's deviceId is no longer the one on the live stream.
    expect(swapped).not.toBe(originalAudio);
    expect(swapped.getSettings?.().deviceId).not.toBe(originalAudio.getSettings?.().deviceId);

    el.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await pending;
  });

  it('mic selection survives a camera switch in video mode', async () => {
    const provider = makeProvider(TWO_CAMERAS, TWO_MICS);
    const el = mount(provider);

    const pending = el.open('video');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    // Pick the second mic before switching cameras.
    const micPicker = micPickerOf(el);
    micPicker.value = 'mic-usb';
    micPicker.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(el.preferredAudioDevice).toBe('mic-usb');
    });
    const stream = provider.streams[0];
    const liveAudio = stream.getAudioTracks()[0];
    expect(liveAudio.getSettings?.().deviceId).toBe('mic-usb');

    // Switch camera — the existing audio track (mic-usb) is preserved verbatim
    // on the new live stream rather than re-requested. The video element's
    // `srcObject` is swapped to the new stream returned by `getUserMedia`.
    const camPicker = pickerOf(el);
    camPicker.value = 'cam-rear';
    camPicker.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      // The camera switch was video-only — no fresh audio request.
      const last = provider.calls.at(-1);
      expect(last).toEqual({ video: { deviceId: { exact: 'cam-rear' } } });
    });
    // Mic picker value + preference still pinned to mic-usb after the switch.
    expect(micPicker.value).toBe('mic-usb');
    expect(el.preferredAudioDevice).toBe('mic-usb');
    // The mic-usb audio track instance is now part of the new live stream;
    // it was added (not re-requested), so it's still the same track object.
    const liveStream = videoOf(el).srcObject as MediaStream;
    const audioAfter = liveStream.getAudioTracks()[0];
    expect(audioAfter).toBe(liveAudio);
    expect(audioAfter.getSettings?.().deviceId).toBe('mic-usb');
    expect(audioAfter.readyState).toBe('live');

    el.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await pending;
  });

  it('photo→video promotion honors `preferred-audio-device` and reveals the mic picker', async () => {
    const provider = makeProvider(TWO_CAMERAS, TWO_MICS);
    const el = mount(provider);
    el.preferredAudioDevice = 'mic-usb';

    const pending = el.open('photo');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    // Photo mode does not enumerate mic options yet — the picker is hidden.
    expect(micPickerOf(el).hidden).toBe(true);
    // Photo open() did not ask for audio.
    expect(provider.calls[0]).toEqual({ video: true, audio: false });

    // Click the Video mode button to promote.
    const videoBtn = el.querySelectorAll<HTMLElement>('[part="mode"]')[1];
    videoBtn?.click();
    await vi.waitFor(() => {
      // Promotion re-requests video+audio with the preferred mic pinned.
      const last = provider.calls.at(-1);
      expect(last).toEqual({
        video: { deviceId: { exact: 'cam-front' } },
        audio: { deviceId: { exact: 'mic-usb' } },
      });
    });
    await vi.waitFor(() => {
      const picker = micPickerOf(el);
      expect(picker.hidden).toBe(false);
      expect(picker.value).toBe('mic-usb');
    });

    el.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await pending;
  });

  it('keeps the bottom control bar inside the host rect (no vertical clipping)', async () => {
    // Constrain the host width to a typical composer band so the <video>'s
    // intrinsic 4:3 size would otherwise push the bar below the host.
    const frame = document.createElement('div');
    frame.style.width = '640px';
    document.body.appendChild(frame);
    const el = document.createElement('slicc-composer-capture') as SliccComposerCapture;
    el.media = makeProvider(TWO_CAMERAS, TWO_MICS);
    frame.appendChild(el);

    const pending = el.open('video');
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });

    const hostRect = el.getBoundingClientRect();
    const bar = el.querySelector('.slicc-capture__bar') as HTMLElement;
    const close = el.querySelector('[part="cancel"]') as HTMLElement;
    const barRect = bar.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    // 0.5px slack for sub-pixel rounding in real Chromium layout.
    expect(barRect.bottom).toBeLessThanOrEqual(hostRect.bottom + 0.5);
    expect(barRect.top).toBeGreaterThanOrEqual(hostRect.top - 0.5);
    expect(closeRect.top).toBeGreaterThanOrEqual(hostRect.top - 0.5);
    expect(closeRect.bottom).toBeLessThanOrEqual(hostRect.bottom + 0.5);

    el.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await pending;
  });
});
