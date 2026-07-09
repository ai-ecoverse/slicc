/**
 * Wire types for the `capture-camera` panel-RPC op. These live at the
 * kernel layer so both the worker-side op surface (`panel-rpc.ts`) and
 * the page-side handler (`ui/panel-rpc-handlers.ts`) — plus shell
 * commands like `ffmpeg` — can share one definition without the kernel
 * bundle depending back on `ui/`.
 */

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
