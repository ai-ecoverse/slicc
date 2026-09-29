// @vitest-environment jsdom
/**
 * Pins that sprinkle `captureScreen` acquires display media through the
 * leader `<slicc-permissions>` surface when mounted (#3604), so the Allow
 * click supplies the user gesture the sprinkle→leader postMessage hop
 * otherwise drops. Sibling of the #3574 screenshare prompt routing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const surfaceMock = vi.hoisted(() => ({
  request: vi.fn(),
  prompt: vi.fn(),
}));

const surfaceHolder = vi.hoisted(() => ({ value: surfaceMock as typeof surfaceMock | null }));

vi.mock('../../src/ui/wc/wc-permissions-registry.js', () => ({
  getLeaderPermissionsSurface: () => surfaceHolder.value,
}));

import { acquireSprinkleCaptureStream } from '../../src/ui/sprinkle-manager.js';

function makeStream(): MediaStream {
  return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
}

describe('acquireSprinkleCaptureStream', () => {
  beforeEach(() => {
    surfaceHolder.value = surfaceMock;
    surfaceMock.request.mockReset();
    surfaceMock.prompt.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes through surface.request("screenshare") when the permissions surface is mounted', async () => {
    const stream = makeStream();
    surfaceMock.request.mockResolvedValueOnce({ kind: 'screenshare', stream });

    const got = await acquireSprinkleCaptureStream();

    expect(got).toBe(stream);
    expect(surfaceMock.request).toHaveBeenCalledWith('screenshare', {
      constraints: { video: true, audio: false },
    });
  });

  it('rejects when the user cancels / denies the screenshare Grant prompt', async () => {
    surfaceMock.request.mockResolvedValueOnce(null);

    await expect(acquireSprinkleCaptureStream()).rejects.toThrow('Screen capture cancelled');
    expect(surfaceMock.request).toHaveBeenCalledTimes(1);
  });

  it('falls back to navigator.mediaDevices.getDisplayMedia when no surface is mounted', async () => {
    surfaceHolder.value = null;
    const stream = makeStream();
    const getDisplayMedia = vi.fn(async () => stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia },
    });

    const got = await acquireSprinkleCaptureStream();

    expect(got).toBe(stream);
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(surfaceMock.request).not.toHaveBeenCalled();
  });

  it('rejects when no surface is mounted and getDisplayMedia is unavailable', async () => {
    surfaceHolder.value = null;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {},
    });

    await expect(acquireSprinkleCaptureStream()).rejects.toThrow(
      'Screen capture not supported in this browser'
    );
  });
});
