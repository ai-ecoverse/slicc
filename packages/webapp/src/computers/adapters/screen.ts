/**
 * Page-hosted display-share computer. Always bridged: the kernel worker
 * has no `getDisplayMedia`. Session start lives on the page (gesture +
 * `--__resolved` / approval card); this adapter only frames, records, and
 * stops an existing session handle over panel-RPC.
 */

import type {
  ComputerCapabilities,
  ComputerDescriptor,
  ComputerFrame,
  ComputerInputEvent,
  ComputerState,
} from '@slicc/shared-ts';
import type { PanelRpcClient } from '../../kernel/panel-rpc.js';
import { PANEL_RPC_DEFAULT_TIMEOUT_MS } from '../../kernel/panel-rpc.js';
import {
  clampVideoDurationMs,
  SCREENCAPTURE_SESSION_ENDED_CHANNEL,
} from '../../shell/supplemental-commands/screencapture-media-shared.js';
import type { ComputerBackend, ComputerScreenshotOpts } from '../backend.js';

export function screenComputerId(handle: string): string {
  return `screen:${handle}`;
}

const CAPABILITIES: ComputerCapabilities = {
  screenshot: true,
  text: false,
  frames: 'poll',
  keyboard: false,
  mouse: 'none',
  scroll: false,
  exec: false,
  inputAllowed: false,
};

export interface ScreenClip {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  durationMs?: number;
}

function frameMime(mimeType: string): 'image/jpeg' | 'image/png' {
  return mimeType.includes('png') ? 'image/png' : 'image/jpeg';
}

function bytesFromRpc(bytes: ArrayBuffer): Uint8Array {
  return new Uint8Array(bytes);
}

function endedHandle(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const handle = Object.getOwnPropertyDescriptor(payload, 'handle')?.value;
  return typeof handle === 'string' ? handle : null;
}

export class BridgedScreenComputerBackend implements ComputerBackend {
  private seq = 0;
  private title: string;
  private size: { width: number; height: number } | null;
  private state: ComputerState = 'live';
  private readonly offEnded: () => void;

  constructor(
    private readonly rpc: PanelRpcClient,
    readonly handle: string,
    info: { title: string; width?: number; height?: number } = { title: handle },
    private readonly onGone?: () => void
  ) {
    this.title = info.title;
    this.size =
      info.width && info.height && info.width > 0 && info.height > 0
        ? { width: info.width, height: info.height }
        : null;
    this.offEnded = rpc.onEvent
      ? rpc.onEvent(SCREENCAPTURE_SESSION_ENDED_CHANNEL, (payload) => {
          if (endedHandle(payload) === this.handle) this.markGone();
        })
      : () => undefined;
  }

  describe(): ComputerDescriptor {
    return {
      id: screenComputerId(this.handle),
      kind: 'screen',
      title: this.title,
      size: this.size,
      state: this.state,
      capabilities: CAPABILITIES,
      pid: null,
    };
  }

  async screenshot(opts: ComputerScreenshotOpts): Promise<ComputerFrame> {
    let result: {
      bytes: ArrayBuffer;
      width: number;
      height: number;
      mimeType: string;
    };
    try {
      result = await this.rpc.call('screencapture', {
        mimeType: opts.format === 'png' ? 'image/png' : 'image/jpeg',
        quality: 0.7,
        mode: 'session',
        session: 'frame',
        handle: this.handle,
        maxWidth: opts.maxWidth,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('no screen-share session')) this.markGone();
      throw err;
    }
    if (result.width > 0 && result.height > 0) {
      this.size = { width: result.width, height: result.height };
    }
    this.seq += 1;
    return {
      seq: this.seq,
      mime: frameMime(result.mimeType),
      width: result.width,
      height: result.height,
      bytes: bytesFromRpc(result.bytes),
    };
  }

  async input(_events: ComputerInputEvent[]): Promise<void> {
    throw new Error('input is not allowed');
  }

  /**
   * Timed clip from the live session track (no second picker). Timeout is
   * clip length plus the default RPC budget so a 60s record is not killed
   * by the 15s panel-RPC default.
   */
  async recordClip(durationMs: number): Promise<ScreenClip> {
    const clamped = clampVideoDurationMs(durationMs);
    const result = await this.rpc.call(
      'screencapture',
      {
        mimeType: 'video/webm',
        quality: 1,
        mode: 'session',
        session: 'record',
        handle: this.handle,
        durationMs: clamped,
      },
      { timeoutMs: clamped + PANEL_RPC_DEFAULT_TIMEOUT_MS }
    );
    return {
      bytes: bytesFromRpc(result.bytes),
      mime: result.mimeType || 'video/webm',
      width: result.width,
      height: result.height,
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    };
  }

  async close(): Promise<void> {
    this.offEnded();
    try {
      await this.rpc.call('screencapture', {
        mimeType: 'application/octet-stream',
        quality: 1,
        mode: 'session',
        session: 'stop',
        handle: this.handle,
      });
    } catch {
      /* page may already have ended the tracks */
    }
  }

  private markGone(): void {
    if (this.state === 'gone') return;
    this.state = 'gone';
    this.onGone?.();
  }
}
