import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScreencaptureCommand } from '../../../src/shell/supplemental-commands/screencapture-command.js';

function createMockCtx(opts: { cwd?: string } = {}) {
  return {
    cwd: opts.cwd ?? '/workspace',
    fs: {
      resolvePath: (_cwd: string, target: string) => {
        if (target.startsWith('/')) return target;
        return `${_cwd}/${target}`;
      },
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('screencapture command', () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  });

  it('shows help with --help', async () => {
    const cmd = createScreencaptureCommand();
    const result = await cmd.execute(['--help'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('screencapture');
    expect(result.stdout).toContain('--clipboard');
    expect(result.stdout).toContain('--view');
    expect(result.stdout).toContain('--video');
    expect(result.stdout).toContain('-V');
  });

  it('shows help with -h', async () => {
    const cmd = createScreencaptureCommand();
    const result = await cmd.execute(['-h'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('screencapture');
  });

  it('errors when browser APIs are unavailable (no window)', async () => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).navigator;

    const cmd = createScreencaptureCommand();
    const result = await cmd.execute(['screenshot.png'], {} as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('browser APIs are unavailable');
  });

  it('errors when document is unavailable', async () => {
    (globalThis as any).window = {};
    (globalThis as any).navigator = {};
    delete (globalThis as any).document;

    const cmd = createScreencaptureCommand();
    const result = await cmd.execute(['screenshot.png'], {} as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('browser APIs are unavailable');
  });

  it('errors when getDisplayMedia is not supported', async () => {
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).navigator = { mediaDevices: {} };

    const cmd = createScreencaptureCommand();
    const result = await cmd.execute(['screenshot.png'], {} as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('screen capture is not supported');
  });

  it('errors when no output file provided and not using clipboard', async () => {
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).navigator = {
      mediaDevices: { getDisplayMedia: vi.fn() },
    };

    const cmd = createScreencaptureCommand();
    const result = await cmd.execute([], {} as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('output file required');
  });

  it('handles permission denied error', async () => {
    const mockGetDisplayMedia = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    (globalThis as any).window = {};
    (globalThis as any).document = {
      createElement: vi.fn(),
    };
    (globalThis as any).navigator = {
      mediaDevices: { getDisplayMedia: mockGetDisplayMedia },
    };

    const cmd = createScreencaptureCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(['screenshot.png'], ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('user cancelled or permission denied');
  });

  it('handles user cancellation', async () => {
    const mockGetDisplayMedia = vi.fn().mockRejectedValue(new Error('Permission denied'));
    (globalThis as any).window = {};
    (globalThis as any).document = {
      createElement: vi.fn(),
    };
    (globalThis as any).navigator = {
      mediaDevices: { getDisplayMedia: mockGetDisplayMedia },
    };

    const cmd = createScreencaptureCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(['screenshot.png'], ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('user cancelled or permission denied');
  });

  it('handles generic capture errors', async () => {
    const mockGetDisplayMedia = vi.fn().mockRejectedValue(new Error('Some other error'));
    (globalThis as any).window = {};
    (globalThis as any).document = {
      createElement: vi.fn(),
    };
    (globalThis as any).navigator = {
      mediaDevices: { getDisplayMedia: mockGetDisplayMedia },
    };

    const cmd = createScreencaptureCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(['screenshot.png'], ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Some other error');
  });

  it('maps InvalidStateError to an actionable message (#3233)', async () => {
    const err = new DOMException('Invalid state', 'InvalidStateError');
    const mockGetDisplayMedia = vi.fn().mockRejectedValue(err);
    (globalThis as any).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (globalThis as any).document = {
      createElement: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      hasFocus: () => true,
      visibilityState: 'visible',
    };
    (globalThis as any).navigator = {
      mediaDevices: { getDisplayMedia: mockGetDisplayMedia },
    };

    const cmd = createScreencaptureCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(['screenshot.png'], ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('display capture unavailable');
    expect(result.stderr).toContain('reload the session');
  });

  it('rejects video to clipboard', async () => {
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).navigator = {
      mediaDevices: { getDisplayMedia: vi.fn() },
    };

    const cmd = createScreencaptureCommand();
    const result = await cmd.execute(['--video', '-c'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('clipboard');
    expect((globalThis as any).navigator.mediaDevices.getDisplayMedia).not.toHaveBeenCalled();
  });

  it('rejects --video without a video extension', async () => {
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).navigator = {
      mediaDevices: { getDisplayMedia: vi.fn() },
    };

    const cmd = createScreencaptureCommand();
    const result = await cmd.execute(['--video', 'shot.png'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('.webm');
  });

  it('rejects -g without video mode', async () => {
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).navigator = {
      mediaDevices: { getDisplayMedia: vi.fn() },
    };

    const cmd = createScreencaptureCommand();
    const result = await cmd.execute(['-g', 'shot.png'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--audio');
  });

  it('rejects -V when the next token is another flag (not a duration)', async () => {
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).navigator = {
      mediaDevices: { getDisplayMedia: vi.fn() },
    };

    const cmd = createScreencaptureCommand();
    const result = await cmd.execute(['-V', '--audio', 'clip.webm'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('-V/--duration requires a value');
    expect((globalThis as any).navigator.mediaDevices.getDisplayMedia).not.toHaveBeenCalled();
  });

  it('parses arguments correctly with -- separator', async () => {
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).navigator = {
      mediaDevices: { getDisplayMedia: vi.fn().mockRejectedValue(new Error('test')) },
    };

    const cmd = createScreencaptureCommand();
    const ctx = createMockCtx();

    const result = await cmd.execute(['--', '-weird-name.png'], ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('test');
  });

  it('rejects unknown flags with a non-zero exit (#2255)', async () => {
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).navigator = {
      mediaDevices: { getDisplayMedia: vi.fn().mockRejectedValue(new Error('test')) },
    };

    const cmd = createScreencaptureCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(['--unknown', 'screenshot.png'], ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown flag: --unknown');
    expect((globalThis as any).navigator.mediaDevices.getDisplayMedia).not.toHaveBeenCalled();
  });

  describe('successful capture', () => {
    let mockStream: any;
    let mockVideo: any;
    let mockCanvas: any;
    let mockCtx2d: any;

    beforeEach(() => {
      mockStream = {
        getVideoTracks: () => [{ stop: vi.fn(), addEventListener: vi.fn() }],
        getTracks: () => [{ stop: vi.fn(), addEventListener: vi.fn() }],
      };

      mockVideo = {
        srcObject: null,
        muted: false,
        playsInline: false,
        videoWidth: 1920,
        videoHeight: 1080,
        onloadedmetadata: null as any,
        onerror: null as any,
        play: vi.fn().mockResolvedValue(undefined),
      };

      mockCtx2d = {
        drawImage: vi.fn(),
      };

      mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn().mockReturnValue(mockCtx2d),
        toBlob: vi.fn((callback: any, _mimeType: string, _quality: number) => {
          const blob = new Blob(['fake-image-data'], { type: 'image/png' });
          callback(blob);
        }),
      };

      (globalThis as any).window = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      (globalThis as any).document = {
        createElement: vi.fn((tag: string) => {
          if (tag === 'video') return mockVideo;
          if (tag === 'canvas') return mockCanvas;
          return {};
        }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        hasFocus: () => true,
        visibilityState: 'visible',
      };
      (globalThis as any).navigator = {
        mediaDevices: {
          getDisplayMedia: vi.fn().mockImplementation(async () => {
            setTimeout(() => {
              if (mockVideo.onloadedmetadata) mockVideo.onloadedmetadata();
            }, 0);
            return mockStream;
          }),
        },
        clipboard: {
          write: vi.fn().mockResolvedValue(undefined),
        },
      };
      (globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
      (globalThis as any).ClipboardItem = class {
        constructor(public data: any) {}
      };
    });

    it('captures to file', async () => {
      const cmd = createScreencaptureCommand();
      const ctx = createMockCtx();
      const result = await cmd.execute(['screenshot.png'], ctx as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('captured');
      expect(result.stdout).toContain('KB');
      expect(result.stdout).toContain('screenshot.png');
      expect(ctx.fs.writeFile).toHaveBeenCalled();
    });

    it('captures with --view returns inline image', async () => {
      const cmd = createScreencaptureCommand();
      const ctx = createMockCtx();
      const result = await cmd.execute(['--view', 'screenshot.png'], ctx as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('<img:data:image/png;base64,');
      expect(ctx.fs.writeFile).toHaveBeenCalled();
    });

    it('captures with -v returns inline image', async () => {
      const cmd = createScreencaptureCommand();
      const ctx = createMockCtx();
      const result = await cmd.execute(['-v', 'screenshot.png'], ctx as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('<img:data:image/png;base64,');
    });

    it('captures to clipboard with -c', async () => {
      const cmd = createScreencaptureCommand();
      const ctx = createMockCtx();
      const result = await cmd.execute(['-c'], ctx as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('clipboard');
      expect((globalThis as any).navigator.clipboard.write).toHaveBeenCalled();
      expect(ctx.fs.writeFile).not.toHaveBeenCalled();
    });

    it('captures to clipboard with --clipboard', async () => {
      const cmd = createScreencaptureCommand();
      const ctx = createMockCtx();
      const result = await cmd.execute(['--clipboard'], ctx as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('clipboard');
    });

    it('handles file write error', async () => {
      const cmd = createScreencaptureCommand();
      const ctx = createMockCtx();
      ctx.fs.writeFile.mockRejectedValue(new Error('ENOSPC'));
      const result = await cmd.execute(['screenshot.png'], ctx as any);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('failed to write file');
    });

    it('handles clipboard write error', async () => {
      (globalThis as any).navigator.clipboard.write.mockRejectedValue(new Error('Clipboard error'));
      const cmd = createScreencaptureCommand();
      const ctx = createMockCtx();
      const result = await cmd.execute(['-c'], ctx as any);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('failed to copy to clipboard');
    });

    it('defers the clipboard write until the document regains focus', async () => {
      let focused = false;
      const focusListeners = new Set<() => void>();
      (globalThis as any).document.hasFocus = () => focused;
      (globalThis as any).document.addEventListener = vi.fn();
      (globalThis as any).document.removeEventListener = vi.fn();
      (globalThis as any).window.addEventListener = vi.fn((type: string, fn: () => void) => {
        if (type === 'focus') focusListeners.add(fn);
      });
      (globalThis as any).window.removeEventListener = vi.fn((type: string, fn: () => void) => {
        if (type === 'focus') focusListeners.delete(fn);
      });

      const cmd = createScreencaptureCommand();
      const ctx = createMockCtx();
      const promise = cmd.execute(['-c'], ctx as any);

      await new Promise((r) => setTimeout(r, 200));
      expect((globalThis as any).navigator.clipboard.write).not.toHaveBeenCalled();
      expect(focusListeners.size).toBe(1);

      focused = true;
      for (const fn of focusListeners) fn();

      const result = await promise;
      expect(result.exitCode).toBe(0);
      expect((globalThis as any).navigator.clipboard.write).toHaveBeenCalled();
    });

    it('uses correct mime type for jpg extension', async () => {
      const cmd = createScreencaptureCommand();
      const ctx = createMockCtx();
      await cmd.execute(['screenshot.jpg'], ctx as any);

      expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
    });

    it('uses correct mime type for webp extension', async () => {
      const cmd = createScreencaptureCommand();
      const ctx = createMockCtx();
      await cmd.execute(['screenshot.webp'], ctx as any);

      expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/webp', 0.92);
    });

    it('records video with --video -V and a .webm path', async () => {
      class FakeMediaRecorder {
        static isTypeSupported = () => true;
        state = 'inactive';
        ondataavailable: ((ev: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        constructor(
          public stream: MediaStream,
          public opts: { mimeType: string }
        ) {}
        start() {
          this.state = 'recording';
          queueMicrotask(() => {
            this.ondataavailable?.({
              data: new Blob(['fake-webm'], { type: 'video/webm' }),
            });
          });
        }
        stop() {
          this.state = 'inactive';
          queueMicrotask(() => this.onstop?.());
        }
      }
      (globalThis as any).MediaRecorder = FakeMediaRecorder;

      vi.useFakeTimers();
      try {
        const cmd = createScreencaptureCommand();
        const ctx = createMockCtx();
        const promise = cmd.execute(['--video', '-V', '0.2', 'clip.webm'], ctx as any);
        await vi.advanceTimersByTimeAsync(250);
        const result = await promise;
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('video');
        expect(result.stdout).toContain('clip.webm');
        expect(ctx.fs.writeFile).toHaveBeenCalled();
        expect((globalThis as any).navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledWith({
          video: true,
          audio: false,
        });
      } finally {
        vi.useRealTimers();
        delete (globalThis as any).MediaRecorder;
      }
    });

    it('treats a .webm path as video and honors attached -V5', async () => {
      class FakeMediaRecorder {
        static isTypeSupported = () => true;
        state = 'inactive';
        ondataavailable: ((ev: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = 'recording';
          queueMicrotask(() => {
            this.ondataavailable?.({
              data: new Blob(['fake-webm'], { type: 'video/webm' }),
            });
          });
        }
        stop() {
          this.state = 'inactive';
          queueMicrotask(() => this.onstop?.());
        }
      }
      (globalThis as any).MediaRecorder = FakeMediaRecorder;
      vi.useFakeTimers();
      try {
        const cmd = createScreencaptureCommand();
        const ctx = createMockCtx();
        const promise = cmd.execute(['-V5', 'demo.webm'], ctx as any);
        await vi.advanceTimersByTimeAsync(5100);
        const result = await promise;
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('video');
      } finally {
        vi.useRealTimers();
        delete (globalThis as any).MediaRecorder;
      }
    });

    it('reports elapsed duration when sharing stops before the timer', async () => {
      const endedListeners = new Set<() => void>();
      const track = {
        stop: vi.fn(),
        addEventListener: vi.fn((type: string, fn: () => void) => {
          if (type === 'ended') endedListeners.add(fn);
        }),
      };
      mockStream.getTracks = () => [track];
      mockStream.getVideoTracks = () => [track];

      class FakeMediaRecorder {
        static isTypeSupported = () => true;
        state = 'inactive';
        ondataavailable: ((ev: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = 'recording';
          queueMicrotask(() => {
            this.ondataavailable?.({
              data: new Blob(['fake-webm'], { type: 'video/webm' }),
            });
          });
        }
        stop() {
          this.state = 'inactive';
          queueMicrotask(() => this.onstop?.());
        }
      }
      (globalThis as any).MediaRecorder = FakeMediaRecorder;
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const cmd = createScreencaptureCommand();
        const ctx = createMockCtx();

        const promise = cmd.execute(['--video', '-V', '60', 'early.webm'], ctx as any);
        await vi.advanceTimersByTimeAsync(1500);
        for (const fn of endedListeners) fn();
        await vi.advanceTimersByTimeAsync(10);
        const result = await promise;
        expect(result.exitCode).toBe(0);

        expect(result.stdout).not.toMatch(/\(60s\)/);
        expect(result.stdout).toMatch(/\(([12](\.\d)?|0\.\d)s\)/);
      } finally {
        vi.useRealTimers();
        delete (globalThis as any).MediaRecorder;
      }
    });
  });
});
