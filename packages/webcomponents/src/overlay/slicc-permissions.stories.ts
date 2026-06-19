import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { PermissionDenyDetail, PermissionGrant, PermissionKind } from './slicc-permissions.js';
import './slicc-permissions.js';

/**
 * All seven permission kinds the surface routes. The story uses every one;
 * the radio control picks which one drives the floating pre-prompt dialog.
 */
const ALL_KINDS: PermissionKind[] = [
  'camera',
  'microphone',
  'screenshare',
  'usb',
  'hid',
  'serial',
  'filesystem',
];

interface PlaygroundArgs {
  kind: PermissionKind;
  heading: string;
  description: string;
  grantLabel: string;
  cancelLabel: string;
}

const meta: Meta<PlaygroundArgs> = {
  title: 'Overlay/Permissions',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  argTypes: {
    kind: {
      control: 'radio',
      options: ALL_KINDS,
      description: 'Permission kind passed to the floating pre-prompt dialog.',
    },
    heading: {
      control: 'text',
      description: 'Heading for the pre-prompt dialog; blank uses the built-in default.',
    },
    description: {
      control: 'text',
      description: 'Body copy for the pre-prompt dialog.',
    },
    grantLabel: { control: 'text' },
    cancelLabel: { control: 'text' },
  },
  args: {
    kind: 'camera',
    heading: '',
    description: 'Sliccy needs access to ask for the selected device or folder.',
    grantLabel: 'Allow',
    cancelLabel: 'Cancel',
  },
};
export default meta;
type Story = StoryObj<PlaygroundArgs>;

/**
 * Diagnostic summary for a single grant. Real-device pickers expose useful
 * shape — labels, IDs, settings — so the log helps verify the picker
 * actually wired up to the platform and didn't silently fall back. For the
 * filesystem flow this is filled in asynchronously after iterating the
 * directory (see {@link describeFilesystemHandle}).
 */
async function summarizeGrant(detail: PermissionGrant): Promise<Record<string, unknown>> {
  if (detail.kind === 'filesystem') {
    return {
      source: detail.source,
      permission: detail.permission,
      ...(await describeFilesystemHandle(detail.handle)),
    };
  }
  if (detail.kind === 'camera' || detail.kind === 'microphone' || detail.kind === 'screenshare') {
    const tracks = detail.stream.getTracks().map((t) => ({
      kind: t.kind,
      label: t.label,
      settings: safeTrackSettings(t),
    }));
    return { id: detail.stream.id, tracks };
  }
  if (detail.kind === 'usb') return { device: describeUsb(detail.device) };
  if (detail.kind === 'hid') {
    return {
      devices: detail.devices.map(describeHid),
    };
  }
  if (detail.kind === 'serial') return { port: describeSerial(detail.port) };
  return {};
}

function safeTrackSettings(track: MediaStreamTrack): MediaTrackSettings | string {
  try {
    return track.getSettings();
  } catch (err) {
    return `<settings unavailable: ${(err as Error).message}>`;
  }
}

interface UsbLike {
  productName?: string;
  manufacturerName?: string;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
}
function describeUsb(device: unknown): Record<string, unknown> {
  const d = device as UsbLike;
  return {
    productName: d?.productName,
    manufacturerName: d?.manufacturerName,
    vendorId: d?.vendorId,
    productId: d?.productId,
    serialNumber: d?.serialNumber,
  };
}

interface HidLike {
  productName?: string;
  vendorId?: number;
  productId?: number;
}
function describeHid(device: unknown): Record<string, unknown> {
  const d = device as HidLike;
  return { productName: d?.productName, vendorId: d?.vendorId, productId: d?.productId };
}

interface SerialLike {
  getInfo?: () => { usbVendorId?: number; usbProductId?: number };
}
function describeSerial(port: unknown): Record<string, unknown> {
  const p = port as SerialLike;
  try {
    return p?.getInfo?.() ?? {};
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Walk a granted directory and count entries by kind. This is the
 * file-count diagnostic the task asks for — it proves the FS grant
 * actually carries a working handle we can iterate. Caps the walk so a
 * huge home directory doesn't freeze the story.
 */
async function describeFilesystemHandle(
  handle: FileSystemDirectoryHandle
): Promise<Record<string, unknown>> {
  let files = 0;
  let dirs = 0;
  let entries = 0;
  const MAX = 5000;
  try {
    const it = (
      handle as FileSystemDirectoryHandle & {
        entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries();
    for await (const [, entry] of it) {
      entries++;
      if (entry.kind === 'file') files++;
      else dirs++;
      if (entries >= MAX) break;
    }
    return {
      name: handle.name,
      entries,
      files,
      dirs,
      truncated: entries >= MAX,
    };
  } catch (err) {
    return { name: handle.name, error: (err as Error).message };
  }
}

/**
 * Classify a `drop` event's items synchronously into file-vs-directory
 * buckets via `webkitGetAsEntry()` — sync, available in every Chromium and
 * Firefox build, and crucially doesn't consume the same user activation
 * the component needs for its `requestPermission()` call.
 */
function classifyDrop(event: DragEvent): {
  files: { name: string; type: string; size: number }[];
  dirs: string[];
} {
  const items = event.dataTransfer?.items;
  const files: { name: string; type: string; size: number }[] = [];
  const dirs: string[] = [];
  if (!items) return { files, dirs };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry?.isDirectory) {
      dirs.push(entry.name ?? '<unnamed>');
    } else {
      const f = item.getAsFile();
      if (f) files.push({ name: f.name, type: f.type, size: f.size });
    }
  }
  return { files, dirs };
}

function storyHost(args: PlaygroundArgs): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'min-height:100vh;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:flex-start;padding:48px 16px;gap:16px;background:var(--bg);' +
    'color:var(--ink);font:13px var(--ui,system-ui,sans-serif);';

  // No injected providers — the component falls back to the real platform:
  // navigator.mediaDevices.getUserMedia / getDisplayMedia, navigator.usb /
  // .hid / .serial, and window.showDirectoryPicker. This is the whole point
  // of this story: drive every picker through the real Chrome dialog.
  const surface = document.createElement('slicc-permissions');
  wrap.appendChild(surface);

  const title = document.createElement('div');
  title.textContent =
    'Unified permission surface — click a picker, drag a folder (mount) or a file (upload):';
  title.style.cssText = 'font-weight:600;text-align:center;max-width:560px;';
  wrap.appendChild(title);

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;';
  for (const kind of ALL_KINDS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = kind;
    btn.style.cssText =
      'font:500 12px var(--ui,sans-serif);padding:8px 14px;border:1px solid var(--line,#ddd);' +
      'border-radius:9px;background:var(--canvas,#fff);color:var(--ink,#131313);cursor:pointer;';
    btn.addEventListener('click', () => {
      void surface.request(kind);
    });
    buttons.appendChild(btn);
  }
  const promptBtn = document.createElement('button');
  promptBtn.type = 'button';
  promptBtn.textContent = 'Trigger dialog';
  promptBtn.style.cssText =
    'font:600 12px var(--ui,sans-serif);padding:8px 14px;border:1px solid var(--ctx,#3b63fb);' +
    'border-radius:9px;background:var(--ctx,#3b63fb);color:#fff;cursor:pointer;';
  promptBtn.addEventListener('click', () => {
    const kind = args.kind;
    if (!ALL_KINDS.includes(kind)) {
      append(`prompt: unknown kind "${kind}" — use the "kind" control`);
      return;
    }
    void surface
      .prompt({
        kinds: [kind],
        heading: args.heading || undefined,
        description: args.description,
        grantLabel: args.grantLabel || undefined,
        cancelLabel: args.cancelLabel || undefined,
      })
      .then((result) => {
        append(`prompt: ${JSON.stringify({ status: result.status, reason: result.reason })}`);
      });
  });
  buttons.appendChild(promptBtn);
  wrap.appendChild(buttons);

  const log = document.createElement('pre');
  log.style.cssText =
    'min-height:120px;width:min(640px,92vw);padding:12px;border-radius:10px;' +
    'background:var(--ghost,#f5f5f5);border:1px solid var(--line,#ddd);font:12px ui-monospace,monospace;' +
    'white-space:pre-wrap;color:var(--txt-2,#505050);max-height:50vh;overflow:auto;';
  log.textContent = '// diagnostics appear here\n';
  wrap.appendChild(log);

  function append(line: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    log.textContent = `[${ts}] ${line}\n${log.textContent ?? ''}`.slice(0, 8000);
  }

  surface.addEventListener('slicc-permission-grant', (e) => {
    const detail = (e as CustomEvent<PermissionGrant>).detail;
    append(`grant: ${detail.kind} (gathering diagnostics…)`);
    void summarizeGrant(detail).then((summary) => {
      append(`grant.detail: ${JSON.stringify({ kind: detail.kind, ...summary })}`);
    });
  });
  surface.addEventListener('slicc-permission-deny', (e) => {
    const detail = (e as CustomEvent<PermissionDenyDetail>).detail;
    append(`deny: ${JSON.stringify(detail)}`);
  });

  // File-vs-folder drop classifier. Runs in CAPTURE so it sees the same
  // event the component sees on bubble. We never preventDefault here —
  // the component handles that — and we never touch getAsFileSystemHandle
  // (that's the component's job for folders). For files this fires an
  // upload-gesture log so the host can demonstrate the drag-as-upload
  // contract without competing with the folder-mount path.
  const onDocDrop = (event: DragEvent): void => {
    const types = event.dataTransfer?.types;
    if (!types || !Array.from(types).includes('Files')) return;
    const { files, dirs } = classifyDrop(event);
    if (files.length) {
      append(`upload-gesture: ${JSON.stringify({ count: files.length, files })}`);
    }
    if (dirs.length) {
      append(`folder-drop: ${JSON.stringify({ dirs })}`);
    }
  };
  surface.ownerDocument.addEventListener('drop', onDocDrop, true);
  // Storybook re-renders the story by replacing the root; the element's
  // disconnectedCallback isn't a reliable teardown hook for our document
  // listener, so we mirror it on the wrap's removal via a MutationObserver
  // on the parent. Cheap and self-contained.
  queueMicrotask(() => {
    const parent = wrap.parentNode;
    if (!parent) return;
    const mo = new MutationObserver(() => {
      if (!wrap.isConnected) {
        surface.ownerDocument.removeEventListener('drop', onDocDrop, true);
        mo.disconnect();
      }
    });
    mo.observe(parent, { childList: true });
  });

  return wrap;
}

/**
 * The single playground story — the component has one job (open native
 * pickers) so the matrix collapses to a single render driven by Storybook
 * controls. Light/dark is covered by the toolbar theme decorator.
 */
export const Playground: Story = {
  args: {
    kind: 'microphone',
  },

  render: (args) => storyHost(args),
};
