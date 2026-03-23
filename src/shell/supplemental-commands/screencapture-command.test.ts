import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScreencaptureCommand } from './screencapture-command.js';

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

  it('parses arguments correctly with -- separator', async () => {
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).navigator = {
      mediaDevices: { getDisplayMedia: vi.fn().mockRejectedValue(new Error('test')) },
    };

    const cmd = createScreencaptureCommand();
    const ctx = createMockCtx();
    // Using -- allows filename starting with dash
    const result = await cmd.execute(['--', '-weird-name.png'], ctx as any);

    // Should attempt capture (and fail with our mock error)
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('test');
  });

  it('filters only known flags', async () => {
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).navigator = {
      mediaDevices: { getDisplayMedia: vi.fn().mockRejectedValue(new Error('test')) },
    };

    const cmd = createScreencaptureCommand();
    const ctx = createMockCtx();
    // Unknown flag should be treated as filename
    const result = await cmd.execute(['--unknown', 'screenshot.png'], ctx as any);

    expect(result.exitCode).toBe(1);
    // The capture was attempted (mock rejects)
  });

  describe('successful capture', () => {
    let mockStream: any;
    let mockVideo: any;
    let mockCanvas: any;
    let mockCtx2d: any;

    beforeEach(() => {
      mockStream = {
        getVideoTracks: () => [{ stop: vi.fn() }],
        getTracks: () => [{ stop: vi.fn() }],
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

      (globalThis as any).window = {};
      (globalThis as any).document = {
        createElement: vi.fn((tag: string) => {
          if (tag === 'video') return mockVideo;
          if (tag === 'canvas') return mockCanvas;
          return {};
        }),
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
  });
});
