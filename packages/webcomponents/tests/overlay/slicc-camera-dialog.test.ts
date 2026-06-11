import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CameraMediaProvider,
  SliccCameraDialog,
} from '../../src/overlay/slicc-camera-dialog.js';
// Composed by tag — imported so the dialog shell upgrades.
import '../../src/overlay/slicc-dialog.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

/**
 * A real, drawable MediaStream from a canvas — Chromium gives it genuine
 * video tracks, so play / drawImage / toDataURL all work without a camera.
 */
function makeStream(deviceId: string, facingMode?: string): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 48;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#c2410c';
  ctx.fillRect(0, 0, 64, 48);
  const stream = canvas.captureStream(10);
  // Keep frames flowing so the <video> decodes something to snap.
  const tick = setInterval(() => ctx.fillRect(0, 0, 64, 48), 50);
  const track = stream.getVideoTracks()[0];
  const stop = track.stop.bind(track);
  track.stop = () => {
    clearInterval(tick);
    stop();
  };
  track.getSettings = () => ({ deviceId, facingMode }) as MediaTrackSettings;
  return stream;
}

interface FakeProvider extends CameraMediaProvider {
  calls: MediaStreamConstraints[];
  streams: MediaStream[];
}

function makeProvider(devices: Array<{ deviceId: string; label: string; facing?: string }>) {
  const provider: FakeProvider = {
    calls: [],
    streams: [],
    getUserMedia: async (constraints) => {
      provider.calls.push(constraints);
      const video = constraints.video;
      const exact =
        typeof video === 'object' && video !== null && 'deviceId' in video
          ? (video.deviceId as { exact: string }).exact
          : devices[0].deviceId;
      const device = devices.find((d) => d.deviceId === exact) ?? devices[0];
      const stream = makeStream(device.deviceId, device.facing);
      provider.streams.push(stream);
      return stream;
    },
    enumerateDevices: async () =>
      devices.map(
        (d) => ({ kind: 'videoinput', deviceId: d.deviceId, label: d.label }) as MediaDeviceInfo
      ),
  };
  return provider;
}

const TWO_CAMERAS = [
  { deviceId: 'cam-front', label: 'FaceTime HD', facing: 'user' },
  { deviceId: 'cam-rear', label: 'Iris Rear', facing: 'environment' },
];

function mount(provider: CameraMediaProvider): SliccCameraDialog {
  const el = document.createElement('slicc-camera-dialog') as SliccCameraDialog;
  el.media = provider;
  document.body.appendChild(el);
  return el;
}

function videoOf(el: SliccCameraDialog): HTMLVideoElement {
  return el.querySelector('.slicc-camera__video') as HTMLVideoElement;
}

function pickerOf(el: SliccCameraDialog): HTMLSelectElement {
  return el.querySelector('.slicc-camera__select') as HTMLSelectElement;
}

describe('slicc-camera-dialog', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-camera-dialog')).toBe(SliccCameraDialog);
  });

  it('open() shows the dialog with a live preview and a labelled camera picker', async () => {
    const provider = makeProvider(TWO_CAMERAS);
    const el = mount(provider);
    const pending = el.open();

    await vi.waitFor(() => {
      expect(el.querySelector('slicc-dialog')?.hasAttribute('open')).toBe(true);
    });
    const picker = pickerOf(el);
    expect(picker.hidden).toBe(false);
    expect([...picker.options].map((o) => o.textContent)).toEqual(['FaceTime HD', 'Iris Rear']);
    expect(videoOf(el).srcObject).toBe(provider.streams[0]);
    // The front camera previews mirrored (selfie view).
    expect(videoOf(el).hasAttribute('data-mirrored')).toBe(true);

    el.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await expect(pending).resolves.toBeNull();
  });

  it('hides the picker for a single camera', async () => {
    const el = mount(makeProvider([TWO_CAMERAS[0]]));
    const pending = el.open();
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    expect(pickerOf(el).hidden).toBe(true);
    el.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await pending;
  });

  it('opens the preferred device first and switches cameras through the picker', async () => {
    const provider = makeProvider(TWO_CAMERAS);
    const el = mount(provider);
    el.setAttribute('preferred-device', 'cam-rear');
    const changes: string[] = [];
    el.addEventListener('slicc-camera-device-change', (e) =>
      changes.push((e as CustomEvent<{ deviceId: string }>).detail.deviceId)
    );

    const pending = el.open();
    await vi.waitFor(() => {
      expect(videoOf(el).srcObject).toBeTruthy();
    });
    expect(provider.calls[0]).toEqual({ video: { deviceId: { exact: 'cam-rear' } } });
    // Rear (environment-facing) preview is NOT mirrored.
    expect(videoOf(el).hasAttribute('data-mirrored')).toBe(false);

    const picker = pickerOf(el);
    picker.value = 'cam-front';
    picker.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(changes).toEqual(['cam-front']);
    });
    expect(provider.calls.at(-1)).toEqual({ video: { deviceId: { exact: 'cam-front' } } });
    // The replaced stream's tracks were stopped.
    expect(provider.streams[0].getVideoTracks()[0].readyState).toBe('ended');
    expect(videoOf(el).hasAttribute('data-mirrored')).toBe(true);

    el.querySelector<HTMLElement>('[part="cancel"]')?.click();
    await pending;
  });

  it('snap resolves a PNG data URL, fires the capture event, and stops the stream', async () => {
    const provider = makeProvider(TWO_CAMERAS);
    const el = mount(provider);
    const captures: string[] = [];
    el.addEventListener('slicc-camera-capture', (e) =>
      captures.push((e as CustomEvent<{ dataUrl: string }>).detail.dataUrl)
    );

    const pending = el.open();
    // Wait for real decoded frames so the snap canvas has dimensions.
    await vi.waitFor(() => {
      expect(videoOf(el).videoWidth).toBeGreaterThan(0);
    });
    el.querySelector<HTMLElement>('[part="snap"]')?.click();

    const dataUrl = await pending;
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(captures).toEqual([dataUrl]);
    expect(provider.streams[0].getVideoTracks()[0].readyState).toBe('ended');
    expect(el.querySelector('slicc-dialog')?.hasAttribute('open')).toBe(false);
  });

  it('resolves null when no media provider is reachable', async () => {
    const el = document.createElement('slicc-camera-dialog') as SliccCameraDialog;
    document.body.appendChild(el);
    el.media = {
      getUserMedia: async () => {
        throw new Error('denied');
      },
      enumerateDevices: async () => [],
    };
    await expect(el.open()).resolves.toBeNull();
  });
});
