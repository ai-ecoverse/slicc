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

  it('routes popup through the injected provider and emits grant with the window', async () => {
    const el = mount();
    const fakeWindow = { name: 'popup-window' } as unknown as Window;
    const open = vi.fn(() => fakeWindow);
    el.providers = { popup: { open } };
    const grantP = nextGrant(el);
    const result = await el.request('popup', { url: 'https://github.com/login/oauth/authorize' });
    expect(result).toEqual({ kind: 'popup', window: fakeWindow });
    expect(open).toHaveBeenCalledWith(
      'https://github.com/login/oauth/authorize',
      'width=500,height=700,popup=yes'
    );
    await expect(grantP).resolves.toEqual({ kind: 'popup', window: fakeWindow });
  });

  it('popup honors a custom features string', async () => {
    const el = mount();
    const open = vi.fn(() => ({}) as Window);
    el.providers = { popup: { open } };
    await el.request('popup', { url: 'https://x.com', features: 'width=900,height=900' });
    expect(open).toHaveBeenCalledWith('https://x.com', 'width=900,height=900');
  });

  it('popup denies (error) when no url is supplied', async () => {
    const el = mount();
    const open = vi.fn(() => ({}) as Window);
    el.providers = { popup: { open } };
    const denyP = nextDeny(el);
    const result = await el.request('popup');
    expect(result).toBeNull();
    expect(open).not.toHaveBeenCalled();
    await expect(denyP).resolves.toMatchObject({
      kind: 'popup',
      reason: 'error',
      message: 'popup request missing url',
    });
  });

  it('popup denies (error) when window.open returns null (popup blocked)', async () => {
    const el = mount();
    el.providers = { popup: { open: () => null } };
    const denyP = nextDeny(el);
    const result = await el.request('popup', { url: 'https://x.com' });
    expect(result).toBeNull();
    await expect(denyP).resolves.toMatchObject({
      kind: 'popup',
      reason: 'error',
    });
  });

  it('prompt() with popup kind opens the window inside the Allow click', async () => {
    const el = mount();
    const fakeWindow = { name: 'gh-popup' } as unknown as Window;
    const open = vi.fn(() => fakeWindow);
    el.providers = { popup: { open } };
    const resultP = el.prompt({
      kinds: ['popup'],
      description: 'Continue to sign in.',
      requestOptions: { popup: { url: 'https://github.com/login/oauth/authorize' } },
    });
    // The prompt panel is appended on the next animation frame. Wait then
    // click the grant button — open() must be called from inside this click.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const grantBtn = el.querySelector('[part="prompt-grant"]') as HTMLButtonElement;
    expect(grantBtn).not.toBeNull();
    grantBtn.click();
    const result = await resultP;
    expect(result.status).toBe('granted');
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]).toEqual({ kind: 'popup', window: fakeWindow });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('prompt() with popup kind: Cancel deny does not open the window', async () => {
    const el = mount();
    const open = vi.fn(() => ({}) as Window);
    el.providers = { popup: { open } };
    const resultP = el.prompt({
      kinds: ['popup'],
      description: 'Continue to sign in.',
      requestOptions: { popup: { url: 'https://x.com' } },
    });
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const cancelBtn = el.querySelector('[part="prompt-cancel"]') as HTMLButtonElement;
    expect(cancelBtn).not.toBeNull();
    cancelBtn.click();
    const result = await resultP;
    expect(result.status).toBe('cancelled');
    expect(open).not.toHaveBeenCalled();
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

    // Auto-generated heading exercises both labelForKind + iconNameForKind
    // (one icon per kind) for every supported kind — covering the device
    // kinds (usb/hid/serial/filesystem) that the test matrix above doesn't
    // reach via prompt().
    it.each([
      ['camera', /camera/],
      ['microphone', /microphone/],
      ['screenshare', /screen/],
      ['usb', /USB device/],
      ['hid', /HID device/],
      ['serial', /serial port/],
      ['filesystem', /folder/],
    ] as const)('auto-generates heading + one icon for kind=%s when no explicit heading is set', async (kind, expectedHeading) => {
      const el = mount();
      // Suppress the platform default fallback so navigator.* doesn't fire
      // during this UI-only assertion. The Cancel click below resolves the
      // promise without actually invoking the kind's picker.
      el.providers = {
        media: null,
        screenshare: null,
        usb: null,
        hid: null,
        serial: null,
        filesystem: null,
      };
      const pending = el.prompt({ kinds: [kind], description: 'test' });
      const panel = el.querySelector('.slicc-permissions__prompt') as HTMLElement;
      const heading = panel.querySelector('.slicc-permissions__prompt-heading');
      expect(heading?.textContent).toMatch(expectedHeading);
      const icons = panel.querySelectorAll('.slicc-permissions__prompt-icon svg');
      expect(icons.length).toBe(1);
      // Close cleanly so the test exits without an orphan panel.
      (panel.querySelector('[part="prompt-cancel"]') as HTMLButtonElement).click();
      await pending;
    });

    it('joins multi-kind labels with commas + "and" in the auto-heading', async () => {
      const el = mount();
      el.providers = { media: null, screenshare: null };
      const pending = el.prompt({
        kinds: ['camera', 'microphone', 'screenshare'],
        description: 'three kinds',
      });
      const panel = el.querySelector('.slicc-permissions__prompt') as HTMLElement;
      const heading = panel.querySelector('.slicc-permissions__prompt-heading');
      expect(heading?.textContent).toBe('Allow access to your camera, microphone and screen?');
      (panel.querySelector('[part="prompt-cancel"]') as HTMLButtonElement).click();
      await pending;
    });

    it('Tab in the prompt traps focus between cancel + grant buttons', async () => {
      const el = mount();
      const pending = el.prompt({ kinds: ['camera'], description: 'focus trap' });
      // Wait for rAF — focus has just been moved to grantBtn.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const panel = el.querySelector('.slicc-permissions__prompt') as HTMLElement;
      const cancelBtn = panel.querySelector('[part="prompt-cancel"]') as HTMLButtonElement;
      const grantBtn = panel.querySelector('[part="prompt-grant"]') as HTMLButtonElement;
      // Forward Tab from grantBtn cycles to cancelBtn.
      grantBtn.focus();
      panel.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      );
      expect(document.activeElement).toBe(cancelBtn);
      // Shift+Tab from cancelBtn cycles back to grantBtn.
      panel.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
      expect(document.activeElement).toBe(grantBtn);
      // Tab when focus is somewhere else (neither button) snaps to the first
      // focusable. `blur()` on both buttons makes `document.activeElement`
      // fall back to <body>, which isn't in the focusable list.
      grantBtn.blur();
      cancelBtn.blur();
      // Sanity-check the blur: must be off both buttons for idx===-1.
      expect(document.activeElement).not.toBe(cancelBtn);
      expect(document.activeElement).not.toBe(grantBtn);
      panel.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      );
      expect(document.activeElement).toBe(cancelBtn);
      cancelBtn.click();
      await pending;
    });

    it('opening + closing + reopening the prompt re-builds (covers second connect)', async () => {
      const el = mount();
      const first = el.prompt({ kinds: ['camera'], description: 'first' });
      el.remove();
      // Disconnect cancels the in-flight prompt.
      const firstResult = (await first) as PermissionPromptResult;
      expect(firstResult.status).toBe('cancelled');
      // Reconnect re-runs connectedCallback / #build, which returns early
      // because #built stayed true (covers line ~669's early return).
      document.body.appendChild(el);
      const second = el.prompt({ kinds: ['microphone'], description: 'second' });
      const panel = el.querySelector('.slicc-permissions__prompt') as HTMLElement;
      (panel.querySelector('[part="prompt-cancel"]') as HTMLButtonElement).click();
      const secondResult = (await second) as PermissionPromptResult;
      expect(secondResult.status).toBe('cancelled');
    });

    it('a second Allow click after the first is settled is a silent no-op', async () => {
      const el = mount();
      const getUserMedia = vi.fn(async () => makeStream('cam'));
      el.providers = {
        media: { getUserMedia, enumerateDevices: async () => [] },
      };
      const pending = el.prompt({ kinds: ['camera'], description: 'double-click' });
      const panel = el.querySelector('.slicc-permissions__prompt') as HTMLElement;
      const grantBtn = panel.querySelector('[part="prompt-grant"]') as HTMLButtonElement;
      grantBtn.click();
      // The second click while settled=true should early-return without
      // re-invoking the picker. The button is also disabled in the same
      // tick, but the early-return is what guards against the gap.
      grantBtn.click();
      const result = (await pending) as PermissionPromptResult;
      expect(result.status).toBe('granted');
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    it('Allow cascades a synthesized deny for kinds queued after a mid-flow failure', async () => {
      const el = mount();
      const camStream = makeStream('cam');
      // camera succeeds; usb is denied (provider returns null device);
      // serial must NEVER fire because the loop short-circuits after usb's
      // failure, but its deny MUST still be synthesized so callers see one
      // event per requested kind.
      const serialRequestPort = vi.fn(async () => ({ id: 'should-not-fire' }));
      el.providers = {
        media: { getUserMedia: async () => camStream, enumerateDevices: async () => [] },
        usb: {
          requestDevice: async () => {
            const err = new Error('user cancelled');
            err.name = 'NotFoundError';
            throw err;
          },
        },
        serial: { requestPort: serialRequestPort },
      };
      const denies: PermissionDenyDetail[] = [];
      el.addEventListener('slicc-permission-deny', (e) => {
        denies.push((e as CustomEvent<PermissionDenyDetail>).detail);
      });
      const pending = el.prompt({
        kinds: ['camera', 'usb', 'serial'],
        heading: 'mid-flow failure',
        description: 'cascade',
      });
      const panel = el.querySelector('.slicc-permissions__prompt') as HTMLElement;
      (panel.querySelector('[part="prompt-grant"]') as HTMLButtonElement).click();
      const result = (await pending) as PermissionPromptResult;
      expect(result.status).toBe('cancelled');
      expect(result.reason).toBe('cancelled');
      // camera succeeded; serial picker never actually fired.
      expect(result.grants).toEqual([{ kind: 'camera', stream: camStream }]);
      expect(serialRequestPort).not.toHaveBeenCalled();
      // Two denies total: usb's real cancel + serial's synthesized cancel.
      expect(denies.map((d) => ({ kind: d.kind, reason: d.reason }))).toEqual([
        { kind: 'usb', reason: 'cancelled' },
        { kind: 'serial', reason: 'cancelled' },
      ]);
    });
  });

  describe('drop-zone edge cases', () => {
    function dispatchDragOver(target: EventTarget, types: string[] = ['Files']): DragEvent {
      const event = new DragEvent('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types } });
      target.dispatchEvent(event);
      return event;
    }

    it('dragover with files calls preventDefault (becomes a drop target)', () => {
      mount();
      const event = dispatchDragOver(document, ['Files']);
      expect(event.defaultPrevented).toBe(true);
    });

    it('non-file drag enter/over/leave/drop are all no-ops', () => {
      const el = mount();
      // Plain text drag — never toggles data-dropping, never preventDefaults.
      const enter = new DragEvent('dragenter', { bubbles: true, cancelable: true });
      Object.defineProperty(enter, 'dataTransfer', { value: { types: ['text/plain'] } });
      document.dispatchEvent(enter);
      expect(el.hasAttribute('data-dropping')).toBe(false);
      const over = dispatchDragOver(document, ['text/plain']);
      expect(over.defaultPrevented).toBe(false);
      const leave = new DragEvent('dragleave', { bubbles: true, cancelable: true });
      Object.defineProperty(leave, 'dataTransfer', { value: { types: ['text/plain'] } });
      document.dispatchEvent(leave);
      const drop = new DragEvent('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', { value: { types: ['text/plain'], items: [] } });
      document.dispatchEvent(drop);
      expect(drop.defaultPrevented).toBe(false);
    });

    it('drop with empty items list is a silent no-op (no grant, no deny)', async () => {
      const el = mount();
      const grants: PermissionGrant[] = [];
      const denies: PermissionDenyDetail[] = [];
      el.addEventListener('slicc-permission-grant', (e) =>
        grants.push((e as CustomEvent<PermissionGrant>).detail)
      );
      el.addEventListener('slicc-permission-deny', (e) =>
        denies.push((e as CustomEvent<PermissionDenyDetail>).detail)
      );
      dispatchDrop(document, []);
      // Wait a tick for any async drop handling to settle (there shouldn't be any).
      await new Promise((r) => setTimeout(r, 0));
      expect(grants).toEqual([]);
      expect(denies).toEqual([]);
    });

    it('drop with only non-file items (no getAsFileSystemHandle) is a no-op', async () => {
      const el = mount();
      const grants: PermissionGrant[] = [];
      const denies: PermissionDenyDetail[] = [];
      el.addEventListener('slicc-permission-grant', (e) =>
        grants.push((e as CustomEvent<PermissionGrant>).detail)
      );
      el.addEventListener('slicc-permission-deny', (e) =>
        denies.push((e as CustomEvent<PermissionDenyDetail>).detail)
      );
      dispatchDrop(document, [
        { kind: 'string', type: 'text/plain', getAsFileSystemHandle: undefined as never },
      ] as never);
      await new Promise((r) => setTimeout(r, 0));
      expect(grants).toEqual([]);
      expect(denies).toEqual([]);
    });

    it('drop where getAsFileSystemHandle rejects surfaces an error deny', async () => {
      const el = mount();
      const denyP = nextDeny(el);
      dispatchDrop(document, [
        {
          kind: 'file',
          type: '',
          getAsFileSystemHandle: async () => {
            throw new Error('handle boom');
          },
        },
      ]);
      const deny = await denyP;
      expect(deny.kind).toBe('filesystem');
      expect(deny.reason).toBe('error');
      expect(deny.message).toMatch(/handle boom/);
    });

    it('drop where requestPermission rejects surfaces an error deny', async () => {
      const el = mount();
      const handle = fakeDir('boom');
      (handle as unknown as { requestPermission: () => Promise<never> }).requestPermission =
        async () => {
          throw new Error('perm boom');
        };
      const denyP = nextDeny(el);
      dispatchDrop(document, [
        { kind: 'file', type: '', getAsFileSystemHandle: async () => handle },
      ]);
      const deny = await denyP;
      expect(deny.kind).toBe('filesystem');
      expect(deny.reason).toBe('error');
      expect(deny.message).toMatch(/perm boom/);
    });

    it('drop with a handle that has no requestPermission falls through to granted', async () => {
      const el = mount();
      const bare = {
        kind: 'directory' as const,
        name: 'bare-dir',
        // No requestPermission — the component treats this as a test fake and
        // synthesizes `granted`.
      } as unknown as FileSystemDirectoryHandle;
      const grantP = nextGrant(el);
      dispatchDrop(document, [{ kind: 'file', type: '', getAsFileSystemHandle: async () => bare }]);
      const grant = await grantP;
      expect(grant.kind).toBe('filesystem');
      if (grant.kind !== 'filesystem') throw new Error('unreachable');
      expect(grant.handle).toBe(bare);
      expect(grant.source).toBe('drop');
    });

    it('disconnectedCallback cancels an active prompt and clears data-dropping', async () => {
      const el = mount();
      // Open a prompt so the element holds an `activePrompt`.
      const pending = el.prompt({ kinds: ['camera'], description: 'will be cancelled' });
      el.setAttribute('data-dropping', '');
      // Triggering disconnect runs the cleanup branch.
      el.remove();
      const result = (await pending) as PermissionPromptResult;
      expect(result.status).toBe('cancelled');
      expect(el.hasAttribute('data-dropping')).toBe(false);
    });
  });

  describe('non-AbortError deny paths surface as { reason: error, message }', () => {
    it.each([
      [
        'usb',
        () => ({
          usb: {
            requestDevice: async () => {
              throw new Error('USB boom');
            },
          },
        }),
      ],
      [
        'hid',
        () => ({
          hid: {
            requestDevice: async (): Promise<unknown[]> => {
              throw new Error('HID boom');
            },
          },
        }),
      ],
      [
        'serial',
        () => ({
          serial: {
            requestPort: async () => {
              throw new Error('Serial boom');
            },
          },
        }),
      ],
      [
        'filesystem',
        () => ({
          filesystem: {
            showDirectoryPicker: async (): Promise<FileSystemDirectoryHandle> => {
              throw new Error('FS boom');
            },
          },
        }),
      ],
      [
        'screenshare',
        () => ({
          screenshare: {
            getDisplayMedia: async () => {
              throw new Error('Screen boom');
            },
          },
        }),
      ],
    ] as const)('%s deny surfaces a non-cancellation error', async (kind, makeProviders) => {
      const el = mount();
      el.providers = makeProviders() as Parameters<typeof el.request>[0] extends never
        ? never
        : Parameters<typeof el.request>[0] & typeof el.providers;
      const denyP = nextDeny(el);
      const result = await el.request(kind as Parameters<typeof el.request>[0]);
      expect(result).toBeNull();
      const deny = await denyP;
      expect(deny.kind).toBe(kind);
      expect(deny.reason).toBe('error');
      expect(deny.message).toMatch(/boom/);
    });

    it('hid deny when requestDevice returns an empty array', async () => {
      const el = mount();
      el.providers = { hid: { requestDevice: async () => [] } };
      const denyP = nextDeny(el);
      const result = await el.request('hid');
      expect(result).toBeNull();
      const deny = await denyP;
      expect(deny.kind).toBe('hid');
      expect(deny.reason).toBe('cancelled');
    });

    it('serial deny when requestPort returns null (user cancelled the picker)', async () => {
      const el = mount();
      el.providers = { serial: { requestPort: async () => null } };
      const denyP = nextDeny(el);
      const result = await el.request('serial');
      expect(result).toBeNull();
      const deny = await denyP;
      expect(deny.kind).toBe('serial');
      expect(deny.reason).toBe('cancelled');
    });
  });

  describe('microphone-specific deny + camera AbortError paths', () => {
    it('microphone surfaces a non-cancellation getUserMedia error', async () => {
      const el = mount();
      el.providers = {
        media: {
          getUserMedia: async () => {
            throw new Error('Mic boom');
          },
          enumerateDevices: async () => [],
        },
      };
      const denyP = nextDeny(el);
      const result = await el.request('microphone');
      expect(result).toBeNull();
      const deny = await denyP;
      expect(deny.kind).toBe('microphone');
      expect(deny.reason).toBe('error');
      expect(deny.message).toMatch(/Mic boom/);
    });

    it('camera surfaces AbortError as a cancelled deny', async () => {
      const el = mount();
      el.providers = {
        media: {
          getUserMedia: async () => {
            const err = new Error('user cancelled');
            err.name = 'AbortError';
            throw err;
          },
          enumerateDevices: async () => [],
        },
      };
      const denyP = nextDeny(el);
      const result = await el.request('camera');
      expect(result).toBeNull();
      const deny = await denyP;
      expect(deny.kind).toBe('camera');
      expect(deny.reason).toBe('cancelled');
    });
  });

  describe('platform-default fallback paths', () => {
    it('usb falls back to navigator.usb when no provider is injected', async () => {
      const el = mount();
      const device = { productName: 'platform-usb' };
      const requestDevice = vi.fn(async () => device);
      const original = (navigator as unknown as { usb?: unknown }).usb;
      Object.defineProperty(navigator, 'usb', {
        configurable: true,
        value: { requestDevice },
      });
      try {
        const result = await el.request('usb', { filters: [{ vendorId: 0x42 }] });
        expect(result).toEqual({ kind: 'usb', device });
        expect(requestDevice).toHaveBeenCalledWith({ filters: [{ vendorId: 0x42 }] });
      } finally {
        Object.defineProperty(navigator, 'usb', { configurable: true, value: original });
      }
    });

    it('usb denies as unavailable when no provider and navigator.usb is missing', async () => {
      const el = mount();
      el.providers = { usb: null };
      const original = (navigator as unknown as { usb?: unknown }).usb;
      Object.defineProperty(navigator, 'usb', { configurable: true, value: undefined });
      try {
        const denyP = nextDeny(el);
        const result = await el.request('usb');
        expect(result).toBeNull();
        const deny = await denyP;
        expect(deny.kind).toBe('usb');
        expect(deny.reason).toBe('unavailable');
      } finally {
        Object.defineProperty(navigator, 'usb', { configurable: true, value: original });
      }
    });

    it('camera + microphone deny as unavailable when navigator.mediaDevices is gone', async () => {
      const el = mount();
      el.providers = { media: null };
      const original = (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: undefined,
      });
      try {
        const camDenyP = nextDeny(el);
        const camResult = await el.request('camera');
        expect(camResult).toBeNull();
        const camDeny = await camDenyP;
        expect(camDeny.kind).toBe('camera');
        expect(camDeny.reason).toBe('unavailable');
        const micDenyP = nextDeny(el);
        const micResult = await el.request('microphone');
        expect(micResult).toBeNull();
        const micDeny = await micDenyP;
        expect(micDeny.kind).toBe('microphone');
        expect(micDeny.reason).toBe('unavailable');
      } finally {
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: original,
        });
      }
    });

    it('screenshare denies as unavailable when navigator.mediaDevices is gone', async () => {
      const el = mount();
      el.providers = { screenshare: null };
      const original = (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: undefined,
      });
      try {
        const denyP = nextDeny(el);
        const result = await el.request('screenshare');
        expect(result).toBeNull();
        const deny = await denyP;
        expect(deny.kind).toBe('screenshare');
        expect(deny.reason).toBe('unavailable');
      } finally {
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: original,
        });
      }
    });

    it('filesystem denies as unavailable when no provider and showDirectoryPicker is missing', async () => {
      const el = mount();
      el.providers = { filesystem: null };
      const hadIt = 'showDirectoryPicker' in window;
      const original = (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).showDirectoryPicker;
      try {
        const denyP = nextDeny(el);
        const result = await el.request('filesystem');
        expect(result).toBeNull();
        const deny = await denyP;
        expect(deny.kind).toBe('filesystem');
        expect(deny.reason).toBe('unavailable');
      } finally {
        if (hadIt) {
          (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = original;
        }
      }
    });

    it('serial denies as unavailable when no provider and navigator.serial is missing', async () => {
      const el = mount();
      el.providers = { serial: null };
      const original = (navigator as unknown as { serial?: unknown }).serial;
      Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
      try {
        const denyP = nextDeny(el);
        const result = await el.request('serial');
        expect(result).toBeNull();
        const deny = await denyP;
        expect(deny.kind).toBe('serial');
        expect(deny.reason).toBe('unavailable');
      } finally {
        Object.defineProperty(navigator, 'serial', { configurable: true, value: original });
      }
    });

    it('screenshare falls back to navigator.mediaDevices.getDisplayMedia', async () => {
      const el = mount();
      const stream = makeStream('platform-screen');
      const original = (navigator.mediaDevices as unknown as { getDisplayMedia?: unknown })
        .getDisplayMedia;
      const getDisplayMedia = vi.fn(async () => stream);
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: getDisplayMedia,
      });
      try {
        const result = await el.request('screenshare');
        expect(result).toEqual({ kind: 'screenshare', stream });
        expect(getDisplayMedia).toHaveBeenCalled();
      } finally {
        if (original === undefined) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (navigator.mediaDevices as any).getDisplayMedia;
        } else {
          Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
            configurable: true,
            value: original,
          });
        }
      }
    });
  });

  describe('prompt() — popover top-layer stacking (Wave 13b)', () => {
    function getPanel(el: SliccPermissions): HTMLElement {
      const panel = el.querySelector('.slicc-permissions__prompt') as HTMLElement | null;
      if (!panel) throw new Error('prompt panel not rendered');
      return panel;
    }

    it('opens the prompt panel as a manual popover so it paints in the top layer', async () => {
      const el = mount();
      el.providers = { popup: { open: () => ({}) as Window } };
      const pending = el.prompt({
        kinds: ['popup'],
        description: 'Continue to sign in.',
        requestOptions: { popup: { url: 'https://x.com' } },
      });
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const panel = getPanel(el);
      // The Popover API attribute MUST be present so UAs that support
      // popover render in the browser top layer. `manual` keeps light-dismiss
      // off so a stray outside click can't cancel the OAuth gesture.
      expect(panel.getAttribute('popover')).toBe('manual');
      // When the engine supports popover, the panel matches :popover-open
      // after showPopover() runs. Older engines silently skip — the panel
      // is still in the DOM either way.
      const supportsPopover =
        typeof (panel as HTMLElement & { showPopover?: () => void }).showPopover === 'function';
      if (supportsPopover) {
        expect(panel.matches(':popover-open')).toBe(true);
      }
      // Resolve the pending prompt so the test cleans up.
      const cancelBtn = el.querySelector('[part="prompt-cancel"]') as HTMLButtonElement;
      cancelBtn.click();
      await pending;
    });

    it('removes the popover panel from the DOM after Allow/Cancel', async () => {
      const el = mount();
      el.providers = { popup: { open: () => ({}) as Window } };
      const pending = el.prompt({
        kinds: ['popup'],
        description: 'Continue to sign in.',
        requestOptions: { popup: { url: 'https://x.com' } },
      });
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const panel = getPanel(el);
      expect(panel.isConnected).toBe(true);
      const cancelBtn = el.querySelector('[part="prompt-cancel"]') as HTMLButtonElement;
      cancelBtn.click();
      await pending;
      expect(panel.isConnected).toBe(false);
    });
  });
});
