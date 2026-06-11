import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { CameraMediaProvider } from './slicc-camera-dialog.js';
import './slicc-camera-dialog.js';

const meta: Meta = {
  title: 'Overlay/CameraDialog',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

/**
 * A synthetic "camera": an animated canvas stream, so the full dialog flow
 * (preview, picker, mirror, snap) demos without camera permission. Each fake
 * device renders its own hue, making picker switches visibly obvious.
 */
function makeFakeProvider(): CameraMediaProvider {
  const devices = [
    { deviceId: 'demo-front', label: 'Demo front camera', facing: 'user', hue: 28 },
    { deviceId: 'demo-rear', label: 'Demo rear camera', facing: 'environment', hue: 200 },
  ];
  return {
    getUserMedia: async (constraints) => {
      const video = constraints.video;
      const exact =
        typeof video === 'object' && video !== null && 'deviceId' in video
          ? (video.deviceId as { exact: string }).exact
          : devices[0].deviceId;
      const device = devices.find((d) => d.deviceId === exact) ?? devices[0];
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      let t = 0;
      const tick = setInterval(() => {
        t += 1;
        ctx.fillStyle = `hsl(${device.hue}, 70%, ${55 + 10 * Math.sin(t / 10)}%)`;
        ctx.fillRect(0, 0, 640, 480);
        ctx.fillStyle = '#fff';
        ctx.font = '28px sans-serif';
        ctx.fillText(device.label, 24, 240);
      }, 80);
      const stream = canvas.captureStream(15);
      const track = stream.getVideoTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => {
        clearInterval(tick);
        stop();
      };
      track.getSettings = () =>
        ({ deviceId: device.deviceId, facingMode: device.facing }) as MediaTrackSettings;
      return stream;
    },
    enumerateDevices: async () =>
      devices.map(
        (d) => ({ kind: 'videoinput', deviceId: d.deviceId, label: d.label }) as MediaDeviceInfo
      ),
  };
}

function storyHost(provider: CameraMediaProvider | null): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'min-height:100vh;display:grid;place-items:center;background:var(--bg);';
  const dialog = document.createElement('slicc-camera-dialog');
  if (provider) dialog.media = provider;
  const result = document.createElement('img');
  result.style.cssText =
    'max-width:240px;border-radius:10px;border:1px solid var(--line);display:none;';
  const button = document.createElement('button');
  button.textContent = 'Take a photo…';
  button.style.cssText =
    'font:500 13px var(--ui,sans-serif);padding:8px 14px;border:1px solid var(--line,#ddd);' +
    'border-radius:9px;background:var(--canvas,#fff);color:var(--ink,#131313);cursor:pointer;';
  button.addEventListener('click', () => {
    void dialog.open().then((dataUrl) => {
      if (dataUrl) {
        result.src = dataUrl;
        result.style.display = 'block';
      }
    });
  });
  const column = document.createElement('div');
  column.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:14px;';
  column.append(button, result, dialog);
  wrap.append(column);
  return wrap;
}

/** Two synthetic cameras (animated canvas streams) — no permission needed. */
export const SimulatedCameras: Story = {
  render: () => storyHost(makeFakeProvider()),
};

/** The real `navigator.mediaDevices` — Storybook will ask for camera access. */
export const RealCamera: Story = {
  render: () => storyHost(null),
};
