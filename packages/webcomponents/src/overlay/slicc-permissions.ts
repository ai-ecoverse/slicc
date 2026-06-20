import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import type { CameraMediaProvider } from './slicc-camera-dialog.js';

/** Re-export so hosts can swap the media seam without depending on the camera dialog module. */
export type { CameraMediaProvider } from './slicc-camera-dialog.js';

/** The picker families the unified surface routes through one gesture. */
export type PermissionKind =
  | 'camera'
  | 'microphone'
  | 'screenshare'
  | 'usb'
  | 'hid'
  | 'serial'
  | 'filesystem'
  | 'popup';

/** Injectable USB seam — defaults to `navigator.usb`. */
export interface UsbPermissionProvider {
  requestDevice(opts: { filters?: unknown[] }): Promise<unknown>;
}

/**
 * Injectable screen-share seam — defaults to `navigator.mediaDevices.getDisplayMedia`.
 * Kept distinct from {@link CameraMediaProvider} so hosts can swap (and tests can
 * fake) the display-media flow without rewiring the camera/mic surface.
 */
export interface ScreenSharePermissionProvider {
  getDisplayMedia(constraints?: MediaStreamConstraints): Promise<MediaStream>;
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

/**
 * Injectable popup-open seam — defaults to `window.open`. The popup kind
 * exists so worker-initiated OAuth flows (whose `oauth-popup` panel-RPC
 * call has already crossed an `await`) can re-acquire user activation by
 * routing the `window.open` through the Allow-button click handler. Hosts
 * can swap this for fakes in tests/stories.
 */
export interface PopupPermissionProvider {
  open(url: string, features?: string): Window | null;
}

/** Bundle of injectable provider seams. Any field omitted falls back to the platform default. */
export interface PermissionProviders {
  media?: CameraMediaProvider | null;
  screenshare?: ScreenSharePermissionProvider | null;
  usb?: UsbPermissionProvider | null;
  hid?: HidPermissionProvider | null;
  serial?: SerialPermissionProvider | null;
  filesystem?: FilesystemPermissionProvider | null;
  popup?: PopupPermissionProvider | null;
}

/** Optional per-request hints (device filters, media constraints, popup URL/features). */
export interface PermissionRequestOptions {
  filters?: unknown[];
  constraints?: MediaStreamConstraints;
  /** Target URL for the `popup` kind. Required when requesting `popup`. */
  url?: string;
  /** Optional `window.open` features string for the `popup` kind. */
  features?: string;
}

/**
 * The granted artifact, tagged by {@link PermissionKind}. Filesystem grants
 * carry both the handle and the gesture source (`picker` vs `drop`) so the
 * host can branch on which path landed without observing two separate events.
 */
export type PermissionGrant =
  | { kind: 'camera'; stream: MediaStream }
  | { kind: 'microphone'; stream: MediaStream }
  | { kind: 'screenshare'; stream: MediaStream }
  | { kind: 'usb'; device: unknown }
  | { kind: 'hid'; device: unknown; devices: unknown[] }
  | { kind: 'serial'; port: unknown }
  | {
      kind: 'filesystem';
      handle: FileSystemDirectoryHandle;
      source: 'picker' | 'drop';
      permission: 'granted' | 'prompt' | 'denied';
    }
  | { kind: 'popup'; window: Window | null };

/** The `slicc-permission-deny` event detail — what failed and why. */
export interface PermissionDenyDetail {
  kind: PermissionKind;
  reason: 'cancelled' | 'unavailable' | 'error';
  message?: string;
}

/** Options for {@link SliccPermissions.prompt} — the multi-kind pre-prompt. */
export interface PermissionPromptOptions {
  /** Permission kinds being requested (one icon per kind, all granted together). */
  kinds: PermissionKind[];
  /** Optional heading; defaults to a generic line built from the kinds. */
  heading?: string;
  /** Body copy explaining what's being requested and why. Caller-supplied. */
  description: string;
  /** Grant-button label (default `"Allow"`). */
  grantLabel?: string;
  /** Cancel-button label (default `"Cancel"`). */
  cancelLabel?: string;
  /** Optional per-kind picker hints applied when the user clicks Allow. */
  requestOptions?: Partial<Record<PermissionKind, PermissionRequestOptions>>;
}

/** Outcome of {@link SliccPermissions.prompt}. */
export interface PermissionPromptResult {
  /** `'granted'` only when every requested kind resolved successfully. */
  status: 'granted' | 'cancelled' | 'error';
  /** Successful grants in the order kinds were requested. */
  grants: PermissionGrant[];
  /** Set when `status !== 'granted'` — mirrors the first failing deny event. */
  reason?: PermissionDenyDetail['reason'];
  /** Optional human-readable detail (forwarded from the underlying picker). */
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

/* Top-floating multi-kind prompt — anchored near where Chrome's native
   permission popup appears (just under the address bar). Non-modal: no
   backdrop, so clicks outside don't accidentally cancel. Escape + Cancel
   button are the dismiss surfaces.

   Rendered via the Popover API (popover=manual + showPopover()) so the
   panel paints in the browser top layer, above any modal dialog regardless
   of stacking context (e.g. Settings dialog at z-index 100). The UA default
   popover stylesheet adds position:fixed; inset:0; margin:auto — override
   inset/margin so the panel stays anchored under the address bar instead of
   being centered. */
slicc-permissions .slicc-permissions__prompt {
  position: fixed;
  inset: unset;
  margin: 0;
  top: 16px;
  left: 50%;
  transform: translateX(-50%) translateY(-8px);
  opacity: 0;
  width: min(440px, calc(100vw - 32px));
  max-width: 92vw;
  pointer-events: auto;
  background: var(--canvas, #fff);
  color: var(--ink, #111);
  border: 1px solid var(--line, rgba(0, 0, 0, 0.12));
  border-radius: 16px;
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.08),
    0 8px 24px rgba(0, 0, 0, 0.18);
  padding: 16px;
  font-family: var(--ui, system-ui, sans-serif);
  transition:
    transform 160ms ease,
    opacity 160ms ease;
}
slicc-permissions .slicc-permissions__prompt[data-open] {
  transform: translateX(-50%) translateY(0);
  opacity: 1;
}
slicc-permissions .slicc-permissions__prompt-icons {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 8px;
}
slicc-permissions .slicc-permissions__prompt-icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--ghost, rgba(0, 0, 0, 0.05));
  color: var(--ink, #111);
  flex: 0 0 auto;
}
slicc-permissions .slicc-permissions__prompt-icon svg {
  width: 22px;
  height: 22px;
}
slicc-permissions .slicc-permissions__prompt-heading {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
  color: var(--ink, #111);
  text-align: center;
  /* Token-driven; tokens already meet 4.5:1 on the canvas surface. */
}
slicc-permissions .slicc-permissions__prompt-desc {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.45;
  color: var(--txt-2, #444);
  text-align: center;
}
slicc-permissions .slicc-permissions__prompt-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
slicc-permissions .slicc-permissions__prompt-btn {
  appearance: none;
  font: 600 13px var(--ui, system-ui, sans-serif);
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  min-height: 32px;
  border: 1px solid transparent;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}
slicc-permissions .slicc-permissions__prompt-btn:focus-visible {
  outline: 2px solid var(--ctx, var(--accent, #3b63fb));
  outline-offset: 2px;
}
slicc-permissions .slicc-permissions__prompt-btn[data-variant='ghost'] {
  background: transparent;
  color: var(--ink, #111);
  border-color: var(--line, rgba(0, 0, 0, 0.15));
}
slicc-permissions .slicc-permissions__prompt-btn[data-variant='ghost']:hover {
  background: var(--ghost, rgba(0, 0, 0, 0.05));
}
slicc-permissions .slicc-permissions__prompt-btn[data-variant='ghost']:active {
  background: color-mix(in oklab, var(--ink, #111) 10%, transparent);
}
slicc-permissions .slicc-permissions__prompt-btn[data-variant='primary'] {
  background: var(--ctx, var(--accent, #3b63fb));
  color: #fff;
}
slicc-permissions .slicc-permissions__prompt-btn[data-variant='primary']:hover {
  background: color-mix(in oklab, var(--ctx, var(--accent, #3b63fb)) 90%, #000);
}
slicc-permissions .slicc-permissions__prompt-btn[data-variant='primary']:active {
  background: color-mix(in oklab, var(--ctx, var(--accent, #3b63fb)) 80%, #000);
}
slicc-permissions .slicc-permissions__prompt-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
@media (prefers-reduced-motion: reduce) {
  slicc-permissions .slicc-permissions__prompt {
    transition: none;
    transform: translateX(-50%) translateY(0);
  }
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
 * Light DOM (no shadow root): the six pickers are native browser dialogs, so
 * the only in-app surface is a drop overlay built with `h()` and appended to
 * the host. One scoped stylesheet is injected into the document.
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
  #activePrompt: { cancel: () => void } | null = null;

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
    if (this.#activePrompt) this.#activePrompt.cancel();
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
      case 'screenshare':
        return this.#requestScreenShare(opts);
      case 'usb':
        return this.#requestUsb(opts);
      case 'hid':
        return this.#requestHid(opts);
      case 'serial':
        return this.#requestSerial(opts);
      case 'filesystem':
        return this.#requestFilesystem();
      case 'popup':
        return this.#requestPopup(opts);
      default:
        // Exhaustiveness — should be unreachable.
        return null;
    }
  }

  /**
   * Multi-kind pre-prompt: render a top-floating dialog with caller-supplied
   * copy, one Lucide icon per requested kind, and Allow / Cancel actions.
   * Clicking Allow runs each kind's picker in sequence under the same user
   * activation, so hosts can ask for `['camera','microphone']` (or
   * `['screenshare']`) with a single user gesture. Cancel / Escape emits one
   * `slicc-permission-deny` with `reason: 'cancelled'` per requested kind.
   *
   * Only one prompt may be open at a time — opening a second one
   * automatically cancels the first.
   */
  async prompt(opts: PermissionPromptOptions): Promise<PermissionPromptResult> {
    if (!opts.kinds.length) {
      return { status: 'granted', grants: [] };
    }
    // Cancel any prompt already on screen so we never stack two panels.
    if (this.#activePrompt) {
      this.#activePrompt.cancel();
    }
    return new Promise<PermissionPromptResult>((resolve) => {
      this.#openPrompt(opts, resolve);
    });
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

  #screenShareProvider(): ScreenSharePermissionProvider | null {
    if (this.providers.screenshare) return this.providers.screenshare;
    const md =
      typeof navigator !== 'undefined'
        ? (navigator.mediaDevices as
            | (MediaDevices & {
                getDisplayMedia?: (c?: MediaStreamConstraints) => Promise<MediaStream>;
              })
            | undefined)
        : undefined;
    if (md && typeof md.getDisplayMedia === 'function') {
      return { getDisplayMedia: (c) => md.getDisplayMedia!(c) };
    }
    return null;
  }

  async #requestScreenShare(opts?: PermissionRequestOptions): Promise<PermissionGrant | null> {
    const provider = this.#screenShareProvider();
    if (!provider) return this.#deny('screenshare', 'unavailable', 'getDisplayMedia unavailable');
    try {
      const stream = await provider.getDisplayMedia(opts?.constraints ?? { video: true });
      return this.#grant({ kind: 'screenshare', stream });
    } catch (err) {
      return this.#denyError('screenshare', err);
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

  /**
   * Open a popup window under user activation. Called from the Allow
   * button click handler of {@link prompt}, so `window.open` runs inside
   * the gesture and the browser will not popup-block. `opts.url` is
   * required; `opts.features` defaults to a sane popup geometry.
   *
   * The grant carries the opened `Window` reference back to the caller so
   * the OAuth message/poll race can run against that exact window. A null
   * return (popup blocked / popup provider unavailable) becomes a deny.
   */
  #requestPopup(opts?: PermissionRequestOptions): PermissionGrant | null {
    const url = opts?.url;
    if (!url) {
      return this.#deny('popup', 'error', 'popup request missing url');
    }
    const features = opts?.features ?? 'width=500,height=700,popup=yes';
    const provider: PopupPermissionProvider | null =
      this.providers.popup ??
      (typeof window !== 'undefined' ? { open: (u, f) => window.open(u, '_blank', f) } : null);
    if (!provider) {
      return this.#deny('popup', 'unavailable', 'window.open unavailable');
    }
    let win: Window | null;
    try {
      win = provider.open(url, features);
    } catch (err) {
      return this.#denyError('popup', err);
    }
    if (!win) {
      return this.#deny('popup', 'error', 'window.open returned null (popup blocked?)');
    }
    return this.#grant({ kind: 'popup', window: win });
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

  // ----- Top-floating multi-kind prompt -----------------------------------

  #openPrompt(
    opts: PermissionPromptOptions,
    resolve: (result: PermissionPromptResult) => void
  ): void {
    const headingText = opts.heading ?? defaultPromptHeading(opts.kinds);
    const grantLabel = opts.grantLabel ?? 'Allow';
    const cancelLabel = opts.cancelLabel ?? 'Cancel';

    const headingId = `slicc-permissions__heading-${Math.random().toString(36).slice(2, 8)}`;
    const descId = `slicc-permissions__desc-${Math.random().toString(36).slice(2, 8)}`;

    const cancelBtn = h(
      'button',
      {
        type: 'button',
        class: 'slicc-permissions__prompt-btn',
        'data-variant': 'ghost',
        part: 'prompt-cancel',
      },
      cancelLabel
    ) as HTMLButtonElement;

    const grantBtn = h(
      'button',
      {
        type: 'button',
        class: 'slicc-permissions__prompt-btn',
        'data-variant': 'primary',
        part: 'prompt-grant',
      },
      grantLabel
    ) as HTMLButtonElement;

    const iconRow = h(
      'div',
      { class: 'slicc-permissions__prompt-icons', 'aria-hidden': 'true' },
      ...opts.kinds.map((kind) =>
        h(
          'span',
          { class: 'slicc-permissions__prompt-icon' },
          iconEl(iconNameForKind(kind), { size: 22 })
        )
      )
    );

    const panel = h(
      'div',
      {
        class: 'slicc-permissions__prompt',
        part: 'prompt',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': headingId,
        'aria-describedby': descId,
        tabindex: '-1',
        // Manual popover: the panel paints in the browser top layer so it
        // stacks above any modal dialog (e.g. Settings at z-index 100)
        // regardless of stacking context. `manual` prevents light-dismiss
        // — we don't want a stray outside click to cancel an OAuth gesture.
        popover: 'manual',
      },
      iconRow,
      h('h2', { class: 'slicc-permissions__prompt-heading', id: headingId }, headingText),
      h('p', { class: 'slicc-permissions__prompt-desc', id: descId }, opts.description),
      h('div', { class: 'slicc-permissions__prompt-actions' }, cancelBtn, grantBtn)
    );
    this.append(panel);
    // Promote into the top layer when the Popover API is supported. Older
    // engines (jsdom, pre-114 Chromium) silently skip; the panel still
    // renders via its `position: fixed` styles.
    const panelWithPopover = panel as HTMLElement & { showPopover?: () => void };
    if (typeof panelWithPopover.showPopover === 'function') {
      try {
        panelWithPopover.showPopover();
      } catch {
        /* not connected, or already showing — non-fatal */
      }
    }

    let settled = false;
    const previouslyFocused = (this.ownerDocument.activeElement as HTMLElement | null) ?? null;

    const close = (): void => {
      panel.removeEventListener('keydown', onKeydown);
      // Synchronous removal — matches Chrome's native popup, which vanishes
      // immediately on Allow / Cancel. The entrance transition is what
      // matters for the user; the close just gets out of the way.
      panel.remove();
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        try {
          previouslyFocused.focus();
        } catch {
          /* element may have detached — silent */
        }
      }
      this.#activePrompt = null;
    };

    const cancelAll = (reason: PermissionDenyDetail['reason'], message?: string): void => {
      if (settled) return;
      settled = true;
      for (const kind of opts.kinds) {
        this.#deny(kind, reason, message);
      }
      close();
      resolve({ status: 'cancelled', grants: [], reason, message });
    };

    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelAll('cancelled');
        return;
      }
      if (event.key === 'Tab') {
        // Two focusable elements — trap focus between them.
        const focusables = [cancelBtn, grantBtn];
        const active = this.ownerDocument.activeElement;
        const idx = focusables.indexOf(active as HTMLButtonElement);
        if (idx === -1) {
          focusables[0].focus();
          event.preventDefault();
          return;
        }
        const next = event.shiftKey
          ? focusables[(idx - 1 + focusables.length) % focusables.length]
          : focusables[(idx + 1) % focusables.length];
        next.focus();
        event.preventDefault();
      }
    };

    cancelBtn.addEventListener('click', () => cancelAll('cancelled'));
    grantBtn.addEventListener('click', async () => {
      if (settled) return;
      settled = true;
      grantBtn.disabled = true;
      cancelBtn.disabled = true;
      const grants: PermissionGrant[] = [];
      let failure: PermissionDenyDetail | null = null;
      for (const kind of opts.kinds) {
        const grant = await this.request(kind, opts.requestOptions?.[kind]);
        if (grant) {
          grants.push(grant);
        } else {
          // request() already emitted a deny event for this kind.
          // Treat the first failure as the prompt outcome and synthesize
          // deny events for any remaining kinds so callers see one event
          // per requested kind.
          failure = { kind, reason: 'cancelled' };
          break;
        }
      }
      const failedIndex = failure ? opts.kinds.indexOf(failure.kind) : -1;
      if (failure && failedIndex >= 0) {
        for (let i = failedIndex + 1; i < opts.kinds.length; i++) {
          this.#deny(opts.kinds[i], 'cancelled');
        }
      }
      close();
      if (failure) {
        resolve({ status: 'cancelled', grants, reason: 'cancelled' });
      } else {
        resolve({ status: 'granted', grants });
      }
    });

    panel.addEventListener('keydown', onKeydown);
    this.#activePrompt = { cancel: () => cancelAll('cancelled') };

    // Activate the entrance transition on the next frame so the initial
    // state has been laid out — keeps the slide-down visible.
    requestAnimationFrame(() => {
      panel.setAttribute('data-open', '');
      grantBtn.focus();
    });
  }
}

/**
 * One lucide glyph per permission kind. Names match the lucide registry
 * (verified at build time by `iconEl`); unknowns would warn at runtime.
 */
function iconNameForKind(kind: PermissionKind): string {
  switch (kind) {
    case 'camera':
      return 'camera';
    case 'microphone':
      return 'mic';
    case 'screenshare':
      return 'monitor-up';
    case 'usb':
      return 'usb';
    case 'hid':
      return 'keyboard';
    case 'serial':
      return 'cable';
    case 'filesystem':
      return 'folder';
    case 'popup':
      return 'external-link';
  }
}

/** Human-readable kind label for the auto-generated heading fallback. */
function labelForKind(kind: PermissionKind): string {
  switch (kind) {
    case 'camera':
      return 'camera';
    case 'microphone':
      return 'microphone';
    case 'screenshare':
      return 'screen';
    case 'usb':
      return 'USB device';
    case 'hid':
      return 'HID device';
    case 'serial':
      return 'serial port';
    case 'filesystem':
      return 'folder';
    case 'popup':
      return 'sign-in window';
  }
}

function defaultPromptHeading(kinds: PermissionKind[]): string {
  if (kinds.length === 1) return `Allow access to your ${labelForKind(kinds[0])}?`;
  const labels = kinds.map(labelForKind);
  const last = labels.pop();
  return `Allow access to your ${labels.join(', ')} and ${last}?`;
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
