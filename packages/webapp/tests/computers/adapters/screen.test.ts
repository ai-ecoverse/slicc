import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BridgedScreenComputerBackend,
  screenComputerId,
} from '../../../src/computers/adapters/screen.js';
import { MINIMAL_JPEG } from '../../../src/computers/encode-frame.js';
import { PANEL_RPC_DEFAULT_TIMEOUT_MS } from '../../../src/kernel/panel-rpc.js';
import { SCREENCAPTURE_SESSION_ENDED_CHANNEL } from '../../../src/shell/supplemental-commands/screencapture-media-shared.js';

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

  it('publishes the source size, not whichever consumer captured last (#3384)', async () => {
    const call = vi.fn(async (_op: string, payload: { maxWidth?: number }) => {
      const width = payload.maxWidth ?? 5120;
      return {
        bytes: jpegBuffer(),
        width,
        height: Math.round((width * 9) / 16),
        nativeWidth: 5120,
        nativeHeight: 2880,
        mimeType: 'image/jpeg',
      };
    });
    const backend = new BridgedScreenComputerBackend({ call } as never, 'screen1');
    expect(backend.describe().size).toBeNull();
    const agent = await backend.screenshot({ format: 'jpeg', maxWidth: 768 });
    expect(agent).toMatchObject({ width: 768, height: 432 });
    expect(backend.describe().size).toEqual({ width: 5120, height: 2880 });
    const thumb = await backend.screenshot({ format: 'jpeg', maxWidth: 480 });
    expect(thumb).toMatchObject({ width: 480, height: 270 });
    expect(backend.describe().size).toEqual({ width: 5120, height: 2880 });
  });

  it('keeps the known size when a frame carries no source dims', async () => {
    const call = vi.fn(async () => ({
      bytes: jpegBuffer(),
      width: 480,
      height: 270,
      mimeType: 'image/jpeg',
    }));
    const backend = new BridgedScreenComputerBackend({ call } as never, 'screen1', {
      title: 'Desk',
      width: 1920,
      height: 1080,
    });
    await backend.screenshot({ format: 'jpeg', maxWidth: 480 });
    expect(backend.describe().size).toEqual({ width: 1920, height: 1080 });
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

  it('marks gone when the page reports the session ended', () => {
    const handlers: Array<(payload: unknown) => void> = [];
    const onGone = vi.fn();
    const rpc = {
      call: vi.fn(),
      onEvent: (channel: string, handler: (payload: unknown) => void) => {
        expect(channel).toBe(SCREENCAPTURE_SESSION_ENDED_CHANNEL);
        handlers.push(handler);
        return () => undefined;
      },
    };
    const backend = new BridgedScreenComputerBackend(
      rpc as never,
      'screen1',
      { title: 'Desk' },
      onGone
    );
    expect(backend.describe().state).toBe('live');
    handlers[0]?.({ handle: 'other' });
    expect(backend.describe().state).toBe('live');
    handlers[0]?.({ handle: 'screen1' });
    expect(backend.describe().state).toBe('gone');
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('marks gone when a screenshot finds no session', async () => {
    const rpc = {
      call: vi.fn(async () => {
        throw new Error("no screen-share session 'screen1'");
      }),
      onEvent: () => () => undefined,
    };
    const backend = new BridgedScreenComputerBackend(rpc as never, 'screen1');
    await expect(backend.screenshot({ format: 'jpeg' })).rejects.toThrow('no screen-share session');
    expect(backend.describe().state).toBe('gone');
  });
});
