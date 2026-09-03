import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FsStat, IFileSystem } from 'just-bash';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCameraRequest,
  createFfmpegCommand,
  createIpkContextFromCtx,
  ensureNullMuxerOpts,
  isAnalysisSink,
  isAvfoundationCapture,
  parseAvfoundationDeviceSpec,
  parseConcatList,
  parseFfmpegArgs,
  permissionKindsFor,
  requestCapturePermission,
} from '../../../src/shell/supplemental-commands/ffmpeg-command.js';
import {
  BUNDLED_FFMPEG_CORE_VERSION,
  FFMPEG_CORE_NOT_INSTALLED,
  getFfmpeg,
  recycleFfmpeg,
  selectFfmpegCore,
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
  return { ...actual, getFfmpeg: vi.fn(), recycleFfmpeg: vi.fn() };
});

// The page-realm branch of `requestCapturePermission` looks up the
// leader permissions surface in `base/`; mock it so a test can drive
// the in-tab `surface.prompt(...)` path.
const { leaderSurfaceHolder } = vi.hoisted(() => ({
  leaderSurfaceHolder: { value: null as { prompt: (...args: unknown[]) => unknown } | null },
}));
vi.mock('../../../src/base/permissions-surface-registry.js', () => ({
  getLeaderPermissionsSurface: () => leaderSurfaceHolder.value,
}));

type FakeFfmpeg = {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  deleteFile: ReturnType<typeof vi.fn>;
  createDir: ReturnType<typeof vi.fn>;
  mount: ReturnType<typeof vi.fn>;
  unmount: ReturnType<typeof vi.fn>;
  deleteDir: ReturnType<typeof vi.fn>;
};

/** Flat names of every input the fake was asked to mount (WORKERFS). */
function mountedNames(fake: FakeFfmpeg): string[] {
  return fake.mount.mock.calls.flatMap(([, opts]) =>
    (opts as { blobs: Array<{ name: string }> }).blobs.map((b) => b.name)
  );
}

/** Mounted `name → Blob` across every mount call. */
function mountedBlobs(fake: FakeFfmpeg): Map<string, Blob> {
  return new Map(
    fake.mount.mock.calls.flatMap(([, opts]) =>
      (opts as { blobs: Array<{ name: string; data: Blob }> }).blobs.map(
        (b) => [b.name, b.data] as const
      )
    )
  );
}

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
    createDir: vi.fn().mockResolvedValue(true),
    mount: vi.fn().mockResolvedValue(true),
    unmount: vi.fn().mockResolvedValue(true),
    deleteDir: vi.fn().mockResolvedValue(true),
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

  it('treats -safe as value-taking so it cannot swallow the input format', () => {
    const parsed = parseFfmpegArgs([
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      'list.txt',
      '-c',
      'copy',
      'joined.mp4',
    ]);
    // The canonical concat incantation. When `-safe` was treated as a
    // boolean toggle, `0` parsed as a positional: it became a phantom
    // output path and flushed the pending `-f concat` into ITS output
    // options, so `-f concat` never reached the next `-i` and the core
    // probed the list as media.
    expect(parsed.inputs).toHaveLength(1);
    expect(parsed.inputs[0].format).toBe('concat');
    expect(parsed.inputs[0].raw).toEqual(['-f', 'concat', '-safe', '0', '-i', 'list.txt']);
    expect(parsed.outputPath).toBe('joined.mp4');
    expect(parsed.outputOpts).toEqual(['-c', 'copy']);
  });
});

describe('parseFfmpegArgs value-taking flags', () => {
  it('keeps -c copy and the bitstream filter on a remux to mpegts', () => {
    // The field regression: `-bsf:v` parsed as a toggle, so
    // `h264_mp4toannexb` became a phantom output positional and took
    // the pending `-c copy` with it. Both vanished from argv and the
    // stream copy silently became a full re-encode.
    const parsed = parseFfmpegArgs([
      '-i',
      'in.mp4',
      '-c',
      'copy',
      '-bsf:v',
      'h264_mp4toannexb',
      '-f',
      'mpegts',
      'out.ts',
    ]);
    expect(parsed.inputs.map((i) => i.path)).toEqual(['in.mp4']);
    expect(parsed.outputPath).toBe('out.ts');
    expect(parsed.outputOpts).toEqual(['-c', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'mpegts']);
  });

  it('carries -bsf:a through an mp4 remux', () => {
    const parsed = parseFfmpegArgs([
      '-i',
      'all.ts',
      '-c',
      'copy',
      '-bsf:a',
      'aac_adtstoasc',
      'cut.mp4',
    ]);
    expect(parsed.outputPath).toBe('cut.mp4');
    expect(parsed.outputOpts).toEqual(['-c', 'copy', '-bsf:a', 'aac_adtstoasc']);
  });

  it('lets an unrecognized option consume its value', () => {
    const parsed = parseFfmpegArgs(['-i', 'in.mp4', '-totally_unknown', 'value', 'out.mp4']);
    expect(parsed.outputPath).toBe('out.mp4');
    expect(parsed.outputOpts).toEqual(['-totally_unknown', 'value']);
  });

  it('does not let an unrecognized toggle swallow the output path', () => {
    // Nothing follows `out.mp4`, so it is the output — never a value.
    const parsed = parseFfmpegArgs(['-i', 'in.mp4', '-some_toggle', 'out.mp4']);
    expect(parsed.outputPath).toBe('out.mp4');
    expect(parsed.outputOpts).toEqual(['-some_toggle']);
  });

  it('treats an unrecognized flag followed by another option as a toggle', () => {
    const parsed = parseFfmpegArgs(['-i', 'in.mp4', '-some_toggle', '-c', 'copy', 'out.mp4']);
    expect(parsed.outputPath).toBe('out.mp4');
    expect(parsed.outputOpts).toEqual(['-some_toggle', '-c', 'copy']);
  });

  it('keeps known toggles from consuming the next token', () => {
    const parsed = parseFfmpegArgs(['-i', 'a.mp4', '-i', 'b.mp4', '-shortest', '-y', 'out.mp4']);
    expect(parsed.inputs.map((i) => i.path)).toEqual(['a.mp4', 'b.mp4']);
    expect(parsed.outputPath).toBe('out.mp4');
    expect(parsed.outputOpts).toEqual(['-shortest', '-y']);
  });

  it('keeps the output when options trail it', () => {
    // `-bitexact` is a real no-arg option and the output is not the
    // last token here, so a "last argv entry" rule would consume
    // out.mp4 as its value and leave the invocation with no output.
    const parsed = parseFfmpegArgs(['-i', 'in.mp4', '-bitexact', 'out.mp4', '-y']);
    expect(parsed.outputPath).toBe('out.mp4');
    expect(parsed.outputOpts).toEqual(['-bitexact']);
  });

  it('keeps the output when an UNLISTED toggle is trailed by options', () => {
    const parsed = parseFfmpegArgs(['-i', 'in.mp4', '-brand_new_toggle', 'out.mp4', '-y']);
    expect(parsed.outputPath).toBe('out.mp4');
    expect(parsed.outputOpts).toEqual(['-brand_new_toggle']);
  });

  it('still consumes a value when another positional follows it', () => {
    const parsed = parseFfmpegArgs(['-i', 'in.mp4', '-unknown_opt', 'val', 'out.mp4', '-y']);
    expect(parsed.outputPath).toBe('out.mp4');
    // `-y` follows the output positional, so it binds to a next output
    // that never arrives — pre-existing option-binding semantics, not
    // something the arity rule changes.
    expect(parsed.outputOpts).toEqual(['-unknown_opt', 'val']);
  });

  it('counts a lone `-` sink as a positional so earlier options keep their values', () => {
    // `-` is ffmpeg's stdin/stdout filename. Before it was recognised
    // as a positional here, `-unknown_opt` saw nothing after it that
    // could serve as the output, so it parsed as a toggle and `val`
    // became a phantom output — dropping BOTH tokens from argv.
    const parsed = parseFfmpegArgs(['-i', 'in.mp4', '-unknown_opt', 'val', '-f', 'null', '-']);
    expect(parsed.outputPath).toBe('-');
    expect(parsed.outputOpts).toEqual(['-unknown_opt', 'val', '-f', 'null']);
  });

  it('binds an unknown option to the next INPUT, not the output', () => {
    const parsed = parseFfmpegArgs(['-hwaccel', 'auto', '-i', 'in.mp4', 'out.mp4']);
    expect(parsed.inputs[0].raw).toEqual(['-hwaccel', 'auto', '-i', 'in.mp4']);
    expect(parsed.outputOpts).toEqual([]);
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
      expect.objectContaining({ kinds: ['camera'], skipIfGranted: true }),
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
      expect(leaderSurfaceHolder.value?.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ kinds: ['camera'], skipIfGranted: true })
      );
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
    expect(calls[0].payload).toMatchObject({ kinds: ['camera'], skipIfGranted: true });
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

describe('selectFfmpegCore', () => {
  /** Fake ipk context with configurable installed core packages. */
  function makeCoreIpk(opts: { core?: boolean; mt?: boolean; mtWorkerMissing?: boolean }) {
    const sources = new Map<string, string>();
    const bytes = new Map<string, Uint8Array>();
    const dirs = new Set<string>(['/workspace', '/workspace/node_modules']);
    const install = (pkg: string, withWorker: boolean) => {
      const root = `/workspace/node_modules/${pkg}`;
      for (const d of [`/workspace/node_modules/@ffmpeg`, root, `${root}/dist`, `${root}/dist/esm`])
        dirs.add(d);
      sources.set(`${root}/package.json`, JSON.stringify({ name: pkg, version: '0.12.10' }));
      sources.set(`${root}/dist/esm/ffmpeg-core.js`, `/* ${pkg} glue */`);
      bytes.set(`${root}/dist/esm/ffmpeg-core.wasm`, new Uint8Array([0x00, 0x61, 0x73, 0x6d]));
      if (withWorker) {
        sources.set(`${root}/dist/esm/ffmpeg-core.worker.js`, `/* ${pkg} pthread worker */`);
      }
    };
    if (opts.core) install('@ffmpeg/core', false);
    if (opts.mt) install('@ffmpeg/core-mt', !opts.mtWorkerMissing);
    return {
      reader: {
        exists: async (p: string) => sources.has(p) || bytes.has(p) || dirs.has(p),
        isDirectory: async (p: string) => dirs.has(p),
        readFile: async (p: string) => {
          const v = sources.get(p);
          if (v === undefined) throw new Error(`ENOENT: ${p}`);
          return v;
        },
      },
      readBytes: async (p: string) => {
        const v = bytes.get(p);
        if (!v) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      fromDir: '/workspace',
    };
  }

  it('prefers @ffmpeg/core-mt (with pthread worker) when isolated and installed', async () => {
    const loaded = await selectFfmpegCore(makeCoreIpk({ core: true, mt: true }), true);
    expect(loaded?.pkg).toBe('@ffmpeg/core-mt');
    expect(loaded?.workerSource).toContain('pthread worker');
  });

  it('falls back to @ffmpeg/core when isolated but -mt is not installed', async () => {
    const loaded = await selectFfmpegCore(makeCoreIpk({ core: true }), true);
    expect(loaded?.pkg).toBe('@ffmpeg/core');
    expect(loaded?.workerSource).toBeUndefined();
  });

  it('ignores an installed -mt core when the runtime is not isolated', async () => {
    const loaded = await selectFfmpegCore(makeCoreIpk({ core: true, mt: true }), false);
    expect(loaded?.pkg).toBe('@ffmpeg/core');
  });

  it('treats an -mt install missing its worker file as not installed', async () => {
    const loaded = await selectFfmpegCore(
      makeCoreIpk({ core: true, mt: true, mtWorkerMissing: true }),
      true
    );
    expect(loaded?.pkg).toBe('@ffmpeg/core');
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

  it('reports ready on an isolated leader with ONLY @ffmpeg/core-mt installed', async () => {
    // The version gate resolves through the loader's no-arg (isolation-
    // aware) form — an mt-only install that transcoding would happily
    // boot must not report "not installed".
    const root = '/workspace/node_modules/@ffmpeg/core-mt';
    const sources = new Map<string, string>([
      [`${root}/package.json`, JSON.stringify({ name: '@ffmpeg/core-mt', version: '0.12.10' })],
      [`${root}/dist/esm/ffmpeg-core.js`, '/* mt glue */'],
      [`${root}/dist/esm/ffmpeg-core.worker.js`, '/* pthread worker */'],
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
    const ctx = createMockCtx({
      cwd: '/workspace',
      fs: {
        exists: vi.fn(async (p: string) => sources.has(p) || bytes.has(p) || dirs.has(p)),
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
        stat: vi.fn(async (p: string) => ({ isDirectory: dirs.has(p) }) as unknown as FsStat),
      },
    });
    vi.stubGlobal('crossOriginIsolated', true);
    try {
      const result = await createFfmpegCommand().execute(['-version'], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ffmpeg');
      expect(result.stderr).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
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

describe('runWasmFfmpeg core-fault recycling', () => {
  beforeEach(() => {
    vi.mocked(getFfmpeg).mockReset();
    vi.mocked(recycleFfmpeg).mockReset();
  });

  /** A core that traps on `exec`, the way a blown wasm heap does. */
  function trappingFfmpeg(): FakeFfmpeg {
    const fake = makeFakeFfmpeg({ exitCode: 0 });
    fake.exec.mockRejectedValue(new WebAssembly.RuntimeError('memory access out of bounds'));
    return fake;
  }

  it('recycles the shared core when the wasm module traps', async () => {
    useFakeFfmpeg(trappingFfmpeg());
    const result = await createFfmpegCommand().execute(
      ['-i', 'in.mp4', 'out.mp4'],
      createMockCtx()
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/memory access out of bounds/);
    expect(recycleFfmpeg).toHaveBeenCalledTimes(1);
  });

  it('tells the caller the core was recycled so a retry is worth it', async () => {
    useFakeFfmpeg(trappingFfmpeg());
    const result = await createFfmpegCommand().execute(
      ['-i', 'in.mp4', 'out.mp4'],
      createMockCtx()
    );

    expect(result.stderr).toMatch(/faulted and was recycled; retry the command/);
  });

  it('skips MEMFS cleanup against a core that just faulted', async () => {
    const fake = trappingFfmpeg();
    useFakeFfmpeg(fake);
    await createFfmpegCommand().execute(['-i', 'in.mp4', 'out.mp4'], createMockCtx());

    // Every deleteFile / unmount would re-enter the trapped module.
    expect(fake.deleteFile).not.toHaveBeenCalled();
    expect(fake.unmount).not.toHaveBeenCalled();
  });

  it('recycles when mounting the inputs throws', async () => {
    const fake = makeFakeFfmpeg({ exitCode: 0 });
    fake.mount.mockRejectedValue(new Error('FS error: out of memory'));
    useFakeFfmpeg(fake);

    const result = await createFfmpegCommand().execute(
      ['-i', 'in.mp4', 'out.mp4'],
      createMockCtx()
    );

    expect(result.exitCode).toBe(1);
    expect(recycleFfmpeg).toHaveBeenCalledTimes(1);
  });

  it('leaves the core alone for an ordinary non-zero exit', async () => {
    // Bad flags and unsupported codecs are reported as an exit code,
    // not a throw — the instance is still healthy.
    const fake = makeFakeFfmpeg({ exitCode: 69 });
    useFakeFfmpeg(fake);

    const result = await createFfmpegCommand().execute(
      ['-i', 'in.mp4', 'out.mp4'],
      createMockCtx()
    );

    expect(result.exitCode).toBe(69);
    expect(recycleFfmpeg).not.toHaveBeenCalled();
    expect(fake.deleteFile).toHaveBeenCalled();
  });

  it('leaves the core alone when the output file is missing or empty', async () => {
    useFakeFfmpeg(makeFakeFfmpeg({ exitCode: 0, readFile: () => new Uint8Array() }));

    const result = await createFfmpegCommand().execute(
      ['-i', 'in.mp4', 'out.mp4'],
      createMockCtx()
    );

    expect(result.exitCode).toBe(1);
    expect(recycleFfmpeg).not.toHaveBeenCalled();
  });
});

describe('runWasmFfmpeg fault classification', () => {
  beforeEach(() => {
    vi.mocked(getFfmpeg).mockReset();
    vi.mocked(recycleFfmpeg).mockReset();
  });

  it('recycles when the trap only surfaces on readback', async () => {
    // `exec` can return a stale 0 after an internal Aborted(); the
    // trap then lands on readFile. Treating that as "no output" would
    // leave the poisoned instance cached — the very bug being fixed.
    const fake = makeFakeFfmpeg({ exitCode: 0 });
    fake.readFile.mockRejectedValue(new WebAssembly.RuntimeError('memory access out of bounds'));
    useFakeFfmpeg(fake);

    const result = await createFfmpegCommand().execute(
      ['-i', 'in.mp4', 'out.mp4'],
      createMockCtx()
    );

    expect(result.exitCode).toBe(1);
    expect(recycleFfmpeg).toHaveBeenCalledTimes(1);
    expect(result.stderr).toMatch(/faulted and was recycled/);
    expect(fake.deleteFile).not.toHaveBeenCalled();
  });

  it('still reports a merely missing output without recycling', async () => {
    const fake = makeFakeFfmpeg({ exitCode: 0 });
    fake.readFile.mockRejectedValue(new Error('FS error: no such file or directory'));
    useFakeFfmpeg(fake);

    const result = await createFfmpegCommand().execute(
      ['-i', 'in.mp4', 'out.mp4'],
      createMockCtx()
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/produced no output file/i);
    expect(recycleFfmpeg).not.toHaveBeenCalled();
  });

  it('passes the faulting instance to recycleFfmpeg', async () => {
    // Without the identity, a slow run could retire a healthy core
    // that a faster retry had already installed.
    const fake = makeFakeFfmpeg({ exitCode: 0 });
    fake.exec.mockRejectedValue(new WebAssembly.RuntimeError('memory access out of bounds'));
    useFakeFfmpeg(fake);

    await createFfmpegCommand().execute(['-i', 'in.mp4', 'out.mp4'], createMockCtx());

    expect(recycleFfmpeg).toHaveBeenCalledWith(fake);
  });

  it('does not blame the core when the VFS write fails', async () => {
    // A read-only mount or an exhausted quota is not a wasm fault:
    // no recycle, no 31 MB reboot, and MEMFS still gets tidied.
    const fake = makeFakeFfmpeg({ exitCode: 0, readFile: () => new Uint8Array([1, 2, 3]) });
    useFakeFfmpeg(fake);
    const writeFile = vi.fn().mockRejectedValue(new Error('EROFS: read-only file system'));
    const ctx = createMockCtx({ fs: { writeFile } });

    const result = await createFfmpegCommand().execute(['-i', 'in.mp4', 'out.mp4'], ctx);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/cannot write out\.mp4: EROFS/);
    expect(result.stderr).not.toMatch(/faulted and was recycled/);
    expect(recycleFfmpeg).not.toHaveBeenCalled();
    expect(fake.deleteFile).toHaveBeenCalled();
  });
});

describe('parseConcatList', () => {
  it('extracts single-quoted file directives', () => {
    const lines = parseConcatList("file '01.mp4'\nfile '02.mp4'\n");
    expect(lines.filter((l) => l.file).map((l) => l.file)).toEqual(['01.mp4', '02.mp4']);
  });

  it('accepts bare and double-quoted paths', () => {
    const lines = parseConcatList('file bare.mp4\nfile "quoted one.mp4"\n');
    expect(lines.filter((l) => l.file).map((l) => l.file)).toEqual(['bare.mp4', 'quoted one.mp4']);
  });

  it("unquotes an embedded apostrophe written as '\\''", () => {
    const lines = parseConcatList("file 'it'\\''s.mp4'\n");
    expect(lines.find((l) => l.file)?.file).toBe("it's.mp4");
  });

  it('carries non-file directives, comments and blanks through untouched', () => {
    const text = "ffconcat version 1.0\n# a comment\n\nfile 'a.mp4'\nduration 4.6\n";
    const lines = parseConcatList(text);
    expect(lines.filter((l) => l.file)).toHaveLength(1);
    expect(lines.map((l) => l.raw)).toEqual([
      'ffconcat version 1.0',
      '# a comment',
      '',
      "file 'a.mp4'",
      'duration 4.6',
      '',
    ]);
  });

  it('decodes backslash escapes in a bare path', () => {
    // `file clip\ one.mp4` is valid ffmpeg; the member is "clip one.mp4".
    const lines = parseConcatList('file clip\\ one.mp4\n');
    expect(lines.find((l) => l.file)?.file).toBe('clip one.mp4');
  });

  it('does not treat a filename starting with "file" as a directive', () => {
    expect(parseConcatList('filelist.mp4\n').filter((l) => l.file)).toHaveLength(0);
  });
});

describe('runWasmFfmpeg concat demuxer', () => {
  beforeEach(() => {
    vi.mocked(getFfmpeg).mockReset();
  });

  /** VFS holding a concat list plus the members it names. */
  function concatCtx(list: string, members: Record<string, Uint8Array>) {
    const files: Record<string, Uint8Array> = {
      '/clips/list.txt': new TextEncoder().encode(list),
      ...members,
    };
    return createMockCtx({
      cwd: '/clips',
      fs: {
        exists: vi.fn(async (p: string) => p in files),
        readFileBuffer: vi.fn(async (p: string) => {
          const v = files[p];
          if (!v) throw new Error(`ENOENT: ${p}`);
          return v;
        }),
      },
    });
  }

  it('stages every member named in the list and rewrites the list to match', async () => {
    const fake = makeFakeFfmpeg({ exitCode: 0, readFile: () => new Uint8Array([7, 7]) });
    useFakeFfmpeg(fake);
    const ctx = concatCtx("file '01.mp4'\nfile '02.mp4'\n", {
      '/clips/01.mp4': new Uint8Array([1]),
      '/clips/02.mp4': new Uint8Array([2]),
    });

    const result = await createFfmpegCommand().execute(
      ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'joined.mp4'],
      ctx
    );

    expect(result.exitCode).toBe(0);
    const staged = mountedBlobs(fake);
    // Both members were mounted...
    const memberNames = [...staged.keys()].filter((n) => n.startsWith('__cat'));
    expect(memberNames).toHaveLength(2);
    // ...and the list the core sees points at exactly those names (inside
    // the invocation's mount directory), not at the original VFS paths.
    const listName = [...staged.keys()].find((n) => n.endsWith('list.txt'));
    const rewritten = await (staged.get(listName as string) as Blob).text();
    const mountDir = (fake.mount.mock.calls[0][2] as string).replace(/^\//, '');
    for (const name of memberNames) expect(rewritten).toContain(`file '${mountDir}/${name}'`);
    // The original directives are gone — a bare `01.mp4` would send
    // the demuxer looking for a MEMFS file that was never staged.
    expect(rewritten).not.toContain("file '01.mp4'");
    expect(rewritten).not.toContain("file '02.mp4'");
  });

  it('mounts members and the list together so the demuxer can open them', async () => {
    const fake = makeFakeFfmpeg({ exitCode: 0, readFile: () => new Uint8Array([7]) });
    useFakeFfmpeg(fake);
    const ctx = concatCtx("file '01.mp4'\n", { '/clips/01.mp4': new Uint8Array([1]) });

    await createFfmpegCommand().execute(['-f', 'concat', '-i', 'list.txt', 'out.mp4'], ctx);

    // One WORKERFS mount per invocation carries every staged file, so the
    // member exists the moment the demuxer reads the list.
    expect(fake.mount).toHaveBeenCalledTimes(1);
    const names = mountedNames(fake);
    expect(names.some((n) => n.startsWith('__cat'))).toBe(true);
    expect(names.some((n) => n.endsWith('list.txt'))).toBe(true);
    // Nothing is copied into MEMFS any more.
    expect(fake.writeFile).not.toHaveBeenCalled();
  });

  it('resolves member paths against the list file, not the shell cwd', async () => {
    const fake = makeFakeFfmpeg({ exitCode: 0, readFile: () => new Uint8Array([7]) });
    useFakeFfmpeg(fake);
    // cwd is /home; the list lives in /clips and names a sibling.
    const files: Record<string, Uint8Array> = {
      '/clips/list.txt': new TextEncoder().encode("file '01.mp4'\n"),
      '/clips/01.mp4': new Uint8Array([1]),
    };
    const ctx = createMockCtx({
      cwd: '/home',
      fs: {
        exists: vi.fn(async (p: string) => p in files),
        readFileBuffer: vi.fn(async (p: string) => {
          const v = files[p];
          if (!v) throw new Error(`ENOENT: ${p}`);
          return v;
        }),
      },
    });

    const result = await createFfmpegCommand().execute(
      ['-f', 'concat', '-i', '/clips/list.txt', 'out.mp4'],
      ctx
    );

    expect(result.exitCode).toBe(0);
    expect(ctx.fs.exists).toHaveBeenCalledWith('/clips/01.mp4');
  });

  it('names the missing member when the list points at a file that is gone', async () => {
    useFakeFfmpeg(makeFakeFfmpeg({ exitCode: 0 }));
    const ctx = concatCtx("file '01.mp4'\nfile 'gone.mp4'\n", {
      '/clips/01.mp4': new Uint8Array([1]),
    });

    const result = await createFfmpegCommand().execute(
      ['-f', 'concat', '-i', 'list.txt', 'out.mp4'],
      ctx
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('concat list list.txt: file not found: gone.mp4');
  });

  it('unmounts the staged inputs after the run', async () => {
    const fake = makeFakeFfmpeg({ exitCode: 0, readFile: () => new Uint8Array([7]) });
    useFakeFfmpeg(fake);
    const ctx = concatCtx("file '01.mp4'\nfile '02.mp4'\n", {
      '/clips/01.mp4': new Uint8Array([1]),
      '/clips/02.mp4': new Uint8Array([2]),
    });

    await createFfmpegCommand().execute(['-f', 'concat', '-i', 'list.txt', 'out.mp4'], ctx);

    const mountPoint = fake.mount.mock.calls[0][2] as string;
    expect(fake.unmount).toHaveBeenCalledWith(mountPoint);
    expect(fake.deleteDir).toHaveBeenCalledWith(mountPoint);
  });

  it('rejects a parent-traversing member unless -safe 0 is given', async () => {
    // Real ffmpeg refuses this at safe=1. Rewriting members to flat
    // `__cat…` names would make its own check pass vacuously, so the
    // wrapper has to enforce it on the path the user wrote.
    useFakeFfmpeg(makeFakeFfmpeg({ exitCode: 0 }));
    const ctx = concatCtx("file '../secret.mp4'\n", {
      '/secret.mp4': new Uint8Array([1]),
    });

    const result = await createFfmpegCommand().execute(
      ['-f', 'concat', '-i', 'list.txt', 'out.mp4'],
      ctx
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unsafe file name: ../secret.mp4');
    expect(result.stderr).toContain('-safe 0');
  });

  it('rejects an absolute member at the default safe level', async () => {
    useFakeFfmpeg(makeFakeFfmpeg({ exitCode: 0 }));
    const ctx = concatCtx("file '/abs.mp4'\n", { '/abs.mp4': new Uint8Array([1]) });

    const result = await createFfmpegCommand().execute(
      ['-f', 'concat', '-i', 'list.txt', 'out.mp4'],
      ctx
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unsafe file name: /abs.mp4');
  });

  it('allows an absolute member once -safe 0 is passed', async () => {
    const fake = makeFakeFfmpeg({ exitCode: 0, readFile: () => new Uint8Array([7]) });
    useFakeFfmpeg(fake);
    const ctx = concatCtx("file '/abs.mp4'\n", { '/abs.mp4': new Uint8Array([1]) });

    const result = await createFfmpegCommand().execute(
      ['-f', 'concat', '-safe', '0', '-i', 'list.txt', 'out.mp4'],
      ctx
    );

    expect(result.exitCode).toBe(0);
    expect(mountedNames(fake).some((n) => n.startsWith('__cat'))).toBe(true);
  });

  it('leaves an ordinary input untouched by the concat path', async () => {
    const fake = makeFakeFfmpeg({ exitCode: 0, readFile: () => new Uint8Array([7]) });
    useFakeFfmpeg(fake);

    await createFfmpegCommand().execute(['-i', 'in.mp4', 'out.mp4'], createMockCtx());

    expect(mountedNames(fake)).toEqual(['__in0_in.mp4']);
    // argv points into the invocation's mount directory.
    const execArgs = fake.exec.mock.calls[0][0] as string[];
    expect(execArgs[execArgs.indexOf('-i') + 1]).toMatch(/^__in\d+_[a-z0-9]+\/__in0_in\.mp4$/);
  });
});

describe('runWasmFfmpeg analysis sinks (-f null)', () => {
  beforeEach(() => {
    vi.mocked(getFfmpeg).mockReset();
    vi.mocked(recycleFfmpeg).mockReset();
  });

  it('parseFfmpegArgs treats lone - as an output positional (not a flag)', () => {
    const parsed = parseFfmpegArgs([
      '-i',
      'in.mp4',
      '-af',
      'silencedetect=noise=-30dB:d=0.5',
      '-f',
      'null',
      '-',
    ]);
    expect(parsed.outputPath).toBe('-');
    expect(parsed.outputOpts).toEqual(['-af', 'silencedetect=noise=-30dB:d=0.5', '-f', 'null']);
    expect(isAnalysisSink(parsed)).toBe(true);
  });

  it('parseFfmpegArgs does not treat bare - without -f null as an output', () => {
    // Without the null muxer, `-` would mean stdout (not emulated).
    // Accepting it as a positional would write a VFS file named `-`.
    const bare = parseFfmpegArgs(['-i', 'in.mp4', '-']);
    expect(bare.outputPath).toBeNull();
    const mp3Dash = parseFfmpegArgs(['-i', 'in.wav', '-f', 'mp3', '-']);
    expect(mp3Dash.outputPath).toBeNull();
  });

  it('rejects non-null - output with a clear missing-output error', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const result = await createFfmpegCommand().execute(
      ['-i', 'in.wav', '-f', 'mp3', '-'],
      createMockCtx({ fs: { writeFile } })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/at least one output file must be specified/i);
    expect(writeFile).not.toHaveBeenCalled();
    expect(getFfmpeg).not.toHaveBeenCalled();
  });

  it('isAnalysisSink accepts -f null /dev/null and bare /dev/null', () => {
    expect(
      isAnalysisSink(
        parseFfmpegArgs([
          '-i',
          'in.mp4',
          '-af',
          'loudnorm=print_format=json',
          '-f',
          'null',
          '/dev/null',
        ])
      )
    ).toBe(true);
    expect(isAnalysisSink(parseFfmpegArgs(['-i', 'in.mp4', '-af', 'loudnorm', '/dev/null']))).toBe(
      true
    );
    // Bare `-` without `-f null` is not an output positional at all.
    expect(isAnalysisSink(parseFfmpegArgs(['-i', 'in.mp4', '-']))).toBe(false);
    // Real output path with `-f null` is still an encode artifact.
    expect(isAnalysisSink(parseFfmpegArgs(['-i', 'in.mp4', '-f', 'null', 'dump.bin']))).toBe(false);
  });

  it('ensureNullMuxerOpts injects -f null when missing', () => {
    expect(ensureNullMuxerOpts(['-af', 'loudnorm'])).toEqual(['-af', 'loudnorm', '-f', 'null']);
    expect(ensureNullMuxerOpts(['-af', 'loudnorm', '-f', 'null'])).toEqual([
      '-af',
      'loudnorm',
      '-f',
      'null',
    ]);
  });

  it('succeeds for -f null - and returns the captured log without VFS writeback', async () => {
    const fake = makeFakeFfmpeg({
      exitCode: 0,
      readFile: () => {
        throw new Error('FS error: no such file or directory');
      },
    });
    // Emit a silencedetect-shaped log through the on('log') handler.
    fake.on.mockImplementation((event: string, handler: (e: { message: string }) => void) => {
      if (event === 'log') {
        handler({ message: '[silencedetect @ 0x0] silence_start: 0.5' });
        handler({ message: '[silencedetect @ 0x0] silence_end: 1.2 | silence_duration: 0.7' });
      }
    });
    useFakeFfmpeg(fake);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockCtx({ fs: { writeFile } });

    const result = await createFfmpegCommand().execute(
      ['-i', 'in.mp4', '-af', 'silencedetect=noise=-30dB:d=0.5', '-f', 'null', '-'],
      ctx
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/silence_start: 0\.5/);
    expect(result.stderr).toMatch(/silence_duration: 0\.7/);
    expect(fake.readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    const execArgs = fake.exec.mock.calls[0][0] as string[];
    expect(execArgs.at(-1)).toMatch(/^__null_sink/);
    expect(execArgs).toContain('-f');
    expect(execArgs[execArgs.indexOf('-f') + 1]).toBe('null');
  });

  it('succeeds for -f null /dev/null and returns the captured log', async () => {
    const fake = makeFakeFfmpeg({
      exitCode: 0,
      readFile: () => {
        throw new Error('FS error: no such file or directory');
      },
    });
    fake.on.mockImplementation((event: string, handler: (e: { message: string }) => void) => {
      if (event === 'log') {
        handler({ message: 'Input Integrated loudness: -14.0 LUFS' });
      }
    });
    useFakeFfmpeg(fake);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockCtx({ fs: { writeFile } });

    const result = await createFfmpegCommand().execute(
      ['-i', 'in.mp4', '-af', 'loudnorm=print_format=json', '-f', 'null', '/dev/null'],
      ctx
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/Integrated loudness/);
    expect(fake.readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('injects -f null for bare /dev/null so the core gets a muxer', async () => {
    const fake = makeFakeFfmpeg({
      exitCode: 0,
      readFile: () => {
        throw new Error('FS error: no such file or directory');
      },
    });
    fake.on.mockImplementation((event: string, handler: (e: { message: string }) => void) => {
      if (event === 'log') {
        handler({ message: 'Input Integrated loudness: -16.0 LUFS' });
      }
    });
    useFakeFfmpeg(fake);

    const result = await createFfmpegCommand().execute(
      ['-i', 'in.mp4', '-af', 'loudnorm=print_format=json', '/dev/null'],
      createMockCtx()
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/Integrated loudness/);
    const execArgs = fake.exec.mock.calls[0][0] as string[];
    expect(execArgs.at(-1)).toMatch(/^__null_sink/);
    // Must include `-f null` even though the CLI omitted it — otherwise
    // the pinned core exits 1: "Unable to find a suitable output format".
    const fIdx = execArgs.lastIndexOf('-f');
    expect(fIdx).toBeGreaterThanOrEqual(0);
    expect(execArgs[fIdx + 1]).toBe('null');
  });

  it('still fails a normal encode with a missing or empty output', async () => {
    useFakeFfmpeg(
      makeFakeFfmpeg({
        exitCode: 0,
        readFile: () => {
          throw new Error('FS error: no such file or directory');
        },
      })
    );
    const missing = await createFfmpegCommand().execute(
      ['-i', 'in.mp4', 'out.gif'],
      createMockCtx()
    );
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toMatch(/produced no output file/i);

    useFakeFfmpeg(makeFakeFfmpeg({ exitCode: 0, readFile: () => new Uint8Array() }));
    const empty = await createFfmpegCommand().execute(['-i', 'in.mp4', 'out.gif'], createMockCtx());
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toMatch(/empty output file/i);
  });

  it('does not recycle the core on a successful analysis sink', async () => {
    // Skipping readback must not be confused with a core fault: the
    // null muxer leaves no MEMFS artifact by design. The health probe
    // (write+delete) must succeed for the instance to stay cached.
    const fake = makeFakeFfmpeg({
      exitCode: 0,
      readFile: () => {
        throw new Error('FS error: no such file or directory');
      },
    });
    useFakeFfmpeg(fake);

    const result = await createFfmpegCommand().execute(
      ['-i', 'in.mp4', '-af', 'silencedetect=noise=-30dB:d=0.5', '-f', 'null', '-'],
      createMockCtx()
    );

    expect(result.exitCode).toBe(0);
    expect(recycleFfmpeg).not.toHaveBeenCalled();
    expect(fake.readFile).not.toHaveBeenCalled();
    // Health probe deletes from MEMFS; the inputs are unmounted.
    expect(fake.deleteFile).toHaveBeenCalled();
    expect(fake.unmount).toHaveBeenCalled();
    expect(fake.writeFile).toHaveBeenCalledWith('__health_probe', expect.any(Uint8Array));
  });

  it('recycles and fails when a sink exit 0 leaves a poisoned core', async () => {
    // Stale exit 0 after an internal Aborted() — documented in
    // docs/pitfalls.md. Sinks skip readEncodedOutput, so the health
    // probe must catch the trap and recycle.
    const fake = makeFakeFfmpeg({
      exitCode: 0,
      readFile: () => {
        throw new Error('FS error: no such file or directory');
      },
    });
    fake.writeFile.mockImplementation(async (name: string) => {
      if (name === '__health_probe') {
        throw new WebAssembly.RuntimeError('Aborted()');
      }
    });
    useFakeFfmpeg(fake);

    const result = await createFfmpegCommand().execute(
      ['-i', 'in.mp4', '-af', 'silencedetect=noise=-30dB:d=0.5', '-f', 'null', '-'],
      createMockCtx()
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/wasm core faulted and was recycled/i);
    expect(recycleFfmpeg).toHaveBeenCalledTimes(1);
    expect(recycleFfmpeg).toHaveBeenCalledWith(fake);
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
    // Virtual inputs are never resolved against the VFS nor staged —
    // nothing to mount means no mount at all.
    expect(exists).not.toHaveBeenCalled();
    expect(fake.mount).not.toHaveBeenCalled();
    expect(fake.createDir).not.toHaveBeenCalled();
    // The produced output is still written back to the VFS.
    expect(writeVfs).toHaveBeenCalledWith('/home/out.png', expect.any(Uint8Array));
  });
});
