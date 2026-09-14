import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import type { CameraMediaProvider } from '../overlay/slicc-camera-dialog.js';
import { labelDevices, pickDefaultMicId, shouldShowDevicePicker } from './devices.js';

export type { CameraMediaProvider } from '../overlay/slicc-camera-dialog.js';

export type CaptureMode = 'photo' | 'video';

export interface CaptureResult {
  kind: 'image' | 'video';
  dataUrl?: string;
  blob?: Blob;
  mimeType: string;
  width: number;
  height: number;
  durationMs?: number;
}

export interface CaptureDeviceChangeDetail {
  deviceId: string;
  kind: 'camera' | 'microphone';
}

export type RecorderFactory = (
  stream: MediaStream,
  options?: MediaRecorderOptions
) => MediaRecorder;

const STYLE = `
slicc-composer-capture {
  position: relative;
  display: block;
  width: 100%;
  /* Self-bounded box: the surface fills the composer area at a responsive
     ratio (3:4 portrait on desktop / 4:3 landscape on mobile), clamped
     between a usable min and a sensible max, so the absolutely positioned
     bar / close / status overlays always sit inside the host rect rather
     than being pushed below by the <video>'s intrinsic size. The desktop
     max-width:360px lets the 3:4 ratio actually manifest as portrait
     within the wider 680px composer column (480px tall x 360px wide),
     with the box centered via margin:0 auto; the control bar stays one
     row at the bottom. */
  aspect-ratio: 3 / 4;
  max-width: 360px;
  margin: 0 auto;
  min-height: 220px;
  max-height: min(60vh, 480px);
  border-radius: 14px;
  overflow: hidden;
  background: #000;
  font-family: var(--ui);
  color: #fff;
  isolation: isolate;
}
slicc-composer-capture[hidden] {
  display: none;
}
/* Narrow / mobile: switch to landscape 4:3 and drop the desktop width
   cap so the box fills the column (matches the WC shell's 560px narrow
   breakpoint used by the chat thread / meta hint / logo). */
@media (max-width: 560px) {
  slicc-composer-capture {
    aspect-ratio: 4 / 3;
    max-width: 100%;
  }
}
slicc-composer-capture .slicc-capture__video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  background: #000;
}
slicc-composer-capture .slicc-capture__video[data-mirrored] {
  transform: scaleX(-1);
}
slicc-composer-capture .slicc-capture__status {
  position: absolute;
  top: 8px;
  left: 10px;
  /* Leave clearance for the absolutely-positioned close button in the
     top-right corner so the status text never visually collides with it. */
  right: 44px;
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.85);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  min-height: 14px;
}
slicc-composer-capture .slicc-capture__close {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  color: #fff;
  background: color-mix(in srgb, #000 55%, transparent);
  border: 1px solid color-mix(in srgb, #fff 35%, transparent);
  border-radius: 50%;
  cursor: pointer;
  backdrop-filter: blur(8px) saturate(1.2);
  -webkit-backdrop-filter: blur(8px) saturate(1.2);
}
slicc-composer-capture .slicc-capture__close:hover {
  background: color-mix(in srgb, #fff 18%, transparent);
}
slicc-composer-capture .slicc-capture__bar {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  /* Single row: selects shrink (min-width: 0 + flex: 0 1 auto below) instead
     of wrapping so the bar never becomes two rows when the mic <select>
     appears in video mode. */
  flex-wrap: nowrap;
  padding: 6px 8px;
  border-radius: 10px;
  background: color-mix(in srgb, #000 55%, transparent);
  backdrop-filter: blur(8px) saturate(1.2);
  -webkit-backdrop-filter: blur(8px) saturate(1.2);
}
slicc-composer-capture .slicc-capture__spacer {
  flex: 1 1 auto;
}
slicc-composer-capture .slicc-capture__select {
  font: 400 12px var(--ui);
  color: #fff;
  background: color-mix(in srgb, #000 35%, transparent);
  border: 1px solid color-mix(in srgb, #fff 35%, transparent);
  border-radius: 8px;
  padding: 5px 8px;
  outline: none;
  /* Allow shrinking below intrinsic width so long device labels truncate
     instead of forcing the control bar onto a second row. */
  min-width: 0;
  max-width: 140px;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
slicc-composer-capture .slicc-capture__select[hidden] {
  display: none;
}
slicc-composer-capture .slicc-capture__select:focus {
  border-color: var(--ctx);
}
slicc-composer-capture .slicc-capture__mode {
  display: inline-flex;
  border: 1px solid color-mix(in srgb, #fff 35%, transparent);
  border-radius: 8px;
  overflow: hidden;
  flex: 0 0 auto;
}
slicc-composer-capture .slicc-capture__mode-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: 500 12px var(--ui);
  color: #fff;
  background: transparent;
  border: 0;
  /* Icon-only buttons: square-ish padding centers the 14px lucide glyph. */
  padding: 5px 8px;
  cursor: pointer;
}
slicc-composer-capture .slicc-capture__mode-btn[aria-pressed='true'] {
  background: color-mix(in srgb, #fff 22%, transparent);
}
slicc-composer-capture .slicc-capture__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 500 12px var(--ui);
  color: #fff;
  background: color-mix(in srgb, #000 35%, transparent);
  border: 1px solid color-mix(in srgb, #fff 35%, transparent);
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
}
slicc-composer-capture .slicc-capture__btn:hover {
  background: color-mix(in srgb, #fff 18%, transparent);
}
slicc-composer-capture .slicc-capture__btn--primary {
  background: var(--canvas, #fff);
  color: var(--ink, #111);
  border-color: var(--canvas, #fff);
}
slicc-composer-capture .slicc-capture__btn--primary:hover {
  background: color-mix(in srgb, var(--canvas, #fff) 85%, var(--ink, #111));
}
slicc-composer-capture .slicc-capture__btn--rec {
  background: #d9362b;
  color: #fff;
  border-color: #d9362b;
}
slicc-composer-capture .slicc-capture__btn--rec:hover {
  background: color-mix(in srgb, #d9362b 88%, #fff);
}
slicc-composer-capture .slicc-capture__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: currentColor;
  display: inline-block;
}
slicc-composer-capture .slicc-capture__square {
  width: 10px;
  height: 10px;
  background: currentColor;
  display: inline-block;
}
slicc-composer-capture .slicc-capture__timer {
  font: 500 12px var(--ui);
  color: #fff;
  font-variant-numeric: tabular-nums;
  padding: 0 4px;
}
slicc-composer-capture .slicc-capture__timer[hidden] {
  display: none;
}
`;

const STYLE_ID = 'slicc-composer-capture-style';

function ensureCaptureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

const DEFAULT_MODE: CaptureMode = 'photo';
const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return 'video/webm';
  for (const m of VIDEO_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return 'video/webm';
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export class SliccComposerCapture extends HTMLElement {
  static readonly observedAttributes = ['mode', 'preferred-device', 'preferred-audio-device'];

  media: CameraMediaProvider | null = null;

  recorderFactory: RecorderFactory | null = null;

  #video!: HTMLVideoElement;
  #select!: HTMLSelectElement;
  #audioSelect!: HTMLSelectElement;
  #status!: HTMLElement;
  #timer!: HTMLElement;
  #primary!: HTMLButtonElement;
  #cancel!: HTMLButtonElement;
  #modePhoto!: HTMLButtonElement;
  #modeVideo!: HTMLButtonElement;
  #built = false;
  #stream: MediaStream | null = null;
  #audioTrack: MediaStreamTrack | null = null;
  #recorder: MediaRecorder | null = null;
  #chunks: Blob[] = [];
  #recordStartedAt = 0;
  #timerHandle: ReturnType<typeof setInterval> | null = null;
  #resolve: ((result: CaptureResult | null) => void) | null = null;
  #onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.#resolve) this.#cancelCapture();
  };

  connectedCallback(): void {
    ensureCaptureStyle(this.ownerDocument);
    this.#build();
    this.ownerDocument.addEventListener('keydown', this.#onKeyDown);
  }

  disconnectedCallback(): void {
    this.ownerDocument.removeEventListener('keydown', this.#onKeyDown);
    this.#stopTimer();
    this.#stopRecorder();
    this.#stopStream();
    if (this.#resolve) {
      const resolve = this.#resolve;
      this.#resolve = null;
      resolve(null);
    }
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'mode' && this.#built) {
      this.#applyMode((value as CaptureMode) ?? DEFAULT_MODE);
    }
  }

  get mode(): CaptureMode {
    return (this.getAttribute('mode') as CaptureMode) === 'video' ? 'video' : 'photo';
  }

  set mode(value: CaptureMode | null) {
    if (value == null) this.removeAttribute('mode');
    else this.setAttribute('mode', value);
  }

  get preferredDevice(): string | null {
    return this.getAttribute('preferred-device');
  }

  set preferredDevice(value: string | null) {
    if (value == null) this.removeAttribute('preferred-device');
    else this.setAttribute('preferred-device', value);
  }

  get preferredAudioDevice(): string | null {
    return this.getAttribute('preferred-audio-device');
  }

  set preferredAudioDevice(value: string | null) {
    if (value == null) this.removeAttribute('preferred-audio-device');
    else this.setAttribute('preferred-audio-device', value);
  }

  #mediaProvider(): CameraMediaProvider | null {
    return this.media ?? (typeof navigator !== 'undefined' ? navigator.mediaDevices : null) ?? null;
  }

  #makeRecorder(stream: MediaStream, opts?: MediaRecorderOptions): MediaRecorder {
    if (this.recorderFactory) return this.recorderFactory(stream, opts);
    return new MediaRecorder(stream, opts);
  }

  async open(mode?: CaptureMode): Promise<CaptureResult | null> {
    this.#build();
    if (mode) this.mode = mode;
    this.#applyMode(this.mode);
    const provider = this.#mediaProvider();
    if (!provider) return null;
    try {
      this.#stream = await this.#openStream(
        provider,
        this.preferredDevice,
        this.preferredAudioDevice,
        this.mode
      );
    } catch {
      return null;
    }
    this.#captureAudioTrack();
    this.#attachStream(this.#stream);
    await this.#populatePicker(provider);
    await this.#populateAudioPicker(provider);
    this.hidden = false;
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  async #openStream(
    provider: CameraMediaProvider,
    deviceId: string | null,
    audioDeviceId: string | null,
    mode: CaptureMode
  ): Promise<MediaStream> {
    const audio = await this.#audioConstraint(provider, audioDeviceId, mode);
    if (deviceId) {
      try {
        return await provider.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio });
      } catch {}
    }
    try {
      return await provider.getUserMedia({ video: true, audio });
    } catch (err) {
      if (audio === false) throw err;

      this.#status.textContent = 'Microphone unavailable — recording video only.';
      return provider.getUserMedia({ video: true, audio: false });
    }
  }

  async #audioConstraint(
    provider: CameraMediaProvider,
    audioDeviceId: string | null,
    mode: CaptureMode
  ): Promise<MediaTrackConstraints | boolean> {
    if (mode !== 'video') return false;
    if (audioDeviceId) return { deviceId: { exact: audioDeviceId } };
    let mics: MediaDeviceInfo[] = [];
    try {
      mics = (await provider.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    } catch {
      mics = [];
    }
    const defaultMic = pickDefaultMicId(labelDevices(mics, 'microphone'));
    return defaultMic ? { deviceId: { exact: defaultMic } } : true;
  }

  #captureAudioTrack(): void {
    this.#audioTrack = this.#stream?.getAudioTracks()[0] ?? null;
  }

  #attachStream(stream: MediaStream): void {
    this.#video.srcObject = stream;

    this.#video.muted = true;
    void this.#video.play?.()?.catch(() => undefined);
    const facing = stream.getVideoTracks()[0]?.getSettings?.().facingMode;
    this.#video.toggleAttribute('data-mirrored', facing !== 'environment');
  }

  async #populatePicker(provider: CameraMediaProvider): Promise<void> {
    let cameras: MediaDeviceInfo[] = [];
    try {
      cameras = (await provider.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      cameras = [];
    }
    const options = labelDevices(cameras, 'camera');
    this.#select.replaceChildren(
      ...options.map((opt) => h('option', { value: opt.deviceId }, opt.label))
    );
    const activeId = this.#stream?.getVideoTracks()[0]?.getSettings?.().deviceId;
    if (activeId) this.#select.value = activeId;
    this.#select.toggleAttribute('hidden', !shouldShowDevicePicker(options));
  }

  async #populateAudioPicker(provider: CameraMediaProvider): Promise<void> {
    let mics: MediaDeviceInfo[] = [];
    try {
      mics = (await provider.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    } catch {
      mics = [];
    }
    const options = labelDevices(mics, 'microphone');
    this.#audioSelect.replaceChildren(
      ...options.map((opt) => h('option', { value: opt.deviceId }, opt.label))
    );

    const activeId =
      this.#audioTrack?.getSettings?.().deviceId ??
      this.preferredAudioDevice ??
      pickDefaultMicId(options);
    if (activeId && options.some((o) => o.deviceId === activeId)) {
      this.#audioSelect.value = activeId;
    }
    this.#applyAudioPickerVisibility();
  }

  #applyAudioPickerVisibility(): void {
    if (!this.#audioSelect) return;
    const enough = this.#audioSelect.options.length >= 2;
    const visible = this.mode === 'video' && enough;
    this.#audioSelect.toggleAttribute('hidden', !visible);
  }

  async #switchCamera(deviceId: string): Promise<void> {
    const provider = this.#mediaProvider();
    if (!provider) return;
    this.#status.textContent = '';
    try {
      const next = await provider.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      this.#stopVideoTracks();
      const merged = next;
      if (this.mode === 'video' && this.#audioTrack && this.#audioTrack.readyState === 'live') {
        merged.addTrack(this.#audioTrack);
      } else if (this.mode === 'video') {
        try {
          const a = await provider.getUserMedia({
            audio: await this.#audioConstraint(provider, this.preferredAudioDevice, 'video'),
          });
          for (const t of a.getAudioTracks()) {
            this.#audioTrack = t;
            merged.addTrack(t);
          }
        } catch {
          this.#status.textContent = 'Microphone unavailable — recording video only.';
        }
      }
      this.#stream = merged;
      this.#attachStream(merged);
      this.dispatchEvent(
        new CustomEvent<CaptureDeviceChangeDetail>('slicc-capture-device-change', {
          detail: { deviceId, kind: 'camera' },
          bubbles: true,
          composed: true,
        })
      );
    } catch {
      this.#status.textContent = 'Could not switch camera — keeping the current one.';
    }
  }

  async #switchMicrophone(deviceId: string): Promise<void> {
    const provider = this.#mediaProvider();
    if (!provider || !this.#stream) return;
    this.#status.textContent = '';
    let next: MediaStream;
    try {
      next = await provider.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    } catch {
      this.#status.textContent = 'Could not switch microphone — keeping the current one.';
      return;
    }
    const newTrack = next.getAudioTracks()[0];
    if (!newTrack) {
      this.#status.textContent = 'Could not switch microphone — keeping the current one.';
      return;
    }
    if (this.#audioTrack) {
      try {
        this.#stream.removeTrack(this.#audioTrack);
      } catch {}
      this.#audioTrack.stop();
    }
    this.#stream.addTrack(newTrack);
    this.#audioTrack = newTrack;
    this.preferredAudioDevice = deviceId;
    this.dispatchEvent(
      new CustomEvent<CaptureDeviceChangeDetail>('slicc-capture-device-change', {
        detail: { deviceId, kind: 'microphone' },
        bubbles: true,
        composed: true,
      })
    );
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
    const mimeType = 'image/png';
    const dataUrl = canvas.toDataURL(mimeType);
    this.#finishCapture({
      kind: 'image',
      dataUrl,
      mimeType,
      width: canvas.width,
      height: canvas.height,
    });
  }

  #startRecording(): void {
    if (!this.#stream || this.#recorder) return;
    this.#chunks = [];
    const mimeType = pickRecorderMime();
    let recorder: MediaRecorder;
    try {
      recorder = this.#makeRecorder(this.#stream, { mimeType });
    } catch {
      this.#status.textContent = 'Recording is not supported in this browser.';
      return;
    }
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) this.#chunks.push(e.data);
    };
    recorder.onstop = () => this.#assembleRecording(mimeType);
    try {
      recorder.start();
    } catch {
      this.#status.textContent = 'Could not start recording.';
      return;
    }
    this.#recorder = recorder;
    this.#recordStartedAt = Date.now();

    this.#audioSelect.disabled = true;
    this.#select.disabled = true;
    this.#timer.hidden = false;
    this.#timer.textContent = formatElapsed(0);
    this.#timerHandle = setInterval(() => {
      this.#timer.textContent = formatElapsed(Date.now() - this.#recordStartedAt);
    }, 250);
    this.#renderPrimary();
  }

  #stopRecording(): void {
    const recorder = this.#recorder;
    if (!recorder) return;
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {
      this.#assembleRecording(recorder.mimeType || 'video/webm');
    }
  }

  #assembleRecording(mimeType: string): void {
    const durationMs = this.#recordStartedAt ? Date.now() - this.#recordStartedAt : 0;
    this.#stopTimer();
    const effectiveType = this.#recorder?.mimeType || mimeType || 'video/webm';
    const blob = new Blob(this.#chunks, { type: effectiveType });
    this.#chunks = [];
    this.#recorder = null;
    if (this.#audioSelect) this.#audioSelect.disabled = false;
    if (this.#select) this.#select.disabled = false;
    const dataUrl = typeof URL !== 'undefined' ? URL.createObjectURL(blob) : undefined;
    this.#finishCapture({
      kind: 'video',
      blob,
      dataUrl,
      mimeType: effectiveType,
      width: this.#video.videoWidth,
      height: this.#video.videoHeight,
      durationMs,
    });
  }

  #stopTimer(): void {
    if (this.#timerHandle != null) {
      clearInterval(this.#timerHandle);
      this.#timerHandle = null;
    }
    this.#timer.hidden = true;
    this.#timer.textContent = '';
    this.#recordStartedAt = 0;
  }

  #stopRecorder(): void {
    const recorder = this.#recorder;
    this.#recorder = null;
    this.#chunks = [];
    if (this.#audioSelect) this.#audioSelect.disabled = false;
    if (this.#select) this.#select.disabled = false;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {}
    }
  }

  #stopVideoTracks(): void {
    for (const t of this.#stream?.getVideoTracks() ?? []) t.stop();
  }

  #stopStream(): void {
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
    this.#audioTrack = null;
    if (this.#video) this.#video.srcObject = null;
  }

  #cancelCapture(): void {
    this.dispatchEvent(new CustomEvent('slicc-capture-cancel', { bubbles: true, composed: true }));
    this.#finishCapture(null);
  }

  #finishCapture(result: CaptureResult | null): void {
    if (result) {
      this.dispatchEvent(
        new CustomEvent<CaptureResult>('slicc-capture', {
          detail: result,
          bubbles: true,
          composed: true,
        })
      );
    }
    this.#stopTimer();
    this.#stopRecorder();
    this.#stopStream();
    const resolve = this.#resolve;
    this.#resolve = null;
    this.hidden = true;
    resolve?.(result);
  }

  #applyMode(mode: CaptureMode): void {
    const isVideo = mode === 'video';
    this.#modePhoto.setAttribute('aria-pressed', String(!isVideo));
    this.#modeVideo.setAttribute('aria-pressed', String(isVideo));
    this.#status.textContent = isVideo ? 'Mic on — video will record audio.' : '';
    this.#renderPrimary();
    this.#applyAudioPickerVisibility();
  }

  #renderPrimary(): void {
    const btn = this.#primary;
    btn.replaceChildren();
    if (this.mode === 'photo') {
      btn.className = 'slicc-capture__btn slicc-capture__btn--primary';
      btn.setAttribute('part', 'snap');
      btn.setAttribute('aria-label', 'Snap photo');
      btn.append(iconEl('camera', { size: 14 }), document.createTextNode(' Snap'));
      return;
    }
    if (this.#recorder) {
      btn.className = 'slicc-capture__btn slicc-capture__btn--rec';
      btn.setAttribute('part', 'stop');
      btn.setAttribute('aria-label', 'Stop recording');
      btn.append(h('span', { class: 'slicc-capture__square' }), document.createTextNode(' Stop'));
    } else {
      btn.className = 'slicc-capture__btn slicc-capture__btn--rec';
      btn.setAttribute('part', 'record');
      btn.setAttribute('aria-label', 'Start recording');
      btn.append(h('span', { class: 'slicc-capture__dot' }), document.createTextNode(' Record'));
    }
  }

  #onPrimaryClick(): void {
    if (this.mode === 'photo') {
      this.#snap();
      return;
    }
    if (this.#recorder) this.#stopRecording();
    else this.#startRecording();
  }

  #build(): void {
    if (this.#built) return;
    this.#built = true;

    this.#video = h('video', {
      class: 'slicc-capture__video',
      part: 'video',
      autoplay: true,
      muted: true,
      playsinline: true,
    }) as HTMLVideoElement;

    this.#video.muted = true;

    this.#status = h('div', { class: 'slicc-capture__status' });

    this.#select = h('select', {
      class: 'slicc-capture__select',
      part: 'picker',
      'aria-label': 'Camera',
      hidden: true,
    }) as HTMLSelectElement;
    this.#select.addEventListener('change', () => {
      void this.#switchCamera(this.#select.value);
    });

    this.#audioSelect = h('select', {
      class: 'slicc-capture__select',
      part: 'audio-picker',
      'aria-label': 'Microphone',
      hidden: true,
    }) as HTMLSelectElement;
    this.#audioSelect.addEventListener('change', () => {
      void this.#switchMicrophone(this.#audioSelect.value);
    });

    this.#modePhoto = h(
      'button',
      {
        type: 'button',
        class: 'slicc-capture__mode-btn',
        part: 'mode',
        'aria-pressed': 'true',
        'aria-label': 'Photo',
      },
      iconEl('image', { size: 14 })
    ) as HTMLButtonElement;
    this.#modePhoto.addEventListener('click', () => {
      this.mode = 'photo';
    });

    this.#modeVideo = h(
      'button',
      {
        type: 'button',
        class: 'slicc-capture__mode-btn',
        part: 'mode',
        'aria-pressed': 'false',
        'aria-label': 'Video',
      },
      iconEl('video', { size: 14 })
    ) as HTMLButtonElement;
    this.#modeVideo.addEventListener('click', () => {
      void this.#switchToVideoMode();
    });

    const modeGroup = h(
      'div',
      { class: 'slicc-capture__mode', role: 'group', 'aria-label': 'Capture mode' },
      this.#modePhoto,
      this.#modeVideo
    );

    this.#timer = h('span', { class: 'slicc-capture__timer', hidden: true });

    this.#cancel = h(
      'button',
      {
        type: 'button',
        class: 'slicc-capture__close',
        part: 'cancel',
        'aria-label': 'Cancel',
      },
      iconEl('x', { size: 14 })
    ) as HTMLButtonElement;
    this.#cancel.addEventListener('click', () => this.#cancelCapture());

    this.#primary = h('button', {
      type: 'button',
      class: 'slicc-capture__btn slicc-capture__btn--primary',
      part: 'snap',
      'aria-label': 'Snap photo',
    }) as HTMLButtonElement;
    this.#primary.addEventListener('click', () => this.#onPrimaryClick());

    const bar = h(
      'div',
      { class: 'slicc-capture__bar' },
      this.#select,
      this.#audioSelect,
      h('span', { class: 'slicc-capture__spacer' }),
      this.#timer,
      this.#primary,
      modeGroup
    );

    this.replaceChildren(this.#video, this.#status, bar, this.#cancel);
    this.#applyMode(this.mode);
  }

  async #switchToVideoMode(): Promise<void> {
    this.mode = 'video';
    if (!this.#stream) return;
    if (this.#stream.getAudioTracks().length > 0) return;
    const provider = this.#mediaProvider();
    if (!provider) return;
    const activeId =
      this.#stream.getVideoTracks()[0]?.getSettings?.().deviceId ?? this.preferredDevice ?? null;
    const audio = await this.#audioConstraint(provider, this.preferredAudioDevice, 'video');
    try {
      const next = activeId
        ? await provider.getUserMedia({ video: { deviceId: { exact: activeId } }, audio })
        : await provider.getUserMedia({ video: true, audio });
      this.#stopStream();
      this.#stream = next;
      this.#captureAudioTrack();
      this.#attachStream(next);
      await this.#populateAudioPicker(provider);
    } catch {
      this.#status.textContent = 'Microphone unavailable — recording video only.';
    }
  }
}

define('slicc-composer-capture', SliccComposerCapture);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-composer-capture': SliccComposerCapture;
  }
  interface HTMLElementEventMap {
    'slicc-capture': CustomEvent<CaptureResult>;
    'slicc-capture-cancel': CustomEvent<void>;
    'slicc-capture-device-change': CustomEvent<CaptureDeviceChangeDetail>;
  }
}
