/**
 * Page audio, clipboard, camera, and `hear` panel-RPC handlers.
 * Plus display-share session-ended relay for screen computers.
 */
import type { PanelRpcHandlers } from '../../kernel/panel-rpc.js';
import type {
  CameraCaptureRequest,
  CameraCaptureResult,
} from '../../kernel/panel-rpc-camera-types.js';
import type { StandalonePanelRpcHandlerOptions } from '../panel-rpc-handlers.js';
import { openOAuthPopup } from './oauth-handlers.js';

async function handleScreencaptureRpc(payload: {
  mimeType: string;
  quality: number;
  mode?: 'image' | 'video' | 'session';
  durationMs?: number;
  audio?: boolean;
  session?: 'start' | 'frame' | 'stop' | 'record';
  handle?: string;
  maxWidth?: number;
}): Promise<{
  bytes: ArrayBuffer;
  width: number;
  height: number;
  nativeWidth?: number;
  nativeHeight?: number;
  mimeType: string;
  durationMs?: number;
  handle?: string;
}> {
  const { captureDisplayMedia, sessionCaptureRequest } = await import(
    '../../shell/supplemental-commands/screencapture-media.js'
  );
  const { mimeType, quality, mode, durationMs, audio, session, handle, maxWidth } = payload;
  const captured = await captureDisplayMedia(
    mode === 'session'
      ? sessionCaptureRequest({ session, handle, mimeType, quality, durationMs, maxWidth })
      : mode === 'video'
        ? {
            mode: 'video',
            mimeType,
            durationMs: durationMs ?? 5_000,
            audio: !!audio,
          }
        : { mode: 'image', mimeType, quality }
  );
  const buffer = captured.bytes.buffer.slice(
    captured.bytes.byteOffset,
    captured.bytes.byteOffset + captured.bytes.byteLength
  ) as ArrayBuffer;
  return {
    bytes: buffer,
    width: captured.width,
    height: captured.height,
    mimeType: captured.mimeType,
    nativeWidth: captured.nativeWidth,
    nativeHeight: captured.nativeHeight,
    ...(captured.durationMs !== undefined ? { durationMs: captured.durationMs } : {}),
    ...(captured.handle !== undefined ? { handle: captured.handle } : {}),
  };
}

/** Page identity, screen/speech/audio output. */
export function buildPageAudioHandlers() {
  return {
    'page-info': () => ({
      origin: window.location.origin,
      href: window.location.href,
      title: document.title || '',
    }),

    screencapture: (payload) => handleScreencaptureRpc(payload),

    // Routed through the kokoro-aware speak helper: the on-device voice runs
    // once its chained download is ready (or when `voice` names a kokoro
    // voice id), Web Speech otherwise — so the worker's `say` picks the
    // upgrade up with no protocol change.
    'speak-text': async ({ text, lang, voice, rate, pitch, volume }) => {
      const { speak } = await import('../../speech/speak.js');
      await speak({ text, lang, voice, rate, pitch, volume });
      return { done: true };
    },

    'list-voices': async () => {
      // Kokoro voices (when the engine is warm) lead the list, exposed by
      // their stable ids so `say -v af_heart` round-trips.
      const { kokoroVoicesIfReady } = await import('../../speech/speak.js');
      const kokoro = kokoroVoicesIfReady().map((v) => ({
        name: v.id,
        lang: v.lang,
        default: false,
        onDevice: v.onDevice,
      }));
      if (typeof speechSynthesis === 'undefined') {
        if (kokoro.length > 0) return { voices: kokoro };
        throw new Error('speechSynthesis is unavailable in this page');
      }
      const ready = speechSynthesis.getVoices();
      if (ready.length > 0) return { voices: [...kokoro, ...ready.map(toVoiceInfo)] };
      // Voices load asynchronously on first read in many browsers —
      // wait once for `voiceschanged` so the worker side doesn't get
      // an empty list on a cold session.
      const voices = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
        const onChange = () => {
          speechSynthesis.removeEventListener('voiceschanged', onChange);
          resolve(speechSynthesis.getVoices());
        };
        speechSynthesis.addEventListener('voiceschanged', onChange);
        // Belt-and-braces: bail out after 1s so a browser that never
        // fires the event doesn't hang the call until the bridge
        // timeout (which would surface as a confusing op error).
        setTimeout(() => {
          speechSynthesis.removeEventListener('voiceschanged', onChange);
          resolve(speechSynthesis.getVoices());
        }, 1000);
      });
      return { voices: [...kokoro, ...voices.map(toVoiceInfo)] };
    },

    // Enhanced-voice (kokoro) diagnostics + manual warmup for the worker-side
    // `say --status` / `say --warmup`, parallel to the `hear-*` ops. The
    // synthesis stack is dynamically imported so the page boot bundle stays
    // lean — kokoro (and its weights) only load once a warmup actually runs.
    'speak-status': async () => {
      const { kokoroStatus } = await import('../../speech/speak.js');
      return kokoroStatus();
    },

    'speak-warmup': async () => {
      const { kokoroWarmup } = await import('../../speech/speak.js');
      return kokoroWarmup();
    },

    // `say -o <file>` route: synthesize via kokoro and return WAV bytes for
    // the worker-side command to write into the VFS. Kokoro-only — Web Speech
    // has no capture API. The engine-ready + lang/voice eligibility gates
    // live inside `synthesizeToWav` itself so the worker float can't bypass
    // them by talking to this op directly; rejections surface as op errors
    // (caller maps to a non-zero exit + message).
    'synthesize-to-wav': async ({ text, lang, voice, rate }) => {
      const { synthesizeToWav } = await import('../../speech/speak.js');
      const wav = await synthesizeToWav({
        text,
        ...(lang !== undefined ? { lang } : {}),
        ...(voice !== undefined ? { voice } : {}),
        ...(rate !== undefined ? { rate } : {}),
      });
      // Detach to a fresh ArrayBuffer so the bridge transfers a clean buffer
      // (the Uint8Array may be a view over a larger underlying buffer).
      const buf = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
      return { bytes: buf };
    },

    'play-audio': async ({ bytes, volume }) => {
      if (typeof AudioContext === 'undefined') {
        throw new Error('Web Audio API is unavailable in this page');
      }
      const ctx = new AudioContext();
      try {
        const buffer = await ctx.decodeAudioData(bytes.slice(0));
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        if (volume !== undefined) {
          const gain = ctx.createGain();
          gain.gain.value = Math.max(0, Math.min(1, volume));
          src.connect(gain);
          gain.connect(ctx.destination);
        } else {
          src.connect(ctx.destination);
        }
        await new Promise<void>((resolve) => {
          src.onended = () => resolve();
          src.start();
        });
      } finally {
        try {
          await ctx.close();
        } catch {
          /* noop */
        }
      }
      return { done: true };
    },

    'play-chime': async ({ tone }) => {
      // Simple synthesized chime so chime/notify works without a VFS
      // file. Tone-coded for variants.
      const freqs: Record<string, [number, number]> = {
        success: [880, 1320],
        error: [440, 220],
        notify: [660, 660],
      };
      const [f1, f2] = freqs[tone ?? 'notify'] ?? freqs.notify;
      if (typeof AudioContext === 'undefined') {
        throw new Error('Web Audio API is unavailable in this page');
      }
      const ctx = new AudioContext();
      try {
        const start = ctx.currentTime;
        for (const [i, f] of [f1, f2].entries()) {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = f;
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.0001, start + i * 0.18);
          gain.gain.exponentialRampToValueAtTime(0.2, start + i * 0.18 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + i * 0.18 + 0.18);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(start + i * 0.18);
          osc.stop(start + i * 0.18 + 0.2);
        }
        await new Promise((r) => setTimeout(r, 450));
      } finally {
        try {
          await ctx.close();
        } catch {
          /* noop */
        }
      }
      return { done: true };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

/** Clipboard, window/popup, camera + media-device enumeration. */
export function buildClipboardCaptureHandlers(options: StandalonePanelRpcHandlerOptions = {}) {
  return {
    'clipboard-read-text': async () => {
      if (!navigator.clipboard?.readText) {
        throw new Error('clipboard API unavailable');
      }
      return { text: await navigator.clipboard.readText() };
    },

    'clipboard-write-text': async ({ text }) => {
      if (!navigator.clipboard?.writeText) {
        throw new Error('clipboard API unavailable');
      }
      await whenDocumentFocused();
      await navigator.clipboard.writeText(text);
      return { done: true };
    },

    'clipboard-write-image': async ({ bytes, mimeType }) => {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('clipboard image API unavailable');
      }
      let pngBlob: Blob;
      const src = new Blob([bytes], { type: mimeType });
      if (mimeType === 'image/png') {
        pngBlob = src;
      } else {
        pngBlob = await reencodeAsPng(src);
      }
      // The browser rejects `clipboard.write` with "Document is not
      // focused" when invoked while the page is in the background —
      // which is exactly what happens after the user picks a target
      // in the OS-level `getDisplayMedia` picker (focus stays on the
      // target window / screen). Defer the write until the page
      // regains focus so `screencapture -c` finishes silently when
      // the user comes back instead of failing right at the finish line.
      await whenDocumentFocused();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      return { done: true };
    },

    'window-open': async ({ url, target, features }) => {
      // `window.open` may return null in some contexts (extension
      // offscreen has been seen to do this for `_blank`). For
      // standalone the call succeeds; report what we observed so the
      // caller can decide how to handle it.
      const win = window.open(url, target ?? '_blank', features ?? 'noopener,noreferrer');
      return { opened: win !== null };
    },

    'oauth-popup': async ({ url }) => {
      // #1915: when the human is driving from a follower — or the leader is
      // headless — prompting here puts the login where nobody can click it.
      // Hand the visible half to that follower instead.
      const delegated = await options.delegateOAuthLogin?.(url);
      if (delegated?.delegated) {
        return { redirectUrl: delegated.redirectUrl, error: delegated.error };
      }
      const redirectUrl = await openOAuthPopup(url, options.getPermissionsSurface);
      return { redirectUrl };
    },

    'oauth-route': async () => ({ delegate: (await options.shouldDelegateOAuth?.()) === true }),

    'capture-camera': async (payload) => {
      const result = await captureCamera(payload);
      return result;
    },

    'enumerate-media-devices': async () => {
      if (!navigator.mediaDevices?.enumerateDevices) {
        throw new Error('enumerateDevices is not supported in this browser');
      }
      const all = await navigator.mediaDevices.enumerateDevices();
      const toInfo = (d: MediaDeviceInfo): { deviceId: string; label: string; groupId?: string } =>
        ({
          deviceId: d.deviceId,
          label: d.label || '',
          ...(d.groupId ? { groupId: d.groupId } : {}),
        }) as { deviceId: string; label: string; groupId?: string };
      return {
        videoinputs: all.filter((d) => d.kind === 'videoinput').map(toInfo),
        audioinputs: all.filter((d) => d.kind === 'audioinput').map(toInfo),
      };
    },

    // `hear` speech bridge: the worker has no mic/recognizer/AudioContext.
    // The speech stack is dynamically imported so the page boot bundle stays
    // lean — these modules (and the whisper engine they lazy-load) only ever
    // load once a speech op actually runs.
  } satisfies Partial<PanelRpcHandlers>;
}

/** `hear` speech bridge (capture / transcribe / status / warmup). */
export function buildHearHandlers() {
  return {
    'hear-capture': async (payload) => {
      const { hearCapture } = await import('../../speech/hear.js');
      return await hearCapture(payload ?? {});
    },

    'hear-transcribe': async ({ bytes, lang }) => {
      const { hearTranscribe } = await import('../../speech/hear.js');
      return await hearTranscribe(bytes, lang);
    },

    'hear-status': async () => {
      const { hearStatus } = await import('../../speech/hear.js');
      return hearStatus();
    },

    'hear-warmup': async () => {
      const { hearWarmup } = await import('../../speech/hear.js');
      return hearWarmup();
    },
  } satisfies Partial<PanelRpcHandlers>;
}

let screenEndedRelay: (() => void) | null = null;
let screenEndedEmit: ((channel: string, payload: unknown) => void) | undefined;

/**
 * Fan page-side display-share track ends (browser Stop sharing) to the
 * worker so `screen:` computers can mark `gone`. Rebinding `emitEvent`
 * does not stack listeners on the session store.
 */
export function ensureScreenSessionEndedRelay(
  emitEvent?: (channel: string, payload: unknown) => void
): void {
  screenEndedEmit = emitEvent;
  if (screenEndedRelay || !emitEvent) return;
  void import('../../shell/supplemental-commands/screencapture-media.js').then((m) => {
    if (screenEndedRelay) return;
    screenEndedRelay = m.displaySessions.onEnded((handle) => {
      screenEndedEmit?.(m.SCREENCAPTURE_SESSION_ENDED_CHANNEL, { handle });
    });
  });
}

// ── Camera capture (page-side) ──────────────────────────────────────

// Wire types live in kernel/panel-rpc-camera-types.ts so the kernel
// bundle no longer depends back on ui/. Re-exported from
// panel-rpc-handlers.ts for backward compatibility.
const DEFAULT_PHOTO_WARMUP_MS = 1500;

/**
 * Capture a single frame photo or a short clip from the webcam via
 * `getUserMedia`. Used by the `ffmpeg -f avfoundation` path so the
 * agent can grab webcam stills/clips without a native ffmpeg install.
 *
 * - Photo mode renders the first stable frame into a canvas and
 *   encodes via `canvas.toBlob(mimeType, quality)`.
 * - Video mode pipes the stream into a `MediaRecorder` for
 *   `durationMs` then resolves with the recorder's blob bytes.
 *
 * `deviceId` accepts either a numeric index ("0"/"1"/…) matching the
 * `enumerateDevices` order or a raw deviceId string. Numeric indexes
 * keep parity with macOS avfoundation's `-i "0"` notation; raw ids
 * let callers target a specific cam when they know its id ahead of
 * time. An unset `deviceId` lets the browser pick (usually the
 * facing-front cam).
 */
export async function captureCamera(req: CameraCaptureRequest): Promise<CameraCaptureResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia is not supported in this browser');
  }
  // Photo mode always needs a camera. Video mode defaults to camera-on
  // but honors an explicit `captureVideo: false` so callers can ask
  // for audio-only recordings (mic into a webm container) without
  // surfacing a camera-permission prompt or failing on camera-less
  // devices.
  const wantVideo = req.mode === 'photo' || req.captureVideo !== false;
  const wantAudio = !!req.captureAudio && req.mode === 'video';
  if (!wantVideo && !wantAudio) {
    throw new Error('camera capture: at least one of video or audio must be requested');
  }
  const resolvedDeviceId = wantVideo
    ? await resolveDeviceId(req.deviceId, 'videoinput')
    : undefined;
  const resolvedAudioId = wantAudio
    ? await resolveDeviceId(req.audioDeviceId, 'audioinput')
    : undefined;

  const stream = await getStreamWithFallback({
    wantVideo,
    videoDeviceId: resolvedDeviceId,
    audioDeviceId: resolvedAudioId,
    wantAudio,
    width: req.width,
    height: req.height,
    frameRate: req.frameRate,
    exact: !!req.exactSize,
  });

  try {
    // Only spin up an HTMLVideoElement when there's actually a video
    // track to display; audio-only recordings would otherwise hang on
    // `onloadedmetadata` waiting for dimensions that never arrive.
    let video: HTMLVideoElement | null = null;
    let width = 0;
    let height = 0;
    if (wantVideo) {
      video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      const v = video;
      await new Promise<void>((resolve, reject) => {
        v.onloadedmetadata = () =>
          v
            .play()
            .then(() => resolve())
            .catch(reject);
        v.onerror = () => reject(new Error('Failed to load camera stream'));
      });
      // Always wait at least two animation frames so the camera has
      // emitted a usable frame at all.
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      width = v.videoWidth;
      height = v.videoHeight;
    }

    if (req.mode === 'photo') {
      if (!video) throw new Error('photo capture requires a video track');
      // Auto-exposure / auto-white-balance on most webcams need
      // ~1–2s to converge after the stream opens. The previous
      // 2-RAF wait (~33ms) routinely produced a "dark first frame"
      // photo even when the room was well lit, because the sensor
      // was still ramping its gain. Honor an explicit `warmupMs`
      // override (caller may pass `0` for fast captures) and
      // default to a reasonable settle period otherwise.
      const warmupMs = req.warmupMs ?? DEFAULT_PHOTO_WARMUP_MS;
      if (warmupMs > 0) {
        await new Promise<void>((r) => setTimeout(r, warmupMs));
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to get canvas context');
      ctx.drawImage(video, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Failed to encode photo'))),
          req.mimeType,
          req.quality
        );
      });
      const buffer = await blob.arrayBuffer();
      return { bytes: buffer, mimeType: blob.type || req.mimeType, width, height };
    }

    // Video mode: record for durationMs, then resolve with the bytes.
    const durationMs = Math.max(100, Math.min(req.durationMs ?? 5000, 60_000));
    const supported =
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(req.mimeType)
        ? req.mimeType
        : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType: supported });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start();
    await new Promise<void>((r) => setTimeout(r, durationMs));
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: supported });
    const buffer = await blob.arrayBuffer();
    return {
      bytes: buffer,
      mimeType: blob.type || supported,
      width,
      height,
      durationMs,
    };
  } finally {
    stream.getTracks().forEach((t) => {
      t.stop();
    });
  }
}

/**
 * Resolve an avfoundation-style numeric index OR a raw deviceId
 * against the live `enumerateDevices` list. `kind` filters to
 * `videoinput` or `audioinput` so the index matches the per-kind
 * ordering ffmpeg's avfoundation emits in `-list_devices`.
 */
async function resolveDeviceId(
  idOrIndex: string | undefined,
  kind: 'videoinput' | 'audioinput'
): Promise<string | undefined> {
  if (idOrIndex === undefined || idOrIndex === '') return undefined;
  if (!/^\d+$/.test(idOrIndex)) return idOrIndex;
  if (!navigator.mediaDevices?.enumerateDevices) return undefined;
  const idx = parseInt(idOrIndex, 10);
  const all = await navigator.mediaDevices.enumerateDevices();
  const filtered = all.filter((d) => d.kind === kind);
  return filtered[idx]?.deviceId;
}

interface StreamSpec {
  wantVideo: boolean;
  videoDeviceId: string | undefined;
  audioDeviceId: string | undefined;
  wantAudio: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
  exact: boolean;
}

/**
 * Resolve a `getUserMedia` stream honoring `exactSize` if requested,
 * with a fallback to `ideal:` constraints when the camera can't
 * deliver the exact dimensions. The fallback writes to `console.warn`
 * so the page-side handler keeps a single log surface; callers that
 * forward warnings to the agent (the ffmpeg command) infer the
 * downgrade from the resulting track settings.
 */
async function getStreamWithFallback(spec: StreamSpec): Promise<MediaStream> {
  const buildVideo = (mode: 'exact' | 'ideal'): MediaTrackConstraints | boolean => {
    if (!spec.wantVideo) return false;
    const c: MediaTrackConstraints = {};
    if (spec.videoDeviceId) c.deviceId = { exact: spec.videoDeviceId };
    if (spec.width) c.width = mode === 'exact' ? { exact: spec.width } : { ideal: spec.width };
    if (spec.height) c.height = mode === 'exact' ? { exact: spec.height } : { ideal: spec.height };
    if (spec.frameRate)
      c.frameRate = mode === 'exact' ? { exact: spec.frameRate } : { ideal: spec.frameRate };
    return Object.keys(c).length > 0 ? c : true;
  };
  const audioConstraint = (): MediaTrackConstraints | boolean => {
    if (!spec.wantAudio) return false;
    if (spec.audioDeviceId) return { deviceId: { exact: spec.audioDeviceId } };
    return true;
  };

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: buildVideo(spec.exact ? 'exact' : 'ideal'),
      audio: audioConstraint(),
    });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (!spec.exact || (name !== 'OverconstrainedError' && name !== 'NotReadableError')) {
      throw err;
    }
    // Exact requirements unmet — retry with `ideal:` so the user
    // still gets a stream rather than a hard fail. The track-side
    // dimensions will be visible to the caller via `videoWidth`.
    console.warn(
      `panel-rpc:capture-camera: exact ${spec.width ?? '?'}x${spec.height ?? '?'}@${spec.frameRate ?? '?'} unmet, falling back to ideal`
    );
    return await navigator.mediaDevices.getUserMedia({
      video: buildVideo('ideal'),
      audio: audioConstraint(),
    });
  }
}

// ── Internal helpers ────────────────────────────────────────────────

function toVoiceInfo(v: SpeechSynthesisVoice): {
  name: string;
  lang: string;
  default: boolean;
  onDevice: boolean;
} {
  // Web Speech voices never play on-device (Kokoro); only kokoro voice infos
  // carry an on-device flag.
  return { name: v.name, lang: v.lang, default: v.default, onDevice: false };
}

async function reencodeAsPng(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image for clipboard conversion'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get canvas context');
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('PNG re-encode failed'))),
        'image/png'
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Resolve when the document is focused so a follow-up `navigator.clipboard.*`
 * call doesn't reject with "Document is not focused". Common trigger: the
 * `getDisplayMedia` OS picker hands focus to the selected target window /
 * screen, leaving the SLICC tab in the background while the agent tries to
 * finish the capture pipeline.
 *
 * - Resolves immediately when the page is already focused.
 * - Otherwise listens for the next `focus` event on `window` and resolves
 *   then. A `visibilitychange` listener covers the case where the tab is
 *   reactivated without firing a window focus event (e.g. switching back
 *   from another tab via Cmd-Tab).
 * - Bails out after `timeoutMs` so a forgotten capture doesn't hang the
 *   command forever; the caller surfaces the timeout as a clipboard error
 *   the user can act on.
 */
async function whenDocumentFocused(timeoutMs = 5 * 60_000): Promise<void> {
  if (typeof document === 'undefined') return;
  // Treat a missing `hasFocus` (lightweight test stubs) as already
  // focused so we don't wedge tests that don't bother mocking it.
  if (typeof document.hasFocus !== 'function') return;
  if (document.hasFocus()) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(timer);
    };
    const onFocus = () => {
      if (document.hasFocus()) {
        cleanup();
        resolve();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for window focus'));
    }, timeoutMs);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
  });
}
