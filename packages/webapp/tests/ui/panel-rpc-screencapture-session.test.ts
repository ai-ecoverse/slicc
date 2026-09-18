import { describe, expect, it, vi } from 'vitest';
import { createStandalonePanelRpcHandlers } from '../../src/ui/panel-rpc-handlers.js';

const { mockCapture } = vi.hoisted(() => ({ mockCapture: vi.fn() }));

vi.mock('../../src/shell/supplemental-commands/screencapture-media.js', async () => {
  const shared = await import(
    '../../src/shell/supplemental-commands/screencapture-media-shared.js'
  );
  return {
    captureDisplayMedia: mockCapture,
    sessionCaptureRequest: shared.sessionCaptureRequest,
  };
});

describe('screencapture panel-RPC session op', () => {
  it('start returns a handle and frame/stop pass it through', async () => {
    const handlers = createStandalonePanelRpcHandlers({});
    const op = handlers.screencapture;
    expect(op).toBeTypeOf('function');

    mockCapture.mockResolvedValueOnce({
      bytes: new Uint8Array(0),
      mimeType: 'application/octet-stream',
      width: 1920,
      height: 1080,
      handle: 'screen1',
    });
    const started = await op!({
      mimeType: 'image/jpeg',
      quality: 0.7,
      mode: 'session',
      session: 'start',
    });
    expect(started.handle).toBe('screen1');
    expect(started.width).toBe(1920);
    expect(mockCapture).toHaveBeenCalledWith({ mode: 'session', action: 'start' });

    mockCapture.mockResolvedValueOnce({
      bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
      mimeType: 'image/jpeg',
      width: 768,
      height: 432,
    });
    const frame = await op!({
      mimeType: 'image/jpeg',
      quality: 0.7,
      mode: 'session',
      session: 'frame',
      handle: 'screen1',
      maxWidth: 768,
    });
    expect(frame.width).toBe(768);
    expect(mockCapture).toHaveBeenCalledWith({
      mode: 'session',
      action: 'frame',
      handle: 'screen1',
      maxWidth: 768,
      mimeType: 'image/jpeg',
      quality: 0.7,
    });

    mockCapture.mockResolvedValueOnce({
      bytes: new Uint8Array(0),
      mimeType: 'application/octet-stream',
      width: 0,
      height: 0,
      handle: 'screen1',
    });
    const stopped = await op!({
      mimeType: 'image/jpeg',
      quality: 0.7,
      mode: 'session',
      session: 'stop',
      handle: 'screen1',
    });
    expect(stopped.handle).toBe('screen1');
    expect(mockCapture).toHaveBeenCalledWith({
      mode: 'session',
      action: 'stop',
      handle: 'screen1',
    });
  });

  it('record points MediaRecorder at the live session track', async () => {
    mockCapture.mockResolvedValueOnce({
      bytes: Uint8Array.of(1, 2, 3),
      mimeType: 'video/webm',
      width: 1280,
      height: 720,
      durationMs: 1_500,
    });
    const handlers = createStandalonePanelRpcHandlers({});
    const result = await handlers.screencapture!({
      mimeType: 'video/webm',
      quality: 0.7,
      mode: 'session',
      session: 'record',
      handle: 'screen1',
      durationMs: 1_500,
    });
    expect(result.durationMs).toBe(1_500);
    expect(mockCapture).toHaveBeenCalledWith({
      mode: 'session',
      action: 'record',
      handle: 'screen1',
      durationMs: 1_500,
      mimeType: 'video/webm',
    });
  });
});
