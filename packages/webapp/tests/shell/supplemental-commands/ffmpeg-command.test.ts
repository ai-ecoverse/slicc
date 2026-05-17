import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IFileSystem } from 'just-bash';
import {
  buildCameraRequest,
  createFfmpegCommand,
  isAvfoundationCapture,
  parseAvfoundationDeviceSpec,
  parseFfmpegArgs,
} from '../../../src/shell/supplemental-commands/ffmpeg-command.js';

function createMockCtx(
  overrides: Partial<{ fs: Partial<IFileSystem>; cwd: string }> = {}
): Parameters<ReturnType<typeof createFfmpegCommand>['execute']>[1] {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    exists: vi.fn().mockResolvedValue(true),
    readFileBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    writeFile: vi.fn().mockResolvedValue(undefined),
    ...overrides.fs,
  };
  return {
    fs: fs as IFileSystem,
    cwd: overrides.cwd ?? '/home',
    env: new Map<string, string>(),
    stdin: '',
  } as ReturnType<typeof createMockCtx> & {
    fs: IFileSystem;
    cwd: string;
    env: Map<string, string>;
    stdin: string;
  };
}

describe('parseFfmpegArgs', () => {
  it('extracts a simple input/output pair', () => {
    const parsed = parseFfmpegArgs(['-i', 'input.mp4', 'out.gif']);
    expect(parsed.inputs).toHaveLength(1);
    expect(parsed.inputs[0].path).toBe('input.mp4');
    expect(parsed.outputPath).toBe('out.gif');
  });

  it('captures pre-input -f / -video_size / -framerate flags', () => {
    const parsed = parseFfmpegArgs([
      '-f',
      'avfoundation',
      '-video_size',
      '1280x720',
      '-framerate',
      '30',
      '-i',
      '0',
      '-frames:v',
      '1',
      '-update',
      '1',
      '-y',
      'photo.jpg',
    ]);
    expect(parsed.inputs).toHaveLength(1);
    expect(parsed.inputs[0].format).toBe('avfoundation');
    expect(parsed.inputs[0].videoSize).toEqual({ width: 1280, height: 720 });
    expect(parsed.inputs[0].frameRate).toBe(30);
    expect(parsed.inputs[0].path).toBe('0');
    expect(parsed.outputOpts).toContain('-frames:v');
    expect(parsed.outputPath).toBe('photo.jpg');
  });

  it('binds pre-file options to the next input (not the output)', () => {
    const parsed = parseFfmpegArgs([
      '-i',
      'a.mp4',
      '-ss',
      '5',
      '-i',
      'b.mp4',
      '-filter_complex',
      'hstack',
      'merged.mp4',
    ]);
    expect(parsed.inputs.map((i) => i.path)).toEqual(['a.mp4', 'b.mp4']);
    // `-ss 5` precedes the SECOND `-i`, so it must attach to b.mp4
    // and NOT leak into the output options. The fact that ffmpeg
    // would interpret `-ss 5` after `-i a.mp4` as a seek on b.mp4
    // is the whole reason for the option-binding semantics.
    expect(parsed.inputs[0].raw).not.toContain('-ss');
    expect(parsed.inputs[1].raw.join(' ')).toContain('-ss 5');
    expect(parsed.outputOpts).not.toContain('-ss');
    expect(parsed.outputOpts).toContain('-filter_complex');
    expect(parsed.outputPath).toBe('merged.mp4');
  });

  it('errors when -i is missing its value', () => {
    expect(() => parseFfmpegArgs(['-i'])).toThrow(/requires a/);
  });

  it('errors when a generic value-taking flag is missing its value', () => {
    expect(() => parseFfmpegArgs(['-i', 'in.mp4', '-t'])).toThrow(/-t requires a value/);
  });

  it('errors when -f is missing its value', () => {
    expect(() => parseFfmpegArgs(['-f'])).toThrow(/-f requires a value/);
  });
});

describe('isAvfoundationCapture', () => {
  it('detects -f avfoundation invocations', () => {
    const parsed = parseFfmpegArgs(['-f', 'avfoundation', '-i', '0', 'out.jpg']);
    expect(isAvfoundationCapture(parsed)).toBe(true);
  });

  it('returns false for plain ffmpeg invocations', () => {
    const parsed = parseFfmpegArgs(['-i', 'input.mp4', 'output.mp4']);
    expect(isAvfoundationCapture(parsed)).toBe(false);
  });
});

describe('buildCameraRequest', () => {
  it('returns a photo request for the canonical webcam-still invocation', () => {
    const parsed = parseFfmpegArgs([
      '-f',
      'avfoundation',
      '-video_size',
      '1280x720',
      '-framerate',
      '30',
      '-i',
      '0',
      '-frames:v',
      '1',
      '-update',
      '1',
      '-y',
      'photo.jpg',
    ]);
    const { request, outputPath } = buildCameraRequest(parsed);
    expect(outputPath).toBe('photo.jpg');
    expect(request.mode).toBe('photo');
    expect(request.deviceId).toBe('0');
    expect(request.width).toBe(1280);
    expect(request.height).toBe(720);
    expect(request.frameRate).toBe(30);
    expect(request.mimeType).toBe('image/jpeg');
  });

  it('returns a video request when the output is a video file with -t', () => {
    const parsed = parseFfmpegArgs(['-f', 'avfoundation', '-i', '0', '-t', '3', 'clip.webm']);
    const { request } = buildCameraRequest(parsed);
    expect(request.mode).toBe('video');
    expect(request.mimeType).toBe('video/webm');
    expect(request.durationMs).toBe(3000);
  });

  it('returns photo mode when the output extension is .png', () => {
    const parsed = parseFfmpegArgs(['-f', 'avfoundation', '-i', '0', 'frame.png']);
    const { request } = buildCameraRequest(parsed);
    expect(request.mode).toBe('photo');
    expect(request.mimeType).toBe('image/png');
  });

  it('honors -warmup override for photo captures', () => {
    const parsed = parseFfmpegArgs(['-f', 'avfoundation', '-warmup', '0', '-i', '0', 'photo.jpg']);
    const { request } = buildCameraRequest(parsed);
    expect(request.mode).toBe('photo');
    expect(request.warmupMs).toBe(0);
  });

  it('forwards exactSize when -exact_size is provided', () => {
    const parsed = parseFfmpegArgs([
      '-f',
      'avfoundation',
      '-exact_size',
      '-video_size',
      '1920x1080',
      '-i',
      '0',
      'photo.jpg',
    ]);
    const { request } = buildCameraRequest(parsed);
    expect(request.exactSize).toBe(true);
    expect(request.width).toBe(1920);
    expect(request.height).toBe(1080);
  });

  it('parses -i "videoIdx:audioIdx" into capture audio settings', () => {
    const parsed = parseFfmpegArgs(['-f', 'avfoundation', '-i', '0:1', '-t', '2', 'clip.webm']);
    const { request } = buildCameraRequest(parsed);
    expect(request.mode).toBe('video');
    expect(request.deviceId).toBe('0');
    expect(request.captureAudio).toBe(true);
    expect(request.audioDeviceId).toBe('1');
  });

  it('routes audio-only -i ":0" through video mode with audio capture', () => {
    const parsed = parseFfmpegArgs(['-f', 'avfoundation', '-i', ':0', '-t', '2', 'audio.webm']);
    const { request } = buildCameraRequest(parsed);
    expect(request.mode).toBe('video');
    expect(request.deviceId).toBeUndefined();
    expect(request.captureAudio).toBe(true);
    expect(request.audioDeviceId).toBe('0');
    // Audio-only must NOT request a video track from getUserMedia —
    // otherwise the camera permission prompt surfaces and devices
    // without a webcam fail with NotFoundError.
    expect(request.captureVideo).toBe(false);
  });

  it('keeps video on for video+audio captures', () => {
    const parsed = parseFfmpegArgs(['-f', 'avfoundation', '-i', '0:0', '-t', '2', 'clip.webm']);
    const { request } = buildCameraRequest(parsed);
    expect(request.captureVideo).toBe(true);
  });

  it('does not treat -update 0 as photo mode', () => {
    const parsed = parseFfmpegArgs([
      '-f',
      'avfoundation',
      '-i',
      '0',
      '-update',
      '0',
      '-t',
      '2',
      'clip.webm',
    ]);
    const { request } = buildCameraRequest(parsed);
    expect(request.mode).toBe('video');
  });

  it('flags transcode when output is .mp4 (capture is always webm)', () => {
    const parsed = parseFfmpegArgs(['-f', 'avfoundation', '-i', '0', '-t', '2', 'clip.mp4']);
    const result = buildCameraRequest(parsed);
    expect(result.captureMime).toBe('video/webm');
    expect(result.needsTranscode).toBe(true);
  });

  it('flags transcode when output options include -c:v', () => {
    const parsed = parseFfmpegArgs([
      '-f',
      'avfoundation',
      '-i',
      '0',
      '-t',
      '2',
      '-c:v',
      'libx264',
      'clip.mp4',
    ]);
    const result = buildCameraRequest(parsed);
    expect(result.needsTranscode).toBe(true);
  });

  it('does not flag transcode for a plain webm video output', () => {
    const parsed = parseFfmpegArgs(['-f', 'avfoundation', '-i', '0', '-t', '2', 'clip.webm']);
    const result = buildCameraRequest(parsed);
    expect(result.needsTranscode).toBe(false);
  });
});

describe('parseAvfoundationDeviceSpec', () => {
  it('treats a single value as video-only', () => {
    expect(parseAvfoundationDeviceSpec('0')).toEqual({ video: '0' });
    expect(parseAvfoundationDeviceSpec('Camera Name')).toEqual({ video: 'Camera Name' });
  });

  it('splits video:audio pairs', () => {
    expect(parseAvfoundationDeviceSpec('0:1')).toEqual({ video: '0', audio: '1' });
    expect(parseAvfoundationDeviceSpec('FaceTime HD:Built-in Mic')).toEqual({
      video: 'FaceTime HD',
      audio: 'Built-in Mic',
    });
  });

  it('produces audio-only for leading colon', () => {
    expect(parseAvfoundationDeviceSpec(':0')).toEqual({ audio: '0' });
  });

  it('drops empty audio half', () => {
    expect(parseAvfoundationDeviceSpec('0:')).toEqual({ video: '0' });
  });
});

describe('list_devices', () => {
  it('runs an enumeration query through panel-rpc when no local DOM is available', async () => {
    const call = vi.fn().mockResolvedValue({
      videoinputs: [
        { deviceId: 'cam-a', label: 'FaceTime HD Camera' },
        { deviceId: 'cam-b', label: 'External USB Cam' },
      ],
      audioinputs: [{ deviceId: 'mic-a', label: 'MacBook Mic' }],
    });
    (globalThis as Record<string, unknown>).__slicc_panelRpc = {
      call,
      dispose: () => {},
    };
    try {
      const cmd = createFfmpegCommand();
      const result = await cmd.execute(
        ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
        createMockCtx()
      );
      expect(result.exitCode).toBe(0);
      expect(call).toHaveBeenCalledWith(
        'enumerate-media-devices',
        undefined,
        expect.objectContaining({ timeoutMs: expect.any(Number) })
      );
      expect(result.stderr).toContain('AVFoundation video devices');
      expect(result.stderr).toContain('[0] FaceTime HD Camera');
      expect(result.stderr).toContain('[1] External USB Cam');
      expect(result.stderr).toContain('AVFoundation audio devices');
      expect(result.stderr).toContain('[0] MacBook Mic');
    } finally {
      const g = globalThis as Record<string, unknown>;
      delete g.__slicc_panelRpc;
    }
  });
});

describe('createFfmpegCommand routing', () => {
  beforeEach(() => {
    // Clean panel-rpc globals between cases to keep the routing branches isolated.
    const g = globalThis as Record<string, unknown>;
    delete g.__slicc_panelRpc;
  });

  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    delete g.__slicc_panelRpc;
  });

  it('shows help with no args', async () => {
    const cmd = createFfmpegCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ffmpeg');
    expect(result.stdout).toContain('avfoundation');
  });

  it('fails when only -i is provided with no output', async () => {
    const cmd = createFfmpegCommand();
    const result = await cmd.execute(['-i', 'in.mp4'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('output');
  });

  it('routes -f avfoundation through the panel-rpc bridge when no local DOM is present', async () => {
    const call = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
      mimeType: 'image/jpeg',
      width: 1280,
      height: 720,
    });
    (globalThis as Record<string, unknown>).__slicc_panelRpc = {
      call,
      dispose: () => {},
    };

    const writeFile = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockCtx({ fs: { writeFile } });

    const cmd = createFfmpegCommand();
    const result = await cmd.execute(
      [
        '-f',
        'avfoundation',
        '-video_size',
        '1280x720',
        '-framerate',
        '30',
        '-i',
        '0',
        '-frames:v',
        '1',
        '-update',
        '1',
        '-y',
        'photo.jpg',
      ],
      ctx
    );
    expect(result.exitCode).toBe(0);
    expect(call).toHaveBeenCalledWith(
      'capture-camera',
      expect.objectContaining({ mode: 'photo', deviceId: '0' }),
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(writeFile).toHaveBeenCalledWith('/home/photo.jpg', expect.any(Uint8Array));
  });

  it('returns a clear error when -f avfoundation runs in a non-browser context', async () => {
    const cmd = createFfmpegCommand();
    const result = await cmd.execute(
      ['-f', 'avfoundation', '-i', '0', 'photo.jpg'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/camera/i);
  });
});
