import { describe, expect, it } from 'vitest';
import {
  DisplaySessionStore,
  stopMediaStreamTracks,
} from '../../../src/shell/supplemental-commands/screencapture-media.js';
import {
  clampVideoDurationMs,
  describeDisplayCaptureError,
  fitDisplaySize,
  sessionCaptureRequest,
} from '../../../src/shell/supplemental-commands/screencapture-media-shared.js';

describe('screencapture-media helpers', () => {
  it('clamps video duration to 100ms–60s with a 5s default', () => {
    expect(clampVideoDurationMs(undefined)).toBe(5_000);
    expect(clampVideoDurationMs(50)).toBe(100);
    expect(clampVideoDurationMs(120_000)).toBe(60_000);
    expect(clampVideoDurationMs(12_500)).toBe(12_500);
  });

  it('rewrites InvalidStateError and points at computer ls (#3233 / #3247)', () => {
    const msg = describeDisplayCaptureError(new DOMException('Invalid state', 'InvalidStateError'));
    expect(msg).toContain('display capture unavailable');
    expect(msg).toContain('computer ls');
    expect(msg).toContain('computer rm');
    expect(msg).toContain('reload the session');
  });

  it('maps NotAllowedError to the cancelled/denied phrasing', () => {
    expect(describeDisplayCaptureError(new DOMException('denied', 'NotAllowedError'))).toBe(
      'user cancelled or permission denied'
    );
  });

  it('fits a native capture into maxWidth', () => {
    expect(fitDisplaySize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitDisplaySize(1920, 1080, 768)).toEqual({ width: 768, height: 432 });
    expect(fitDisplaySize(400, 300, 768)).toEqual({ width: 400, height: 300 });
  });
});

describe('sessionCaptureRequest', () => {
  const base = { mimeType: 'image/jpeg', quality: 0.7 };

  it('maps start / frame / stop / record', () => {
    expect(sessionCaptureRequest({ ...base, session: 'start' })).toEqual({
      mode: 'session',
      action: 'start',
    });
    expect(
      sessionCaptureRequest({ ...base, session: 'frame', handle: 'screen1', maxWidth: 768 })
    ).toEqual({
      mode: 'session',
      action: 'frame',
      handle: 'screen1',
      maxWidth: 768,
      mimeType: 'image/jpeg',
      quality: 0.7,
    });
    expect(sessionCaptureRequest({ ...base, session: 'stop', handle: 'screen1' })).toEqual({
      mode: 'session',
      action: 'stop',
      handle: 'screen1',
    });
    expect(
      sessionCaptureRequest({
        ...base,
        session: 'record',
        handle: 'screen1',
        durationMs: 2_000,
        mimeType: 'video/webm',
      })
    ).toEqual({
      mode: 'session',
      action: 'record',
      handle: 'screen1',
      durationMs: 2_000,
      mimeType: 'video/webm',
    });
  });

  it('refuses frame/stop/record without a handle and unknown actions', () => {
    expect(() => sessionCaptureRequest({ ...base, session: 'frame' })).toThrow(/requires handle/);
    expect(() => sessionCaptureRequest({ ...base })).toThrow(/start\|frame\|stop\|record/);
  });
});

describe('DisplaySessionStore', () => {
  it('issues handles and stops tracks on stop / stopAll', () => {
    const store = new DisplaySessionStore();
    const t1 = {
      stopped: false,
      stop() {
        this.stopped = true;
      },
      addEventListener() {},
    };
    const t2 = {
      stopped: false,
      stop() {
        this.stopped = true;
      },
      addEventListener() {},
    };
    const stream = { getTracks: () => [t1, t2] } as unknown as MediaStream;
    const video = { srcObject: stream } as unknown as HTMLVideoElement;
    const handle = store.add(stream, video);
    expect(handle).toMatch(/^screen\d+$/);
    expect(store.ids()).toEqual([handle]);
    expect(store.get(handle)?.stream).toBe(stream);
    expect(store.stop(handle)).toBe(true);
    expect(t1.stopped).toBe(true);
    expect(t2.stopped).toBe(true);
    expect(video.srcObject).toBeNull();
    expect(store.ids()).toEqual([]);
    expect(store.stop(handle)).toBe(false);
  });

  it('drops the session when a track ends', () => {
    const store = new DisplaySessionStore();
    let onEnded: (() => void) | undefined;
    const track = {
      stopped: false,
      stop() {
        this.stopped = true;
      },
      addEventListener(_type: string, cb: () => void) {
        onEnded = cb;
      },
    };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const handle = store.add(stream, { srcObject: stream } as unknown as HTMLVideoElement);
    expect(store.ids()).toEqual([handle]);
    onEnded?.();
    expect(store.ids()).toEqual([]);
    expect(track.stopped).toBe(true);
  });

  it('stopAll ends every live session', () => {
    const store = new DisplaySessionStore();
    const tracks: Array<{ stopped: boolean; stop(): void; addEventListener(): void }> = [];
    const add = () => {
      const track = {
        stopped: false,
        stop() {
          this.stopped = true;
        },
        addEventListener() {},
      };
      tracks.push(track);
      const stream = { getTracks: () => [track] } as unknown as MediaStream;
      store.add(stream, { srcObject: stream } as unknown as HTMLVideoElement);
    };
    add();
    add();
    store.stopAll();
    expect(store.ids()).toEqual([]);
    expect(tracks.every((t) => t.stopped)).toBe(true);
  });

  it('stopMediaStreamTracks is best-effort per track', () => {
    const good = {
      stopped: false,
      stop() {
        this.stopped = true;
      },
    };
    const bad = {
      stop() {
        throw new Error('already stopped');
      },
    };
    stopMediaStreamTracks({ getTracks: () => [good, bad] });
    expect(good.stopped).toBe(true);
  });
});
