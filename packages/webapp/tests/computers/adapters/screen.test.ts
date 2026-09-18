import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BridgedScreenComputerBackend,
  screenComputerId,
} from '../../../src/computers/adapters/screen.js';
import { MINIMAL_JPEG } from '../../../src/computers/encode-frame.js';
import { PANEL_RPC_DEFAULT_TIMEOUT_MS } from '../../../src/kernel/panel-rpc.js';

function jpegBuffer(): ArrayBuffer {
  const copy = new ArrayBuffer(MINIMAL_JPEG.byteLength);
  new Uint8Array(copy).set(MINIMAL_JPEG);
  return copy;
}

describe('screen adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds screen:<handle> ids and poll-only capabilities', () => {
    expect(screenComputerId('screen1')).toBe('screen:screen1');
    const rpc = { call: vi.fn() };
    const backend = new BridgedScreenComputerBackend(rpc as never, 'screen1', {
      title: 'Desk',
      width: 1920,
      height: 1080,
    });
    const d = backend.describe();
    expect(d).toMatchObject({
      id: 'screen:screen1',
      kind: 'screen',
      title: 'Desk',
      size: { width: 1920, height: 1080 },
      capabilities: {
        screenshot: true,
        keyboard: false,
        mouse: 'none',
        inputAllowed: false,
        frames: 'poll',
      },
    });
  });

  it('screenshots via session frame RPC and stops tracks on close', async () => {
    const call = vi.fn(async (op: string, payload: { session?: string }) => {
      expect(op).toBe('screencapture');
      if (payload.session === 'frame') {
        return {
          bytes: jpegBuffer(),
          width: 768,
          height: 432,
          mimeType: 'image/jpeg',
        };
      }
      return {
        bytes: new ArrayBuffer(0),
        width: 0,
        height: 0,
        mimeType: 'application/octet-stream',
        handle: 'screen1',
      };
    });
    const backend = new BridgedScreenComputerBackend({ call } as never, 'screen1', {
      title: 'Desk',
    });
    const frame = await backend.screenshot({ format: 'jpeg', maxWidth: 768 });
    expect(frame).toMatchObject({ seq: 1, mime: 'image/jpeg', width: 768, height: 432 });
    expect(call).toHaveBeenCalledWith(
      'screencapture',
      expect.objectContaining({
        mode: 'session',
        session: 'frame',
        handle: 'screen1',
        maxWidth: 768,
      })
    );
    await backend.close();
    expect(call).toHaveBeenCalledWith(
      'screencapture',
      expect.objectContaining({ session: 'stop', handle: 'screen1' })
    );
  });

  it('records a clip with timeout = duration + default RPC budget', async () => {
    const webm = new Uint8Array([1, 2, 3, 4]);
    const call = vi.fn(async () => ({
      bytes: webm.buffer.slice(webm.byteOffset, webm.byteOffset + webm.byteLength),
      width: 640,
      height: 360,
      mimeType: 'video/webm',
      durationMs: 5_000,
    }));
    const backend = new BridgedScreenComputerBackend({ call } as never, 'screen1');
    const clip = await backend.recordClip(5_000);
    expect(clip).toMatchObject({
      mime: 'video/webm',
      width: 640,
      height: 360,
      durationMs: 5_000,
    });
    expect(call).toHaveBeenCalledWith(
      'screencapture',
      expect.objectContaining({
        mode: 'session',
        session: 'record',
        handle: 'screen1',
        durationMs: 5_000,
      }),
      { timeoutMs: 5_000 + PANEL_RPC_DEFAULT_TIMEOUT_MS }
    );
  });

  it('refuses input at the adapter', async () => {
    const backend = new BridgedScreenComputerBackend({ call: vi.fn() } as never, 'screen1');
    await expect(backend.input([{ type: 'wait', ms: 1 }])).rejects.toThrow('input is not allowed');
  });

  it('swallows stop failures on close', async () => {
    const call = vi.fn(async () => {
      throw new Error('already gone');
    });
    const backend = new BridgedScreenComputerBackend({ call } as never, 'screen1');
    await expect(backend.close()).resolves.toBeUndefined();
  });
});
