import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FsStat, IFileSystem } from 'just-bash';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCameraRequest,
  createFfmpegCommand,
  createIpkContextFromCtx,
  isAvfoundationCapture,
  parseAvfoundationDeviceSpec,
  parseFfmpegArgs,
  permissionKindsFor,
  requestCapturePermission,
} from '../../../src/shell/supplemental-commands/ffmpeg-command.js';
import {
  BUNDLED_FFMPEG_CORE_VERSION,
  FFMPEG_CORE_NOT_INSTALLED,
  getFfmpeg,
  tryLoadFfmpegCoreFromNodeModules,
} from '../../../src/shell/supplemental-commands/ffmpeg-wasm.js';

// `runWasmFfmpeg` boots the heavy wasm core, which the loader refuses
// to do in the Node runtime. Mock only `getFfmpeg` so the command's
// staging / exec / output-validation logic is exercisable; the pure
// `tryLoadFfmpegCoreFromNodeModules` (used by `-version` gating) and
// `FFMPEG_CORE_NOT_INSTALLED` stay real.
vi.mock('../../../src/shell/supplemental-commands/ffmpeg-wasm.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/shell/supplemental-commands/ffmpeg-wasm.js')
  >('../../../src/shell/supplemental-commands/ffmpeg-wasm.js');
  return { ...actual, getFfmpeg: vi.fn() };
});

// The page-realm branch of `requestCapturePermission` dynamically imports
// the leader permissions registry; mock it so a test can drive the in-tab
// `surface.prompt(...)` path (only reached when `window` is defined).
const { leaderSurfaceHolder } = vi.hoisted(() => ({
  leaderSurfaceHolder: { value: null as { prompt: (...args: unknown[]) => unknown } | null },
}));
vi.mock('../../../src/ui/wc/wc-permissions-registry.js', () => ({
  getLeaderPermissionsSurface: () => leaderSurfaceHolder.value,
}));

type FakeFfmpeg = {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  deleteFile: ReturnType<typeof vi.fn>;
};

function makeFakeFfmpeg(opts: {
  exitCode?: number;
  readFile?: (name: string) => Promise<Uint8Array | string> | Uint8Array | string;
}): FakeFfmpeg {
  return {
    on: vi.fn(),
    off: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue(opts.exitCode ?? 0),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(async (name: string) =>
      opts.readFile ? await opts.readFile(name) : new Uint8Array([1, 2, 3, 4])
    ),
  };
}

function useFakeFfmpeg(fake: FakeFfmpeg): void {
  vi.mocked(getFfmpeg).mockResolvedValue(fake as unknown as Awaited<ReturnType<typeof getFfmpeg>>);
}

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

describe('createIpkContextFromCtx', () => {
  it('adapts ctx.fs into a ModuleReader + readBytes', async () => {
    const files = new Map<string, string>();
    const dirs = new Set<string>(['/workspace']);
    const ctx = createMockCtx({
      fs: {
        exists: vi.fn(async (p: string) => files.has(p) || dirs.has(p)),
        readFile: vi.fn(async (p: string) => {
          const v = files.get(p);
          if (v === undefined) throw new Error(`ENOENT: ${p}`);
          return v;
        }),
        readFileBuffer: vi.fn(async (p: string) => {
          const v = files.get(p);
          if (v === undefined) throw new Error(`ENOENT: ${p}`);
          return new TextEncoder().encode(v);
        }),
        stat: vi.fn(
          async (p: string) =>
            ({
              isFile: files.has(p),
              isDirectory: dirs.has(p),
              size: files.get(p)?.length ?? 0,
            }) as FsStat
        ),
      },
      cwd: '/workspace',
    });
    files.set('/workspace/hello.txt', 'world');
    const ipk = createIpkContextFromCtx(ctx);
    expect(ipk.fromDir).toBe('/workspace');
    expect(await ipk.reader.exists('/workspace/hello.txt')).toBe(true);
    expect(await ipk.reader.exists('/workspace/missing.txt')).toBe(false);
    expect(await ipk.reader.isDirectory('/workspace')).toBe(true);
    expect(await ipk.reader.isDirectory('/workspace/hello.txt')).toBe(false);
    expect(await ipk.reader.readFile('/workspace/hello.txt')).toBe('world');
    expect(new TextDecoder().decode(await ipk.readBytes('/workspace/hello.txt'))).toBe('world');
  });
});

describe('permissionKindsFor', () => {
  it('returns camera for photo captures', () => {
    expect(permissionKindsFor({ mode: 'photo', mimeType: 'image/jpeg', quality: 0.9 })).toEqual([
      'camera',
    ]);
  });

  it('returns camera for plain video captures', () => {
    expect(
      permissionKindsFor({ mode: 'video', mimeType: 'video/webm', captureVideo: true })
    ).toEqual(['camera']);
  });

  it('returns camera + microphone for video captures with audio', () => {
    expect(
      permissionKindsFor({
        mode: 'video',
        mimeType: 'video/webm',
        captureVideo: true,
        captureAudio: true,
      })
    ).toEqual(['camera', 'microphone']);
  });

  it('returns microphone only for audio-only captures', () => {
    expect(
      permissionKindsFor({
        mode: 'video',
        mimeType: 'video/webm',
        captureVideo: false,
        captureAudio: true,
      })
    ).toEqual(['microphone']);
  });
});

describe('requestCapturePermission', () => {
  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    delete g.__slicc_panelRpc;
  });

  it('returns ok for an empty kinds list (no realm reached)', async () => {
    const result = await requestCapturePermission([]);
    expect(result.ok).toBe(true);
  });

  it('falls through to ok when panel-RPC reports the surface is unavailable', async () => {
    const call = vi
      .fn()
      .mockRejectedValue(new Error('permission-request: permission surface unavailable'));
    (globalThis as Record<string, unknown>).__slicc_panelRpc = { call, dispose: () => {} };
    const result = await requestCapturePermission(['camera']);
    expect(result.ok).toBe(true);
    expect(call).toHaveBeenCalledWith(
      'permission-request',
      expect.objectContaining({ kinds: ['camera'] }),
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });

  it('surfaces a denial message when panel-RPC reports a permission failure', async () => {
    const call = vi.fn().mockRejectedValue(new Error('permission-request: cancelled'));
    (globalThis as Record<string, unknown>).__slicc_panelRpc = { call, dispose: () => {} };
    const result = await requestCapturePermission(['camera', 'microphone']);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toMatch(/cancelled/i);
  });

  it('resolves ok when the panel-RPC permission gate grants', async () => {
    const call = vi.fn().mockResolvedValue({ grants: [{ kind: 'camera', ok: true }] });
    (globalThis as Record<string, unknown>).__slicc_panelRpc = { call, dispose: () => {} };
    const result = await requestCapturePermission(['camera']);
    expect(result.ok).toBe(true);
  });

  it('stops the probe stream tracks on the page-realm surface path', async () => {
    // The in-tab `surface.prompt(...)` opens live MediaStreams to prime the
    // grant, but ffmpeg opens its own capture stream downstream — the probe
    // tracks MUST be stopped or a duplicate camera/mic stream leaks alive.
    const camTrack = { stop: vi.fn() };
    leaderSurfaceHolder.value = {
      prompt: vi.fn().mockResolvedValue({
        status: 'granted',
        grants: [{ kind: 'camera', stream: { getTracks: () => [camTrack] } }],
      }),
    };
    const g = globalThis as Record<string, unknown>;
    const hadWindow = 'window' in g;
    g.window = g.window ?? {};
    try {
      const result = await requestCapturePermission(['camera']);
      expect(result.ok).toBe(true);
      expect(camTrack.stop).toHaveBeenCalledTimes(1);
    } finally {
      leaderSurfaceHolder.value = null;
      if (!hadWindow) delete g.window;
    }
  });

  it('returns ok when no realm is reachable (proceed with capture)', async () => {
    // No panel-RPC, no leader surface — caller proceeds and lets the
    // underlying capture path surface its own browser prompt.
    const result = await requestCapturePermission(['camera']);
    expect(result.ok).toBe(true);
  });
});

describe('runAvfoundationCapture permission gating', () => {
  beforeEach(() => {
    const g = globalThis as Record<string, unknown>;
    delete g.__slicc_panelRpc;
  });

  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    delete g.__slicc_panelRpc;
  });

  it('calls permission-request before capture-camera when bridging via panel-RPC', async () => {
    const calls: Array<{ op: string; payload: unknown }> = [];
    const call = vi.fn(async (op: string, payload: unknown) => {
      calls.push({ op, payload });
      if (op === 'permission-request') return { grants: [{ kind: 'camera', ok: true }] };
      if (op === 'capture-camera') {
        return {
          bytes: new Uint8Array([1, 2, 3, 4]).buffer,
          mimeType: 'image/jpeg',
          width: 640,
          height: 480,
        };
      }
      throw new Error(`unexpected op: ${op}`);
    });
    (globalThis as Record<string, unknown>).__slicc_panelRpc = { call, dispose: () => {} };

    const cmd = createFfmpegCommand();
    const result = await cmd.execute(
      ['-f', 'avfoundation', '-i', '0', '-frames:v', '1', '-update', '1', 'photo.jpg'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(0);
    expect(calls.map((c) => c.op)).toEqual(['permission-request', 'capture-camera']);
    expect(calls[0].payload).toMatchObject({ kinds: ['camera'] });
  });

  it('aborts with a clean error when the permission gate denies', async () => {
    const call = vi.fn(async (op: string) => {
      if (op === 'permission-request') {
        throw new Error('permission-request: cancelled');
      }
      throw new Error(`unexpected op: ${op}`);
    });
    (globalThis as Record<string, unknown>).__slicc_panelRpc = { call, dispose: () => {} };

    const cmd = createFfmpegCommand();
    const result = await cmd.execute(
      ['-f', 'avfoundation', '-i', '0', '-frames:v', '1', '-update', '1', 'photo.jpg'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/permission denied/i);
    // capture-camera must NOT be called after a denial.
    const ops = call.mock.calls.map((args) => args[0]);
    expect(ops).toEqual(['permission-request']);
  });
});

describe('tryLoadFfmpegCoreFromNodeModules', () => {
  it('reads ffmpeg-core.js + ffmpeg-core.wasm from an ipk-installed @ffmpeg/core', async () => {
    const sources = new Map<string, string>();
    const bytes = new Map<string, Uint8Array>();
    const dirs = new Set<string>([
      '/workspace',
      '/workspace/node_modules',
      '/workspace/node_modules/@ffmpeg',
      '/workspace/node_modules/@ffmpeg/core',
      '/workspace/node_modules/@ffmpeg/core/dist',
      '/workspace/node_modules/@ffmpeg/core/dist/esm',
    ]);
    sources.set(
      '/workspace/node_modules/@ffmpeg/core/package.json',
      JSON.stringify({ name: '@ffmpeg/core', version: '0.12.10', main: 'dist/esm/ffmpeg-core.js' })
    );
    sources.set(
      '/workspace/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js',
      '/* core glue */ export default function () {}'
    );
    bytes.set(
      '/workspace/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm',
      new Uint8Array([0x00, 0x61, 0x73, 0x6d]) // wasm magic
    );

    const reader = {
      exists: async (path: string): Promise<boolean> =>
        sources.has(path) || bytes.has(path) || dirs.has(path),
      isDirectory: async (path: string): Promise<boolean> => dirs.has(path),
      readFile: async (path: string): Promise<string> => {
        const v = sources.get(path);
        if (v === undefined) throw new Error(`ENOENT: ${path}`);
        return v;
      },
    };
    const loaded = await tryLoadFfmpegCoreFromNodeModules({
      reader,
      readBytes: async (path: string) => {
        const v = bytes.get(path);
        if (!v) throw new Error(`ENOENT: ${path}`);
        return v;
      },
      fromDir: '/workspace',
    });
    expect(loaded).not.toBeNull();
    expect(loaded?.coreSource).toContain('core glue');
    expect(loaded?.wasmBytes.byteLength).toBe(4);
  });

  it('returns null when @ffmpeg/core is not installed', async () => {
    const reader = {
      exists: async (): Promise<boolean> => false,
      isDirectory: async (): Promise<boolean> => false,
      readFile: async (path: string): Promise<string> => {
        throw new Error(`ENOENT: ${path}`);
      },
    };
    const loaded = await tryLoadFfmpegCoreFromNodeModules({
      reader,
      readBytes: async () => {
        throw new Error('not reached');
      },
      fromDir: '/workspace',
    });
    expect(loaded).toBeNull();
  });
});

/** Build a ctx whose fs emulates an ipk-installed `@ffmpeg/core`. */
function createCtxWithFfmpegCoreInstalled(): ReturnType<typeof createMockCtx> {
  const root = '/workspace/node_modules/@ffmpeg/core';
  const sources = new Map<string, string>([
    [`${root}/package.json`, JSON.stringify({ name: '@ffmpeg/core', version: '0.12.10' })],
    [`${root}/dist/esm/ffmpeg-core.js`, '/* core glue */'],
  ]);
  const bytes = new Map<string, Uint8Array>([
    [`${root}/dist/esm/ffmpeg-core.wasm`, new Uint8Array([0x00, 0x61, 0x73, 0x6d])],
  ]);
  const dirs = new Set<string>([
    '/workspace',
    '/workspace/node_modules',
    '/workspace/node_modules/@ffmpeg',
    root,
    `${root}/dist`,
    `${root}/dist/esm`,
  ]);
  return createMockCtx({
    cwd: '/workspace',
    fs: {
      exists: vi.fn(async (p: string) => sources.has(p) || bytes.has(p) || dirs.has(p)),
      stat: vi.fn(
        async (p: string) =>
          ({
            isFile: sources.has(p) || bytes.has(p),
            isDirectory: dirs.has(p),
            size: sources.get(p)?.length ?? bytes.get(p)?.byteLength ?? 0,
          }) as FsStat
      ),
      readFile: vi.fn(async (p: string) => {
        const v = sources.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      }),
      readFileBuffer: vi.fn(async (p: string) => {
        const v = bytes.get(p);
        if (!v) throw new Error(`ENOENT: ${p}`);
        return v;
      }),
    },
  });
}

describe('ffmpeg -version gating (NS2c)', () => {
  it('exits non-zero with ipk guidance when @ffmpeg/core is not installed', async () => {
    const ctx = createMockCtx({ fs: { exists: vi.fn().mockResolvedValue(false) } });
    const result = await createFfmpegCommand().execute(['-version'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(FFMPEG_CORE_NOT_INSTALLED);
  });

  it('reports a version when @ffmpeg/core is installed', async () => {
    const ctx = createCtxWithFfmpegCoreInstalled();
    const result = await createFfmpegCommand().execute(['-version'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ffmpeg');
  });
});

describe('ffmpeg-core version lockstep (NS2c)', () => {
  it('keeps BUNDLED_FFMPEG_CORE_VERSION in lockstep with the installed package', () => {
    const require = createRequire(import.meta.url);
    // `@ffmpeg/core` blocks `package.json` subpath resolution via its
    // `exports` map, so resolve the main entry and walk back to the
    // package root rather than resolving the manifest directly.
    const main = require.resolve('@ffmpeg/core');
    const root = main.slice(0, main.indexOf('@ffmpeg/core') + '@ffmpeg/core'.length);
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8')) as {
      version: string;
    };
    expect(BUNDLED_FFMPEG_CORE_VERSION).toBe(pkg.version);
  });
});

describe('runWasmFfmpeg output validation (NS2a)', () => {
  beforeEach(() => {
    vi.mocked(getFfmpeg).mockReset();
  });

  it('fails when the core reports exit 0 but writes no output file', async () => {
    useFakeFfmpeg(
      makeFakeFfmpeg({
        exitCode: 0,
        readFile: () => {
          throw new Error('FS error: no such file or directory');
        },
      })
    );
    const ctx = createMockCtx();
    const result = await createFfmpegCommand().execute(['-i', 'in.mp4', 'out.gif'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/produced no output file/i);
  });

  it('fails when the core reports exit 0 but the output file is empty', async () => {
    useFakeFfmpeg(makeFakeFfmpeg({ exitCode: 0, readFile: () => new Uint8Array() }));
    const ctx = createMockCtx();
    const result = await createFfmpegCommand().execute(['-i', 'in.mp4', 'out.gif'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/empty output file/i);
  });

  it('propagates a non-zero core exit code', async () => {
    useFakeFfmpeg(makeFakeFfmpeg({ exitCode: 69 }));
    const ctx = createMockCtx();
    const result = await createFfmpegCommand().execute(['-i', 'in.mp4', 'out.gif'], ctx);
    expect(result.exitCode).toBe(69);
  });

  it('writes the output and exits 0 when a non-empty file is produced', async () => {
    useFakeFfmpeg(makeFakeFfmpeg({ exitCode: 0, readFile: () => new Uint8Array([9, 9, 9]) }));
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockCtx({ fs: { writeFile } });
    const result = await createFfmpegCommand().execute(['-i', 'in.mp4', 'out.gif'], ctx);
    expect(result.exitCode).toBe(0);
    expect(writeFile).toHaveBeenCalledWith('/home/out.gif', expect.any(Uint8Array));
  });
});

describe('runWasmFfmpeg lavfi/virtual inputs (NS2b)', () => {
  beforeEach(() => {
    vi.mocked(getFfmpeg).mockReset();
  });

  it('passes the lavfi spec through without VFS resolution or MEMFS staging', async () => {
    const fake = makeFakeFfmpeg({ exitCode: 0, readFile: () => new Uint8Array([1, 2, 3]) });
    useFakeFfmpeg(fake);
    const exists = vi.fn().mockResolvedValue(true);
    const writeVfs = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockCtx({ fs: { exists, writeFile: writeVfs } });

    const result = await createFfmpegCommand().execute(
      ['-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=30', '-frames:v', '1', 'out.png'],
      ctx
    );

    expect(result.exitCode).toBe(0);
    // The filter spec must reach the core verbatim — not a MEMFS name.
    const execArgs = fake.exec.mock.calls[0][0] as string[];
    const iIdx = execArgs.indexOf('-i');
    expect(execArgs[iIdx + 1]).toBe('testsrc=duration=5:size=320x240:rate=30');
    // Virtual inputs are never resolved against the VFS nor staged.
    expect(exists).not.toHaveBeenCalled();
    expect(fake.writeFile).not.toHaveBeenCalled();
    // The produced output is still written back to the VFS.
    expect(writeVfs).toHaveBeenCalledWith('/home/out.png', expect.any(Uint8Array));
  });
});
