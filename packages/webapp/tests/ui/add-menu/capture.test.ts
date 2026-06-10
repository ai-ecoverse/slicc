// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { grabFrameToFile } from '../../../src/ui/add-menu/capture.js';

function fakeStream() {
  const track = { stop: vi.fn() };
  return { getTracks: () => [track], _track: track } as never;
}

describe('grabFrameToFile', () => {
  beforeEach(() => {
    (HTMLCanvasElement.prototype as unknown as { toBlob: unknown }).toBlob = function (
      cb: (b: Blob | null) => void
    ) {
      cb(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    };
    // jsdom does not implement getContext; provide a minimal stub so the
    // null-context guard does not short-circuit the draw → toBlob path.
    (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = () => ({
      drawImage: () => {},
    });
  });

  it('draws the video frame, returns a File, and stops all tracks', async () => {
    const stream = fakeStream();
    const video = document.createElement('video');
    Object.defineProperty(video, 'videoWidth', { value: 4, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 4, configurable: true });
    const file = await grabFrameToFile(stream, video, 'screenshot');
    expect(file).toBeInstanceOf(File);
    expect(file?.type).toBe('image/png');
    expect(file?.name).toMatch(/^screenshot-/);
    expect(
      (stream as unknown as { _track: { stop: ReturnType<typeof vi.fn> } })._track.stop
    ).toHaveBeenCalled();
  });

  it('returns null and stops tracks when the canvas 2d context is unavailable', async () => {
    const stream = fakeStream();
    const video = document.createElement('video');
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = () => null;
    try {
      const result = await grabFrameToFile(stream, video, 'screenshot');
      expect(result).toBeNull();
      expect(
        (stream as unknown as { _track: { stop: ReturnType<typeof vi.fn> } })._track.stop
      ).toHaveBeenCalled();
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetContext;
    }
  });
});
