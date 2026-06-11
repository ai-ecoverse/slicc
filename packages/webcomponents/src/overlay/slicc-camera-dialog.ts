import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
// Composed by tag — owns its registration.
import './slicc-dialog.js';

/**
 * Injectable media seam: defaults to `navigator.mediaDevices`, swapped in
 * tests / stories for canvas-backed streams so the full capture flow runs
 * without a physical camera.
 */
export interface CameraMediaProvider {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
}

/** The `slicc-camera-capture` event detail — the captured PNG. */
export interface CameraCaptureDetail {
  dataUrl: string;
}

/** The `slicc-camera-device-change` event detail — the chosen camera. */
export interface CameraDeviceChangeDetail {
  deviceId: string;
}

/**
 * Scoped, document-level stylesheet. Light-DOM host (it composes
 * `<slicc-dialog>` by tag), so the chrome is injected once into the host
 * document and selected by the host tag. Everything is token-driven
 * (`--canvas` / `--ink` / `--line` / `--ghost` / `--txt-3` / `--ui`), so dark
 * mode flips automatically through the inherited theme scope.
 */
const STYLE = `
slicc-camera-dialog slicc-dialog::part(dialog) {
  width: min(560px, 92vw);
}
slicc-camera-dialog .slicc-camera__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-family: var(--ui);
}
slicc-camera-dialog .slicc-camera__video {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  border-radius: 10px;
  background: #000;
}
/* User-facing cameras preview mirrored (like every selfie view); the captured
   frame stays unmirrored — the canvas draws the raw track. */
slicc-camera-dialog .slicc-camera__video[data-mirrored] {
  transform: scaleX(-1);
}
slicc-camera-dialog .slicc-camera__select {
  font: 400 12.5px var(--ui);
  color: var(--ink);
  background: var(--canvas);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 9px;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}
slicc-camera-dialog .slicc-camera__select:focus {
  border-color: var(--ctx);
}
slicc-camera-dialog .slicc-camera__select[hidden] {
  display: none;
}
slicc-camera-dialog .slicc-camera__status {
  font-size: 11.5px;
  color: var(--txt-3);
  min-height: 14px;
}
slicc-camera-dialog .slicc-camera__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 500 12px var(--ui);
  color: var(--ink);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
}
slicc-camera-dialog .slicc-camera__btn:hover {
  background: var(--ghost);
}
slicc-camera-dialog .slicc-camera__btn--snap {
  background: var(--ink);
  color: var(--canvas);
  border-color: var(--ink);
}
slicc-camera-dialog .slicc-camera__btn--snap:hover {
  background: color-mix(in srgb, var(--ink) 85%, var(--canvas));
}
`;

const STYLE_ID = 'slicc-camera-dialog-style';

function ensureCameraStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

const DEFAULT_HEADING = 'Take a photo';

/**
 * `<slicc-camera-dialog>` — a camera capture surface over the library's
 * modal shell: a live `<video>` preview (mirrored for user-facing cameras),
 * a camera picker when more than one `videoinput` exists (labels become
 * available once permission is granted), and Cancel / Snap actions. The
 * snap draws the current raw frame to a canvas and resolves a PNG data URL.
 *
 * Light DOM (no shadow root): the host composes `<slicc-dialog>` BY TAG and
 * injects its scoped stylesheet once into the host document. Media access
 * flows through the injectable {@link CameraMediaProvider} (`media`
 * property, defaulting to `navigator.mediaDevices`) so tests and stories can
 * drive the full flow with `canvas.captureStream()` streams.
 *
 * Imperative API: `open()` starts the stream, shows the dialog, and resolves
 * with the captured data URL — or `null` when the user cancels (Cancel, ✕,
 * Escape, backdrop). The stream is always stopped on the way out.
 *
 * @attr heading - dialog title (default "Take a photo")
 * @attr preferred-device - deviceId to open first; falls back to any camera
 * @csspart video - the live preview element
 * @csspart picker - the camera `<select>` (hidden for a single camera)
 * @csspart snap - the primary capture button
 * @csspart cancel - the cancel button
 * @fires slicc-camera-capture - composed + bubbling; `detail.dataUrl` on snap
 * @fires slicc-camera-device-change - composed + bubbling; `detail.deviceId`
 *   when the user picks a different camera (hosts persist the preference)
 */
export class SliccCameraDialog extends HTMLElement {
  static readonly observedAttributes = ['heading', 'preferred-device'];

  /** Injectable media seam; `null` falls back to `navigator.mediaDevices`. */
  media: CameraMediaProvider | null = null;

  #dialog!: HTMLElement & { show?: () => void; hide?: () => void };
  #video!: HTMLVideoElement;
  #select!: HTMLSelectElement;
  #status!: HTMLElement;
  #built = false;
  #stream: MediaStream | null = null;
  #resolve: ((dataUrl: string | null) => void) | null = null;

  connectedCallback(): void {
    ensureCameraStyle(this.ownerDocument);
    this.#build();
  }

  disconnectedCallback(): void {
    this.#stopStream();
  }

  attributeChangedCallback(name: string): void {
    if (name === 'heading' && this.#built) {
      this.#dialog.setAttribute('heading', this.heading);
    }
  }

  /** Dialog title (reflected from the `heading` attribute). */
  get heading(): string {
    return this.getAttribute('heading') ?? DEFAULT_HEADING;
  }

  set heading(value: string | null) {
    if (value == null) this.removeAttribute('heading');
    else this.setAttribute('heading', value);
  }

  /** The camera deviceId to open first (reflected to `preferred-device`). */
  get preferredDevice(): string | null {
    return this.getAttribute('preferred-device');
  }

  set preferredDevice(value: string | null) {
    if (value == null) this.removeAttribute('preferred-device');
    else this.setAttribute('preferred-device', value);
  }

  #mediaProvider(): CameraMediaProvider | null {
    return this.media ?? (typeof navigator !== 'undefined' ? navigator.mediaDevices : null) ?? null;
  }

  /**
   * Start the camera (preferred device first, any camera as fallback), show
   * the dialog, and resolve with the snapped PNG data URL — `null` on cancel
   * or when no camera is available. The stream always stops on the way out.
   */
  async open(): Promise<string | null> {
    this.#build();
    const media = this.#mediaProvider();
    if (!media) return null;
    try {
      this.#stream = await this.#openStream(media, this.preferredDevice);
    } catch {
      return null;
    }
    this.#attachStream(this.#stream);
    await this.#populatePicker(media);
    this.#dialog.setAttribute('heading', this.heading);
    this.#dialog.show?.();
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  async #openStream(media: CameraMediaProvider, deviceId: string | null): Promise<MediaStream> {
    if (deviceId) {
      try {
        return await media.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      } catch {
        // The preferred camera is gone — fall through to any camera.
      }
    }
    return media.getUserMedia({ video: true });
  }

  #attachStream(stream: MediaStream): void {
    this.#video.srcObject = stream;
    void this.#video.play?.()?.catch(() => undefined);
    // Mirror the preview unless the camera explicitly faces away.
    const facing = stream.getVideoTracks()[0]?.getSettings?.().facingMode;
    this.#video.toggleAttribute('data-mirrored', facing !== 'environment');
  }

  /** Fill the picker from `enumerateDevices` (post-permission, so labels exist). */
  async #populatePicker(media: CameraMediaProvider): Promise<void> {
    let cameras: MediaDeviceInfo[] = [];
    try {
      cameras = (await media.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      cameras = [];
    }
    this.#select.replaceChildren(
      ...cameras.map((camera, index) =>
        h('option', { value: camera.deviceId }, camera.label || `Camera ${index + 1}`)
      )
    );
    const activeId = this.#stream?.getVideoTracks()[0]?.getSettings?.().deviceId;
    if (activeId) this.#select.value = activeId;
    this.#select.toggleAttribute('hidden', cameras.length < 2);
  }

  async #switchCamera(deviceId: string): Promise<void> {
    const media = this.#mediaProvider();
    if (!media) return;
    this.#status.textContent = '';
    try {
      const next = await media.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      this.#stopStream();
      this.#stream = next;
      this.#attachStream(next);
      this.dispatchEvent(
        new CustomEvent<CameraDeviceChangeDetail>('slicc-camera-device-change', {
          detail: { deviceId },
          bubbles: true,
          composed: true,
        })
      );
    } catch {
      this.#status.textContent = 'Could not switch camera — keeping the current one.';
    }
  }

  #snap(): void {
    const canvas = this.ownerDocument.createElement('canvas');
    canvas.width = this.#video.videoWidth;
    canvas.height = this.#video.videoHeight;
    if (canvas.width === 0 || canvas.height === 0) {
      this.#status.textContent = 'No frame yet — give the camera a moment.';
      return;
    }
    canvas.getContext('2d')?.drawImage(this.#video, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    this.dispatchEvent(
      new CustomEvent<CameraCaptureDetail>('slicc-camera-capture', {
        detail: { dataUrl },
        bubbles: true,
        composed: true,
      })
    );
    this.#finish(dataUrl);
  }

  #finish(dataUrl: string | null): void {
    this.#stopStream();
    const resolve = this.#resolve;
    this.#resolve = null;
    this.#dialog.hide?.();
    resolve?.(dataUrl);
  }

  #stopStream(): void {
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
    if (this.#video) this.#video.srcObject = null;
  }

  #build(): void {
    if (this.#built) return;
    this.#built = true;

    this.#video = h('video', {
      class: 'slicc-camera__video',
      part: 'video',
      autoplay: true,
      muted: true,
      playsinline: true,
    }) as HTMLVideoElement;

    this.#select = h('select', {
      class: 'slicc-camera__select',
      part: 'picker',
      'aria-label': 'Camera',
      hidden: true,
    }) as HTMLSelectElement;
    this.#select.addEventListener('change', () => {
      void this.#switchCamera(this.#select.value);
    });

    this.#status = h('div', { class: 'slicc-camera__status' });

    const cancel = h(
      'button',
      { type: 'button', class: 'slicc-camera__btn', part: 'cancel', slot: 'footer' },
      'Cancel'
    );
    cancel.addEventListener('click', () => this.#finish(null));

    const snap = h(
      'button',
      {
        type: 'button',
        class: 'slicc-camera__btn slicc-camera__btn--snap',
        part: 'snap',
        slot: 'footer',
      },
      iconEl('camera', { size: 14 }),
      ' Snap'
    );
    snap.addEventListener('click', () => this.#snap());

    const body = h('div', { class: 'slicc-camera__body' }, this.#video, this.#select, this.#status);

    this.#dialog = this.ownerDocument.createElement('slicc-dialog') as HTMLElement & {
      show?: () => void;
      hide?: () => void;
    };
    this.#dialog.setAttribute('heading', this.heading);
    this.#dialog.append(body, cancel, snap);
    // Any dismissal (✕ / Escape / backdrop) resolves the open() promise null.
    this.#dialog.addEventListener('slicc-dialog-close', () => {
      if (this.#resolve) this.#finish(null);
    });
    this.append(this.#dialog);
  }
}

define('slicc-camera-dialog', SliccCameraDialog);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-camera-dialog': SliccCameraDialog;
  }
  interface HTMLElementEventMap {
    'slicc-camera-capture': CustomEvent<CameraCaptureDetail>;
    'slicc-camera-device-change': CustomEvent<CameraDeviceChangeDetail>;
  }
}
