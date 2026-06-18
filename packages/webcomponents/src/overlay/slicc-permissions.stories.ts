import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type {
  PermissionDenyDetail,
  PermissionGrant,
  PermissionKind,
  PermissionProviders,
} from './slicc-permissions.js';
import './slicc-permissions.js';

const meta: Meta = {
  title: 'Overlay/Permissions',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

/**
 * Synthetic providers so the demo runs without granting real permissions.
 * Each picker resolves with a shape the host UI can render. Folder-drop is
 * the one flow that DOES use the real platform — drop a folder onto the
 * page and the surface fires `slicc-permission-grant`.
 */
function fakeProviders(): PermissionProviders {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#3b63fb';
  ctx.fillRect(0, 0, 320, 240);
  const stream = canvas.captureStream(5);
  return {
    media: {
      getUserMedia: async () => stream,
      enumerateDevices: async () => [],
    },
    usb: { requestDevice: async () => ({ productName: 'Demo USB device' }) },
    hid: { requestDevice: async () => [{ productName: 'Demo HID keypad' }] },
    serial: { requestPort: async () => ({ productId: 0xc0de }) },
    filesystem: {
      showDirectoryPicker: async () => {
        // Real picker — the user actually gets the OS folder browser.
        return (
          window as unknown as {
            showDirectoryPicker: (opts: { mode: string }) => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker({ mode: 'readwrite' });
      },
    },
  };
}

const PICKER_KINDS: PermissionKind[] = [
  'camera',
  'microphone',
  'usb',
  'hid',
  'serial',
  'filesystem',
];

function storyHost(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'min-height:100vh;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:16px;background:var(--bg);color:var(--ink);font:13px var(--ui);';
  const surface = document.createElement('slicc-permissions');
  surface.providers = fakeProviders();
  wrap.appendChild(surface);

  const title = document.createElement('div');
  title.textContent = 'Unified permission surface — drop a folder, or click a picker:';
  title.style.cssText = 'font-weight:600;';
  wrap.appendChild(title);

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;';
  for (const kind of PICKER_KINDS) {
    const btn = document.createElement('button');
    btn.textContent = kind;
    btn.style.cssText =
      'font:500 12px var(--ui,sans-serif);padding:8px 14px;border:1px solid var(--line,#ddd);' +
      'border-radius:9px;background:var(--canvas,#fff);color:var(--ink,#131313);cursor:pointer;';
    btn.addEventListener('click', () => {
      void surface.request(kind);
    });
    buttons.appendChild(btn);
  }
  wrap.appendChild(buttons);

  const log = document.createElement('pre');
  log.style.cssText =
    'min-height:80px;width:min(560px,90vw);padding:12px;border-radius:10px;' +
    'background:var(--ghost,#f5f5f5);border:1px solid var(--line,#ddd);font:12px ui-monospace,monospace;' +
    'white-space:pre-wrap;color:var(--txt-2,#505050);';
  wrap.appendChild(log);

  const append = (line: string) => {
    log.textContent = `${line}\n${log.textContent ?? ''}`.slice(0, 4000);
  };
  surface.addEventListener('slicc-permission-grant', (e) => {
    const detail = (e as CustomEvent<PermissionGrant>).detail;
    append(`grant: ${JSON.stringify({ kind: detail.kind, ...summarize(detail) })}`);
  });
  surface.addEventListener('slicc-permission-deny', (e) => {
    const detail = (e as CustomEvent<PermissionDenyDetail>).detail;
    append(`deny: ${JSON.stringify(detail)}`);
  });
  return wrap;
}

function summarize(detail: PermissionGrant): Record<string, unknown> {
  if (detail.kind === 'filesystem') {
    return { source: detail.source, name: detail.handle?.name, permission: detail.permission };
  }
  if (detail.kind === 'camera' || detail.kind === 'microphone') {
    return { tracks: detail.stream.getTracks().length };
  }
  return { device: String((detail as { device?: { productName?: string } }).device?.productName) };
}

export const Playground: Story = {
  render: () => storyHost(),
};
