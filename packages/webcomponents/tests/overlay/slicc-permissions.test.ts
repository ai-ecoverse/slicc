import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PermissionDenyDetail,
  type PermissionGrant,
  type PermissionPromptResult,
  SliccPermissions,
} from '../../src/overlay/slicc-permissions.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(): SliccPermissions {
  const el = document.createElement('slicc-permissions') as SliccPermissions;
  document.body.appendChild(el);
  return el;
}

function makeStream(label: string): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 24;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#0a0';
  ctx.fillRect(0, 0, 32, 24);
  const stream = canvas.captureStream(1);
  // Tag for assertions.
  (stream as MediaStream & { __label?: string }).__label = label;
  return stream;
}

/**
 * A `DataTransferItem`-shaped stub. The browser blocks construction of real
 * DataTransfer items in scripted DragEvents, so we synthesize the items list
 * and the `getAsFileSystemHandle` seam by hand and dispatch via a CustomEvent
 * the component's drop handler can read.
 */
interface FakeItem {
  kind: string;
  type: string;
  getAsFileSystemHandle: () => Promise<FileSystemHandle | null>;
}

function fakeDir(name: string): FileSystemDirectoryHandle {
  const calls: { mode: string }[] = [];
  const handle = {
    kind: 'directory' as const,
    name,
    requestPermission: async (opts: { mode: string }): Promise<PermissionState> => {
      calls.push(opts);
      return (handle as unknown as { __next?: PermissionState }).__next ?? 'granted';
    },
    queryPermission: async (): Promise<PermissionState> => 'prompt',
    isSameEntry: async () => false,
    keys: async function* () {},
    values: async function* () {},
    entries: async function* () {},
    resolve: async () => null,
    getDirectoryHandle: async () => {
      throw new Error('not implemented');
    },
    getFileHandle: async () => {
      throw new Error('not implemented');
    },
    removeEntry: async () => {},
  };
  (handle as unknown as { __permissionCalls: { mode: string }[] }).__permissionCalls = calls;
  return handle as unknown as FileSystemDirectoryHandle;
}

/**
 * Dispatch a `drop` event carrying our fake items. We can't construct a real
 * `DataTransferItemList`, so we monkey-patch the event so the component's
 * `dataTransfer.items` lookup returns our list.
 */
function dispatchDrop(target: EventTarget, items: FakeItem[]): void {
  const event = new DragEvent('drop', { bubbles: true, cancelable: true });
  const dataTransfer = {
    types: ['Files'],
    items: items as unknown as DataTransferItemList,
    files: [] as unknown as FileList,
  };
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(event);
}

function dispatchDragEnter(target: EventTarget): void {
  const event = new DragEvent('dragenter', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'] } });
  target.dispatchEvent(event);
}

function dispatchDragLeave(target: EventTarget): void {
  const event = new DragEvent('dragleave', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'] } });
  target.dispatchEvent(event);
}

function nextGrant(el: SliccPermissions): Promise<PermissionGrant> {
  return new Promise((resolve) => {
    el.addEventListener(
      'slicc-permission-grant',
      (e) => resolve((e as CustomEvent<PermissionGrant>).detail),
      { once: true }
    );
  });
}

function nextDeny(el: SliccPermissions): Promise<PermissionDenyDetail> {
  return new Promise((resolve) => {
    el.addEventListener(
      'slicc-permission-deny',
      (e) => resolve((e as CustomEvent<PermissionDenyDetail>).detail),
      { once: true }
    );
  });
}

describe('slicc-permissions', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-permissions')).toBe(SliccPermissions);
  });

  it('routes camera through the injected media provider and emits grant', async () => {
    const el = mount();
    const stream = makeStream('cam');
    el.providers = {
      media: {
        getUserMedia: vi.fn(async () => stream),
        enumerateDevices: async () => [],
      },
    };
    const grantP = nextGrant(el);
    const result = await el.request('camera');
    expect(result).toEqual({ kind: 'camera', stream });
    await expect(grantP).resolves.toEqual({ kind: 'camera', stream });
  });

  it('routes microphone through the injected media provider', async () => {
    const el = mount();
    const stream = makeStream('mic');
    const getUserMedia = vi.fn(async () => stream);
    el.providers = {
      media: { getUserMedia, enumerateDevices: async () => [] },
    };
    const result = await el.request('microphone');
    expect(result).toEqual({ kind: 'microphone', stream });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it('routes USB through the injected provider', async () => {
    const el = mount();
    const device = { productName: 'fake-usb' };
    const requestDevice = vi.fn(async () => device);
    el.providers = { usb: { requestDevice } };
    const result = await el.request('usb', { filters: [{ vendorId: 0x1234 }] });
    expect(result).toEqual({ kind: 'usb', device });
    expect(requestDevice).toHaveBeenCalledWith({ filters: [{ vendorId: 0x1234 }] });
  });

  it('routes HID through the injected provider and wraps the array result', async () => {
    const el = mount();
    const device = { productName: 'fake-hid' };
    el.providers = { hid: { requestDevice: async () => [device] } };
    const result = await el.request('hid');
    expect(result).toEqual({ kind: 'hid', device, devices: [device] });
  });

  it('routes Web Serial through the injected provider', async () => {
    const el = mount();
    const port = { productId: 0xc1 };
    el.providers = { serial: { requestPort: async () => port } };
    const result = await el.request('serial');
    expect(result).toEqual({ kind: 'serial', port });
  });

  it('routes filesystem picker through the injected provider', async () => {
    const el = mount();
    const handle = fakeDir('repo');
    const showDirectoryPicker = vi.fn(async () => handle);
    el.providers = { filesystem: { showDirectoryPicker } };
    const result = await el.request('filesystem');
    expect(result).toEqual({
      kind: 'filesystem',
      handle,
      source: 'picker',
      permission: 'granted',
    });
    expect(showDirectoryPicker).toHaveBeenCalledWith({ mode: 'readwrite' });
  });

  it('emits deny + null when the user cancels a picker (AbortError)', async () => {
    const el = mount();
    el.providers = {
      usb: {
        requestDevice: async () => {
          const err = new Error('user cancelled');
          err.name = 'NotFoundError';
          throw err;
        },
      },
    };
    const denyP = nextDeny(el);
    const result = await el.request('usb');
    expect(result).toBeNull();
    await expect(denyP).resolves.toEqual({ kind: 'usb', reason: 'cancelled', message: undefined });
  });

  it('returns null with unavailable when the platform seam is missing', async () => {
    const el = mount();
    el.providers = { hid: null };
    // Force navigator.hid to be absent for this test.
    const original = (navigator as unknown as { hid?: unknown }).hid;
    Object.defineProperty(navigator, 'hid', { configurable: true, value: undefined });
    try {
      const denyP = nextDeny(el);
      const result = await el.request('hid');
      expect(result).toBeNull();
      await expect(denyP).resolves.toMatchObject({ kind: 'hid', reason: 'unavailable' });
    } finally {
      Object.defineProperty(navigator, 'hid', { configurable: true, value: original });
    }
  });

  it('toggles data-dropping on document-wide drag enter/leave for file drags', async () => {
    const el = mount();
    dispatchDragEnter(document);
    expect(el.hasAttribute('data-dropping')).toBe(true);
    dispatchDragLeave(document);
    expect(el.hasAttribute('data-dropping')).toBe(false);
  });

  it('folder drop yields a writable handle (Spike A flow)', async () => {
    const el = mount();
    const handle = fakeDir('dropped-repo');
    const items: FakeItem[] = [
      {
        kind: 'file',
        type: '',
        getAsFileSystemHandle: vi.fn(async () => handle),
      },
    ];
    const grantP = nextGrant(el);
    dispatchDrop(document, items);
    const grant = await grantP;
    expect(grant.kind).toBe('filesystem');
    if (grant.kind !== 'filesystem') throw new Error('unreachable');
    expect(grant.handle).toBe(handle);
    expect(grant.source).toBe('drop');
    expect(grant.permission).toBe('granted');
    // requestPermission was asked for read-write — the only mode that
    // satisfies the Wave 1 DoD.
    const calls = (handle as unknown as { __permissionCalls: { mode: string }[] })
      .__permissionCalls;
    expect(calls).toEqual([{ mode: 'readwrite' }]);
    // The picker stub MUST have been called BEFORE any await — the
    // component's drop handler kicks the synchronous call before
    // awaiting Promise.all, so the call count is 1 by the time
    // microtasks have flushed.
    expect(items[0].getAsFileSystemHandle).toHaveBeenCalledTimes(1);
  });

  it('folder drop with no directory entry emits deny', async () => {
    const el = mount();
    const denyP = nextDeny(el);
    dispatchDrop(document, [
      {
        kind: 'file',
        type: '',
        getAsFileSystemHandle: async () =>
          ({ kind: 'file', name: 'a.txt' }) as unknown as FileSystemHandle,
      },
    ]);
    await expect(denyP).resolves.toMatchObject({ kind: 'filesystem', reason: 'cancelled' });
  });

  it('folder drop where the user blocks permission emits deny', async () => {
    const el = mount();
    const handle = fakeDir('blocked');
    (handle as unknown as { __next?: PermissionState }).__next = 'denied';
    const denyP = nextDeny(el);
    dispatchDrop(document, [{ kind: 'file', type: '', getAsFileSystemHandle: async () => handle }]);
    await expect(denyP).resolves.toMatchObject({
      kind: 'filesystem',
      reason: 'cancelled',
      message: 'permission denied',
    });
  });

  it('routes screenshare through the injected provider and emits grant', async () => {
    const el = mount();
    const stream = makeStream('screen');
    const getDisplayMedia = vi.fn(async () => stream);
    el.providers = { screenshare: { getDisplayMedia } };
    const result = await el.request('screenshare');
    expect(result).toEqual({ kind: 'screenshare', stream });
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true });
  });

  it('screenshare emits deny when the user cancels (AbortError)', async () => {
    const el = mount();
    el.providers = {
      screenshare: {
        getDisplayMedia: async () => {
          const err = new Error('user cancelled');
          err.name = 'AbortError';
          throw err;
        },
      },
    };
    const denyP = nextDeny(el);
    const result = await el.request('screenshare');
    expect(result).toBeNull();
    await expect(denyP).resolves.toMatchObject({ kind: 'screenshare', reason: 'cancelled' });
  });

  describe('prompt() — multi-kind pre-prompt', () => {
    function getPanel(el: SliccPermissions): HTMLElement {
      const panel = el.querySelector('.slicc-permissions__prompt') as HTMLElement | null;
      if (!panel) throw new Error('prompt panel not rendered');
      return panel;
    }

    it('renders a top-floating dialog with heading, description, and one icon per kind', async () => {
      const el = mount();
      el.providers = {
        media: { getUserMedia: async () => makeStream('cam'), enumerateDevices: async () => [] },
      };
      const pending = el.prompt({
        kinds: ['camera', 'microphone'],
        heading: 'ffmpeg wants your camera + mic',
        description: 'Click below to grant; there will be a second confirmation.',
      });
      const panel = getPanel(el);
      expect(panel.getAttribute('role')).toBe('dialog');
      expect(panel.getAttribute('aria-modal')).toBe('true');
      const heading = panel.querySelector('.slicc-permissions__prompt-heading');
      expect(heading?.textContent).toBe('ffmpeg wants your camera + mic');
      const desc = panel.querySelector('.slicc-permissions__prompt-desc');
      expect(desc?.textContent).toBe('Click below to grant; there will be a second confirmation.');
      const icons = panel.querySelectorAll('.slicc-permissions__prompt-icon svg');
      expect(icons.length).toBe(2);
      // Cancel so the prompt closes cleanly before the test exits.
      (panel.querySelector('[part="prompt-cancel"]') as HTMLButtonElement).click();
      await pending;
    });

    it('Allow runs each requested kind in order and resolves with all grants', async () => {
      const el = mount();
      const camStream = makeStream('cam');
      const screenStream = makeStream('screen');
      el.providers = {
        media: { getUserMedia: async () => camStream, enumerateDevices: async () => [] },
        screenshare: { getDisplayMedia: async () => screenStream },
      };
      const pending = el.prompt({
        kinds: ['camera', 'screenshare'],
        description: 'Allow both?',
      });
      const panel = getPanel(el);
      (panel.querySelector('[part="prompt-grant"]') as HTMLButtonElement).click();
      const result = (await pending) as PermissionPromptResult;
      expect(result.status).toBe('granted');
      expect(result.grants).toEqual([
        { kind: 'camera', stream: camStream },
        { kind: 'screenshare', stream: screenStream },
      ]);
      // Panel was removed from the DOM after close.
      expect(el.querySelector('.slicc-permissions__prompt')).toBeNull();
    });

    it('Cancel emits one deny per requested kind and resolves with cancelled', async () => {
      const el = mount();
      el.providers = {
        media: { getUserMedia: async () => makeStream('cam'), enumerateDevices: async () => [] },
      };
      const denies: PermissionDenyDetail[] = [];
      el.addEventListener('slicc-permission-deny', (e) => {
        denies.push((e as CustomEvent<PermissionDenyDetail>).detail);
      });
      const pending = el.prompt({
        kinds: ['camera', 'microphone'],
        description: 'Both?',
      });
      const panel = getPanel(el);
      (panel.querySelector('[part="prompt-cancel"]') as HTMLButtonElement).click();
      const result = (await pending) as PermissionPromptResult;
      expect(result.status).toBe('cancelled');
      expect(result.reason).toBe('cancelled');
      expect(result.grants).toEqual([]);
      expect(denies.map((d) => ({ kind: d.kind, reason: d.reason }))).toEqual([
        { kind: 'camera', reason: 'cancelled' },
        { kind: 'microphone', reason: 'cancelled' },
      ]);
    });

    it('Escape closes the prompt and emits cancelled denies', async () => {
      const el = mount();
      const denies: PermissionDenyDetail[] = [];
      el.addEventListener('slicc-permission-deny', (e) => {
        denies.push((e as CustomEvent<PermissionDenyDetail>).detail);
      });
      const pending = el.prompt({
        kinds: ['screenshare'],
        description: 'Share your screen?',
      });
      // Wait for the rAF-driven open transition so focus has landed on the
      // grant button before we synthesize Escape.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const panel = getPanel(el);
      panel.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
      const result = (await pending) as PermissionPromptResult;
      expect(result.status).toBe('cancelled');
      expect(denies).toEqual([{ kind: 'screenshare', reason: 'cancelled', message: undefined }]);
    });

    it('opening a second prompt cancels the first', async () => {
      const el = mount();
      const first = el.prompt({ kinds: ['camera'], description: 'First' });
      const second = el.prompt({ kinds: ['microphone'], description: 'Second' });
      const firstResult = (await first) as PermissionPromptResult;
      expect(firstResult.status).toBe('cancelled');
      // Cancel the second so the test exits cleanly.
      const panel = el.querySelector('.slicc-permissions__prompt') as HTMLElement;
      (panel.querySelector('[part="prompt-cancel"]') as HTMLButtonElement).click();
      const secondResult = (await second) as PermissionPromptResult;
      expect(secondResult.status).toBe('cancelled');
    });

    it('returns granted with no grants for an empty kinds array', async () => {
      const el = mount();
      const result = await el.prompt({ kinds: [], description: '' });
      expect(result).toEqual({ status: 'granted', grants: [] });
      expect(el.querySelector('.slicc-permissions__prompt')).toBeNull();
    });
  });
});
