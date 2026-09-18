/**
 * Wire types for the `computer` protocol — every screen the agent can look
 * at and poke (v86, tabs, jsh-hosted backends, later screen/ssh/url).
 *
 * Shared with Cherry, node-server, cloud, and followers so a descriptor
 * that crosses the tray channel is the same shape the kernel registry
 * emits. See `docs/computer-protocol.md`.
 */

export type ComputerKind = 'v86' | 'tab' | 'screen' | 'ssh' | 'url' | 'vnc' | 'jsh';

export type ComputerState = 'starting' | 'live' | 'paused' | 'gone';

export type ComputerMouseKind = 'absolute' | 'relative' | 'touch' | 'none';

export type ComputerFramePush = 'push' | 'poll' | 'none';

export interface ComputerSize {
  width: number;
  height: number;
}

export interface ComputerCapabilities {
  screenshot: boolean;
  text: boolean;
  frames: ComputerFramePush;
  keyboard: boolean;
  mouse: ComputerMouseKind;
  scroll: boolean;
  exec: boolean;
  inputAllowed: boolean;
}

export interface ComputerSoftKey {
  label: string;
  keysym: string;
}

/** Scale of the last screenshot the model saw for this computer. */
export interface ComputerLastShot {
  width: number;
  height: number;
  scale: number;
  at: number;
}

export interface ComputerDescriptor {
  id: string;
  kind: ComputerKind;
  title: string;
  size: ComputerSize | null;
  state: ComputerState;
  capabilities: ComputerCapabilities;
  pid: number | null;
  softKeys?: ComputerSoftKey[];
  lastShot?: ComputerLastShot;
}

export type ComputerMouseButton = 1 | 2 | 3;

export type ComputerInputEvent =
  | { type: 'mousemove'; x: number; y: number; relative?: boolean }
  | { type: 'button'; button: ComputerMouseButton; down: boolean; x?: number; y?: number }
  | {
      type: 'click';
      button: ComputerMouseButton;
      count: number;
      holdMs?: number;
      x?: number;
      y?: number;
    }
  | { type: 'scroll'; dx: number; dy: number; x?: number; y?: number }
  | { type: 'drag'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'key'; keysym: string; down?: boolean }
  | { type: 'text'; text: string }
  | { type: 'wait'; ms: number };

export type ComputerFrameMime = 'image/png' | 'image/jpeg';

export interface ComputerFrame {
  seq: number;
  mime: ComputerFrameMime;
  width: number;
  height: number;
  bytes: Uint8Array;
  /** Encoded pixels are wider than the requested maxWidth (resample unavailable). */
  overCap?: boolean;
}

export interface ComputerScreenshotOpts {
  format: 'png' | 'jpeg';
  maxWidth?: number;
  /** Adapters that issue HTTP must abort the in-flight request when this fires. */
  signal?: AbortSignal;
}

export interface ComputerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
