/**
 * Page-side handlers for the panel-RPC bridge defined in
 * `kernel/panel-rpc.ts`. The kernel worker has no DOM, no
 * `mediaDevices`, no `clipboard`, and no `speechSynthesis`/`AudioContext`
 * — these handlers run in the page context and execute the actual
 * browser-API calls on behalf of worker-side supplemental commands.
 *
 * Wired from `mainStandaloneWorker` after the orchestrator boot
 * handshake; the extension float doesn't use this module because its
 * offscreen document already has a DOM.
 */

import type { PanelRpcHandlers } from '../kernel/panel-rpc.js';
import type { LeaderTrayRuntimeStatus } from '../scoops/tray-leader.js';

/**
 * Options threaded into the handler factory. Each callback is optional
 * — the corresponding op rejects with a clear error when the callback
 * is absent (e.g. tray-reset before the leader tray has booted).
 */
export interface StandalonePanelRpcHandlerOptions {
  /**
   * Reset the page-side leader tray and return the post-reset status.
   * Wired by `mainStandaloneWorker` to `pageLeaderTray.reset()` when
   * a leader is active; left undefined otherwise.
   */
  resetTray?: () => Promise<LeaderTrayRuntimeStatus>;
}

/**
 * Build a record of handlers suitable for `installPanelRpcHandler`.
 * Pure factory so the handler set is easy to test under JSDOM.
 */
export function createStandalonePanelRpcHandlers(
  options: StandalonePanelRpcHandlerOptions = {}
): PanelRpcHandlers {
  return {
    'page-info': () => ({
      origin: window.location.origin,
      href: window.location.href,
      title: document.title || '',
    }),

    screencapture: async ({ mimeType, quality }) => {
      const blob = await captureScreen(mimeType, quality);
      const buffer = await blob.arrayBuffer();
      // Recover dimensions for the agent's reference. Decoding to an
      // <img> just to read its natural size is the cheapest path that
      // works for every blob type the browser emits via toBlob().
      const dims = await readBlobDimensions(blob);
      return {
        bytes: buffer,
        width: dims.width,
        height: dims.height,
        mimeType,
      };
    },

    'speak-text': async ({ text, lang, voice, rate, pitch, volume }) => {
      if (typeof speechSynthesis === 'undefined') {
        throw new Error('speechSynthesis is unavailable in this page');
      }
      await new Promise<void>((resolve, reject) => {
        const u = new SpeechSynthesisUtterance(text);
        if (lang !== undefined) u.lang = lang;
        if (rate !== undefined) u.rate = rate;
        if (pitch !== undefined) u.pitch = pitch;
        if (volume !== undefined) u.volume = volume;
        if (voice) {
          const match = speechSynthesis.getVoices().find((v) => v.name === voice);
          if (match) u.voice = match;
        }
        u.onend = () => resolve();
        u.onerror = (ev) => reject(new Error(`speak: ${ev.error || 'utterance failed'}`));
        speechSynthesis.speak(u);
      });
      return { done: true };
    },

    'list-voices': async () => {
      if (typeof speechSynthesis === 'undefined') {
        throw new Error('speechSynthesis is unavailable in this page');
      }
      const ready = speechSynthesis.getVoices();
      if (ready.length > 0) return { voices: ready.map(toVoiceInfo) };
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
      return { voices: voices.map(toVoiceInfo) };
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
      const redirectUrl = await openOAuthPopup(url);
      return { redirectUrl };
    },

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

    'tray-reset': async () => {
      if (!options.resetTray) {
        throw new Error('host reset: no active tray session to reset');
      }
      return await options.resetTray();
    },
  };
}

// ── Camera capture (page-side) ──────────────────────────────────────

export interface CameraCaptureRequest {
  mode: 'photo' | 'video';
  deviceId?: string;
  /**
   * Numeric index ("0"/"1"/…) into the audioinput enumeration OR a
   * raw deviceId. Only consulted when `captureAudio` is truthy and
   * the mode is `video`.
   */
  audioDeviceId?: string;
  /** Include the mic track on a video recording. Ignored for photos. */
  captureAudio?: boolean;
  /**
   * Open a video track on the stream. Defaults to true. Set to
   * false for audio-only video captures so `getUserMedia` doesn't
   * request a camera (avoiding the camera-permission prompt and
   * NotFoundError on devices with no webcam).
   */
  captureVideo?: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
  /**
   * When true, use `exact:` constraints for width/height/frameRate
   * so the browser fails fast instead of silently downscaling. The
   * caller catches the resulting `OverconstrainedError` and falls
   * back to `ideal:` constraints with a stderr warning.
   */
  exactSize?: boolean;
  mimeType: string;
  quality?: number;
  durationMs?: number;
  /**
   * Photo mode: ms to let the sensor's auto-exposure / auto-white-
   * balance settle before grabbing the frame. Webcams typically need
   * 1–2s after the stream opens before the AE algorithm converges;
   * skipping the warmup yields a noticeably dark first frame. Caller
   * may pass `0` to opt out for "fast" captures.
   */
  warmupMs?: number;
}

export interface CameraCaptureResult {
  bytes: ArrayBuffer;
  mimeType: string;
  width: number;
  height: number;
  durationMs?: number;
}

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
    stream.getTracks().forEach((t) => t.stop());
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

// ── OAuth popup (page-side) ─────────────────────────────────────────

/**
 * Open an OAuth popup and wait for the /auth/callback page to
 * postMessage the redirect URL back. Mirrors `launchOAuthCli` from
 * `oauth-service.ts` but runs inside a panel-RPC handler so worker-
 * side commands (e.g. `oauth-token adobe`, `silentRenewToken`) can
 * reach `window.open` through the bridge.
 *
 * Electron-overlay mode: window.opener is null (system browser opens),
 * so postMessage doesn't work. The callback POSTs to /api/oauth-result
 * and we poll until we get a result.
 */
function openOAuthPopup(authorizeUrl: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const popup = window.open(authorizeUrl, '_blank', 'width=500,height=700,popup=yes');

    let resolved = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
    };

    const handler = (event: MessageEvent) => {
      if (event.data?.type !== 'oauth-callback') return;
      // Only accept messages from the same origin (the /auth/callback page)
      // and from the popup window we opened. This prevents spoofing by
      // arbitrary frames or cross-origin windows.
      if (event.origin !== window.location.origin) return;
      if (popup && event.source !== popup) return;
      cleanup();
      if (event.data.error) {
        console.error('[panel-rpc:oauth-popup] OAuth error:', event.data.error);
        resolve(null);
        return;
      }
      const redirectUrl = event.data.redirectUrl;
      if (typeof redirectUrl !== 'string' && redirectUrl !== null && redirectUrl !== undefined)
        return;
      resolve(redirectUrl ?? null);
    };

    window.addEventListener('message', handler);

    const isElectronOverlay =
      location.pathname.startsWith('/electron') ||
      new URLSearchParams(location.search).get('runtime') === 'electron-overlay';
    if (isElectronOverlay) {
      pollTimer = setInterval(async () => {
        if (resolved) return;
        try {
          const res = await fetch('/api/oauth-result');
          if (res.status === 204) return;
          const data = (await res.json()) as { redirectUrl?: string; error?: string };
          if (resolved) return;
          cleanup();
          if (data.error) {
            console.error('[panel-rpc:oauth-popup] Server relay OAuth error:', data.error);
            resolve(null);
            return;
          }
          resolve(data.redirectUrl ?? null);
        } catch {
          /* keep polling */
        }
      }, 1000);
    }

    const timer = setTimeout(() => {
      cleanup();
      try {
        popup?.close();
      } catch {
        /* best-effort */
      }
      resolve(null);
    }, 120_000);
  });
}

// ── Internal helpers ────────────────────────────────────────────────

function toVoiceInfo(v: SpeechSynthesisVoice): { name: string; lang: string; default: boolean } {
  return { name: v.name, lang: v.lang, default: v.default };
}

async function captureScreen(mimeType: string, quality: number): Promise<Blob> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('screen capture is not supported in this browser');
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () =>
        video
          .play()
          .then(() => resolve())
          .catch(reject);
      video.onerror = () => reject(new Error('Failed to load video stream'));
    });
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const width = video.videoWidth;
    const height = video.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get canvas context');
    ctx.drawImage(video, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Failed to create image blob'))),
        mimeType,
        quality
      );
    });
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

async function readBlobDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to decode capture'));
      img.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
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
