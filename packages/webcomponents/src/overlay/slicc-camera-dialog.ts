import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

import './slicc-dialog.js';

export interface CameraMediaProvider {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
}

export interface CameraCaptureDetail {
  dataUrl: string;
}

export interface CameraDeviceChangeDetail {
  deviceId: string;
}

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

export class SliccCameraDialog extends HTMLElement {
  static readonly observedAttributes = ['heading', 'preferred-device'];

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

  get heading(): string {
    return this.getAttribute('heading') ?? DEFAULT_HEADING;
  }

  set heading(value: string | null) {
    if (value == null) this.removeAttribute('heading');
    else this.setAttribute('heading', value);
  }

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
      } catch {}
    }
    return media.getUserMedia({ video: true });
  }

  #attachStream(stream: MediaStream): void {
    this.#video.srcObject = stream;
    void this.#video.play?.()?.catch(() => undefined);

    const facing = stream.getVideoTracks()[0]?.getSettings?.().facingMode;
    this.#video.toggleAttribute('data-mirrored', facing !== 'environment');
  }

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
