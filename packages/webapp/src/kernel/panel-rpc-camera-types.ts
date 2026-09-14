export interface CameraCaptureRequest {
  mode: 'photo' | 'video';
  deviceId?: string;

  audioDeviceId?: string;

  captureAudio?: boolean;

  captureVideo?: boolean;
  width?: number;
  height?: number;
  frameRate?: number;

  exactSize?: boolean;
  mimeType: string;
  quality?: number;
  durationMs?: number;

  warmupMs?: number;
}

export interface CameraCaptureResult {
  bytes: ArrayBuffer;
  mimeType: string;
  width: number;
  height: number;
  durationMs?: number;
}
