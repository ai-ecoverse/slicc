import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import type { CameraMediaProvider } from './slicc-camera-dialog.js';

/** Re-export so hosts can swap the media seam without depending on the camera dialog module. */
export type { CameraMediaProvider } from './slicc-camera-dialog.js';

/** The picker families the unified surface routes through one gesture. */
export type PermissionKind = 'camera' | 'microphone' | 'usb' | 'hid' | 'serial' | 'filesystem';

/** Injectable USB seam — defaults to `navigator.usb`. */
export interface UsbPermissionProvider {
  requestDevice(opts: { filters?: unknown[] }): Promise<unknown>;
}

/** Injectable HID seam — defaults to `navigator.hid`. */
export interface HidPermissionProvider {
  requestDevice(opts: { filters?: unknown[] }): Promise<unknown[] | unknown>;
}

/** Injectable Web Serial seam — defaults to `navigator.serial`. */
export interface SerialPermissionProvider {
  requestPort(opts?: { filters?: unknown[] }): Promise<unknown>;
}

/**
 * Injectable File System Access seam — defaults to `window.showDirectoryPicker`.
 * Hosts can swap this for popup-based pickers (extension side panel TCC workaround)
 * or for fakes in tests/stories.
 */
export interface FilesystemPermissionProvider {
  showDirectoryPicker(opts?: { mode?: string }): Promise<FileSystemDirectoryHandle>;
}

/** Bundle of injectable provider seams. Any field omitted falls back to the platform default. */
export interface PermissionProviders {
  media?: CameraMediaProvider | null;
  usb?: UsbPermissionProvider | null;
  hid?: HidPermissionProvider | null;
  serial?: SerialPermissionProvider | null;
  filesystem?: FilesystemPermissionProvider | null;
}

/** Optional per-request hints (device filters, media constraints). */
export interface PermissionRequestOptions {
  filters?: unknown[];
  constraints?: MediaStreamConstraints;
}

/**
 * The granted artifact, tagged by {@link PermissionKind}. Filesystem grants
 * carry both the handle and the gesture source (`picker` vs `drop`) so the
 * host can branch on which path landed without observing two separate events.
 */
export type PermissionGrant =
  | { kind: 'camera'; stream: MediaStream }
  | { kind: 'microphone'; stream: MediaStream }
  | { kind: 'usb'; device: unknown }
  | { kind: 'hid'; device: unknown; devices: unknown[] }
  | { kind: 'serial'; port: unknown }
  | {
      kind: 'filesystem';
      handle: FileSystemDirectoryHandle;
      source: 'picker' | 'drop';
      permission: 'granted' | 'prompt' | 'denied';
    };

/** The `slicc-permission-deny` event detail — what failed and why. */
export interface PermissionDenyDetail {
  kind: PermissionKind;
  reason: 'cancelled' | 'unavailable' | 'error';
  message?: string;
}

const STYLE = `
slicc-permissions {
  /* Invisible host by default — only the drop overlay paints, and only
     while a folder drag is in flight. Hosts can give the element a fixed
     viewport position (e.g. inset:0 z-index:50) to make the overlay
     cover the leader tab. */
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 80;
}
slicc-permissions[hidden] {
  display: none;
}
slicc-permissions .slicc-permissions__drop {
  position: absolute;
  inset: 24px;
  display: none;
  align-items: center;
  justify-content: center;
  border-radius: 18px;
  border: 2px dashed var(--ctx, var(--accent, #3b63fb));
  background: color-mix(in oklab, var(--ctx, var(--accent, #3b63fb)) 12%, transparent);
  color: var(--ctx, var(--accent, #3b63fb));
  font: 600 14px var(--ui, sans-serif);
  pointer-events: none;
  text-align: center;
  padding: 24px;
}
slicc-permissions[data-dropping] .slicc-permissions__drop {
  display: flex;
}
slicc-permissions .slicc-permissions__drop-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
slicc-permissions .slicc-permissions__drop-inner svg {
  width: 32px;
  height: 32px;
}
`;

const STYLE_ID = 'slicc-permissions-style';

function ensurePermissionsStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * Detect whether a `DragEvent` carries OS files/folders (vs. an in-page drag
 * of text / HTML / a chip). Mirrors `slicc-add-menu`'s `#isFileDrag`.
 */
function isFileDrag(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true;
  }
  return false;
}

type DataTransferItemWithHandle = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
};

/**
 * `<slicc-permissions>` — the leader tab's single gesture-gated permission
 * surface. Each {@link PermissionKind} runs the matching platform picker via
 * an injectable provider seam, so tests and stories can drive the full flow
 * without hardware. The host's drop zone captures a folder via
 * `DataTransferItem.getAsFileSystemHandle` synchronously (Spike A's
 * same-tick rule) and runs `requestPermission({mode:'readwrite'})` in the
 * same activation, yielding a writable mount handle without a second click.
 *
 * Light DOM (no shadow root): composes `<slicc-dialog>` BY TAG so the host
 * page styles inherit, and injects one scoped stylesheet into the document.
 *
 * @fires slicc-permission-grant - composed + bubbling; `detail` is a {@link PermissionGrant}
 * @fires slicc-permission-deny - composed + bubbling; `detail` is a {@link PermissionDenyDetail}
 */
export class SliccPermissions extends HTMLElement {
  /** Injectable provider seams. Unset fields fall back to platform defaults. */
  providers: PermissionProviders = {};

  #dropOverlay!: HTMLElement;
  #built = false;
  #docDragDepth = 0;

  connectedCallback(): void {
    ensurePermissionsStyle(this.ownerDocument);
    this.#build();
    const doc = this.ownerDocument;
    doc.addEventListener('dragenter', this.#onDocDragEnter);
    doc.addEventListener('dragover', this.#onDocDragOver);
    doc.addEventListener('dragleave', this.#onDocDragLeave);
    doc.addEventListener('drop', this.#onDocDrop);
  }

  disconnectedCallback(): void {
    const doc = this.ownerDocument;
    doc.removeEventListener('dragenter', this.#onDocDragEnter);
    doc.removeEventListener('dragover', this.#onDocDragOver);
    doc.removeEventListener('dragleave', this.#onDocDragLeave);
    doc.removeEventListener('drop', this.#onDocDrop);
    this.#docDragDepth = 0;
    this.removeAttribute('data-dropping');
  }

  /**
   * Run the gesture-gated picker for `kind`. Resolves with the granted
   * artifact, or `null` when the user cancels / the API is unavailable.
   * Errors and cancellations are also surfaced as `slicc-permission-deny`
   * events so hosts can listen passively.
   */
  async request(
    kind: PermissionKind,
    opts?: PermissionRequestOptions
  ): Promise<PermissionGrant | null> {
    switch (kind) {
      case 'camera':
        return this.#requestCamera(opts);
      case 'microphone':
        return this.#requestMicrophone(opts);
      case 'usb':
        return this.#requestUsb(opts);
      case 'hid':
        return this.#requestHid(opts);
      case 'serial':
        return this.#requestSerial(opts);
      case 'filesystem':
        return this.#requestFilesystem();
      default:
        // Exhaustiveness — should be unreachable.
        return null;
    }
  }

  #mediaProvider(): CameraMediaProvider | null {
    return (
      this.providers.media ??
      (typeof navigator !== 'undefined' ? navigator.mediaDevices : null) ??
      null
    );
  }

  async #requestCamera(opts?: PermissionRequestOptions): Promise<PermissionGrant | null> {
    const media = this.#mediaProvider();
    if (!media) return this.#deny('camera', 'unavailable', 'mediaDevices unavailable');
    try {
      const stream = await media.getUserMedia(opts?.constraints ?? { video: true });
      return this.#grant({ kind: 'camera', stream });
    } catch (err) {
      return this.#denyError('camera', err);
    }
  }

  async #requestMicrophone(opts?: PermissionRequestOptions): Promise<PermissionGrant | null> {
    const media = this.#mediaProvider();
    if (!media) return this.#deny('microphone', 'unavailable', 'mediaDevices unavailable');
    try {
      const stream = await media.getUserMedia(opts?.constraints ?? { audio: true });
      return this.#grant({ kind: 'microphone', stream });
    } catch (err) {
      return this.#denyError('microphone', err);
    }
  }

  async #requestUsb(opts?: PermissionRequestOptions): Promise<PermissionGrant | null> {
    const usb =
      this.providers.usb ??
      (globalThis as { navigator?: { usb?: UsbPermissionProvider } }).navigator?.usb ??
      null;
    if (!usb?.requestDevice) {
      return this.#deny('usb', 'unavailable', 'WebUSB unavailable');
    }
    try {
      const device = await usb.requestDevice({ filters: opts?.filters ?? [] });
      if (!device) return this.#deny('usb', 'cancelled');
      return this.#grant({ kind: 'usb', device });
    } catch (err) {
      return this.#denyError('usb', err);
    }
  }

  async #requestHid(opts?: PermissionRequestOptions): Promise<PermissionGrant | null> {
    const hid =
      this.providers.hid ??
      (globalThis as { navigator?: { hid?: HidPermissionProvider } }).navigator?.hid ??
      null;
    if (!hid?.requestDevice) {
      return this.#deny('hid', 'unavailable', 'WebHID unavailable');
    }
    try {
      const result = await hid.requestDevice({ filters: opts?.filters ?? [] });
      const devices = Array.isArray(result) ? result : result ? [result] : [];
      if (devices.length === 0) return this.#deny('hid', 'cancelled');
      return this.#grant({ kind: 'hid', device: devices[0], devices });
    } catch (err) {
      return this.#denyError('hid', err);
    }
  }

  async #requestSerial(opts?: PermissionRequestOptions): Promise<PermissionGrant | null> {
    const serial =
      this.providers.serial ??
      (globalThis as { navigator?: { serial?: SerialPermissionProvider } }).navigator?.serial ??
      null;
    if (!serial?.requestPort) {
      return this.#deny('serial', 'unavailable', 'Web Serial unavailable');
    }
    try {
      const port = await serial.requestPort(opts?.filters?.length ? { filters: opts.filters } : {});
      if (!port) return this.#deny('serial', 'cancelled');
      return this.#grant({ kind: 'serial', port });
    } catch (err) {
      return this.#denyError('serial', err);
    }
  }

  async #requestFilesystem(): Promise<PermissionGrant | null> {
    const fs =
      this.providers.filesystem ??
      ((typeof window !== 'undefined' &&
        'showDirectoryPicker' in window &&
        (window as unknown as FilesystemPermissionProvider)) ||
        null);
    if (!fs?.showDirectoryPicker) {
      return this.#deny('filesystem', 'unavailable', 'showDirectoryPicker unavailable');
    }
    try {
      const handle = await fs.showDirectoryPicker({ mode: 'readwrite' });
      return this.#grant({
        kind: 'filesystem',
        handle,
        source: 'picker',
        permission: 'granted',
      });
    } catch (err) {
      return this.#denyError('filesystem', err);
    }
  }

  #grant(grant: PermissionGrant): PermissionGrant {
    this.dispatchEvent(
      new CustomEvent<PermissionGrant>('slicc-permission-grant', {
        detail: grant,
        bubbles: true,
        composed: true,
      })
    );
    return grant;
  }

  #deny(kind: PermissionKind, reason: PermissionDenyDetail['reason'], message?: string): null {
    this.dispatchEvent(
      new CustomEvent<PermissionDenyDetail>('slicc-permission-deny', {
        detail: { kind, reason, message },
        bubbles: true,
        composed: true,
      })
    );
    return null;
  }

  #denyError(kind: PermissionKind, err: unknown): null {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'NotFoundError')) {
      return this.#deny(kind, 'cancelled');
    }
    return this.#deny(kind, 'error', err instanceof Error ? err.message : String(err));
  }

  // ----- Folder-drag drop zone (Spike A) -----------------------------------

  #onDocDragEnter = (event: DragEvent): void => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    this.#docDragDepth++;
    this.setAttribute('data-dropping', '');
  };

  #onDocDragOver = (event: DragEvent): void => {
    // preventDefault on dragover is what makes the document a drop target.
    if (isFileDrag(event)) event.preventDefault();
  };

  #onDocDragLeave = (event: DragEvent): void => {
    if (!isFileDrag(event)) return;
    this.#docDragDepth = Math.max(0, this.#docDragDepth - 1);
    if (this.#docDragDepth === 0) this.removeAttribute('data-dropping');
  };

  /**
   * Drop handler — the only legal shape for folder-drag-to-writable-handle:
   * call `getAsFileSystemHandle()` on every file item SYNCHRONOUSLY (before
   * any `await`), then await the resulting Promise.all, then run
   * `requestPermission({mode:'readwrite'})` in the same activation tick.
   * Any `await` before `getAsFileSystemHandle()` invalidates the entry; any
   * UI step between drop and `requestPermission` consumes the transient
   * user activation and throws.
   */
  #onDocDrop = (event: DragEvent): void => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    this.#docDragDepth = 0;
    this.removeAttribute('data-dropping');
    const items = event.dataTransfer?.items;
    if (!items?.length) return;
    const handlePromises: Promise<FileSystemHandle | null>[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as DataTransferItemWithHandle;
      if (item.kind !== 'file' || typeof item.getAsFileSystemHandle !== 'function') continue;
      // SYNCHRONOUS — must run before any await per Spike A's findings.
      handlePromises.push(item.getAsFileSystemHandle());
    }
    if (handlePromises.length === 0) return;
    void this.#processDroppedHandles(handlePromises);
  };

  async #processDroppedHandles(promises: Promise<FileSystemHandle | null>[]): Promise<void> {
    let handles: (FileSystemHandle | null)[];
    try {
      handles = await Promise.all(promises);
    } catch (err) {
      this.#deny('filesystem', 'error', err instanceof Error ? err.message : String(err));
      return;
    }
    const dir = handles.find((h): h is FileSystemDirectoryHandle => h?.kind === 'directory');
    if (!dir) {
      this.#deny('filesystem', 'cancelled', 'no directory in drop');
      return;
    }
    // Same activation tick as the drop — required to avoid the
    // "User activation is required to request permissions" throw.
    type Permissionable = FileSystemDirectoryHandle & {
      requestPermission?: (opts: { mode: string }) => Promise<PermissionState>;
    };
    const permissionable = dir as Permissionable;
    let state: 'granted' | 'prompt' | 'denied' = 'prompt';
    if (permissionable.requestPermission) {
      try {
        state = (await permissionable.requestPermission({
          mode: 'readwrite',
        })) as 'granted' | 'prompt' | 'denied';
      } catch (err) {
        this.#deny('filesystem', 'error', err instanceof Error ? err.message : String(err));
        return;
      }
    } else {
      // Test/fake handle without requestPermission — treat as already granted.
      state = 'granted';
    }
    if (state !== 'granted') {
      this.#deny('filesystem', 'cancelled', `permission ${state}`);
      return;
    }
    this.#grant({
      kind: 'filesystem',
      handle: dir,
      source: 'drop',
      permission: state,
    });
  }

  #build(): void {
    if (this.#built) return;
    this.#built = true;

    const dropInner = h(
      'div',
      { class: 'slicc-permissions__drop-inner' },
      iconEl('folder-up', { size: 32 }),
      h('div', null, 'Drop a folder to mount it (read-write)')
    );
    this.#dropOverlay = h(
      'div',
      { class: 'slicc-permissions__drop', part: 'drop', 'aria-hidden': 'true' },
      dropInner
    );
    this.append(this.#dropOverlay);
  }
}

define('slicc-permissions', SliccPermissions);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-permissions': SliccPermissions;
  }
  interface HTMLElementEventMap {
    'slicc-permission-grant': CustomEvent<PermissionGrant>;
    'slicc-permission-deny': CustomEvent<PermissionDenyDetail>;
  }
}
