import type { IFileSystem } from 'just-bash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FFMPEG_CORE_NOT_INSTALLED,
  getFfmpeg,
  recycleFfmpeg,
} from '../../../src/shell/supplemental-commands/ffmpeg-wasm.js';
import {
  channelsFromLayout,
  durationToSeconds,
  parseFfmpegProbeLog,
} from '../../../src/shell/supplemental-commands/ffprobe/log-parse.js';
import {
  createFfprobeCommand,
  inferMemfsName,
  parseFfprobeArgs,
  resetFfprobeLockForTests,
  selectProbeStreams,
} from '../../../src/shell/supplemental-commands/ffprobe/run.js';

vi.mock('../../../src/shell/supplemental-commands/ffmpeg-wasm.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/shell/supplemental-commands/ffmpeg-wasm.js')
  >('../../../src/shell/supplemental-commands/ffmpeg-wasm.js');
  return {
    ...actual,
    getFfmpeg: vi.fn(),
    recycleFfmpeg: vi.fn(),
    tryLoadFfmpegCoreFromNodeModules: vi.fn(),
  };
});

type FakeFfmpeg = {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
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

const SAMPLE_LOG = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '__probe_clip.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf58.76.100
  Duration: 00:00:01.00, start: 0.000000, bitrate: 149 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 320x240 [SAR 1:1 DAR 4:3], 59 kb/s, 25 fps, 25 tbr, 12800 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 70 kb/s (default)
At least one output file must be specified
`;

function makeFakeFfmpeg(opts: { exitCode?: number; log?: string; execError?: Error }): FakeFfmpeg {
  const log = opts.log ?? SAMPLE_LOG;
  return {
    on: vi.fn((event: string, handler: (e: { type: string; message: string }) => void) => {
      if (event === 'log') {
        for (const line of log.split('\n')) {
          handler({ type: 'stderr', message: line });
        }
      }
    }),
    off: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn(async () => {
      if (opts.execError) throw opts.execError;
      return opts.exitCode ?? 1;
    }),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    createDir: vi.fn().mockResolvedValue(true),
    mount: vi.fn().mockResolvedValue(true),
    unmount: vi.fn().mockResolvedValue(true),
    deleteDir: vi.fn().mockResolvedValue(true),
  };
}

function useFakeFfmpeg(fake: FakeFfmpeg): void {
  vi.mocked(getFfmpeg).mockResolvedValue(fake as unknown as Awaited<ReturnType<typeof getFfmpeg>>);
}

function createMockCtx(
  overrides: Partial<{ fs: Partial<IFileSystem>; cwd: string }> = {}
): Parameters<ReturnType<typeof createFfprobeCommand>['execute']>[1] {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    exists: vi.fn().mockResolvedValue(true),
    readFileBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    stat: vi.fn(),
    ...overrides.fs,
  };
  return {
    fs: fs as IFileSystem,
    cwd: overrides.cwd ?? '/home',
    env: new Map<string, string>(),
    stdin: '',
  } as unknown as Parameters<ReturnType<typeof createFfprobeCommand>['execute']>[1];
}

afterEach(() => {
  vi.clearAllMocks();
  resetFfprobeLockForTests();
});

describe('durationToSeconds / channelsFromLayout', () => {
  it('converts HH:MM:SS.ss to decimal seconds', () => {
    expect(durationToSeconds('00:00:01.00')).toBe('1.000000');
    expect(durationToSeconds('01:02:03.5')).toBe('3723.500000');
  });

  it('maps channel layouts to counts, including parenthesised qualifiers', () => {
    expect(channelsFromLayout('mono')).toBe(1);
    expect(channelsFromLayout('stereo')).toBe(2);
    expect(channelsFromLayout('5.1')).toBe(6);
    expect(channelsFromLayout('5.1(side)')).toBe(6);
    expect(channelsFromLayout('7.1(wide)')).toBe(8);
    expect(channelsFromLayout('2 channels')).toBe(2);
  });
});

describe('inferMemfsName', () => {
  it('stages under an opaque apostrophe-safe name while keeping the extension', () => {
    const a = inferMemfsName("/tmp/O'Brien.mp4");
    const b = inferMemfsName("/tmp/O'Brien.mp4");
    expect(a).toMatch(/^__probe_\d+_\d+\.mp4$/);
    expect(a).not.toContain("'");
    expect(a).not.toBe(b);
  });
});

describe('parseFfmpegProbeLog', () => {
  it('extracts format and stream fields from an ffmpeg Input banner', () => {
    const info = parseFfmpegProbeLog(SAMPLE_LOG, 'clip.mp4');
    expect(info).not.toBeNull();
    expect(info!.format.format_name).toBe('mov,mp4,m4a,3gp,3g2,mj2');
    expect(info!.format.duration).toBe('1.000000');
    expect(info!.format.bit_rate).toBe('149000');
    expect(info!.streams).toHaveLength(2);
    expect(info!.streams[0]).toMatchObject({
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      profile: 'High',
      codec_tag_string: 'avc1',
      width: 320,
      height: 240,
      r_frame_rate: '25/1',
    });
    expect(info!.streams[1]).toMatchObject({
      index: 1,
      codec_type: 'audio',
      codec_name: 'aac',
      sample_rate: '44100',
      channels: 1,
      channel_layout: 'mono',
    });
  });

  it('returns null when the log has no Input banner', () => {
    expect(parseFfmpegProbeLog('Error opening input')).toBeNull();
  });

  it('resolves 5.1(side) channel layouts from the audio banner', () => {
    const log = `Input #0, wav, from '__probe_x.wav':
  Duration: 00:00:01.00, start: 0.000000, bitrate: 1411 kb/s
  Stream #0:0: Audio: pcm_s16le, 48000 Hz, 5.1(side), s16, 4608 kb/s
`;
    const info = parseFfmpegProbeLog(log);
    expect(info!.streams[0].channel_layout).toBe('5.1(side)');
    expect(info!.streams[0].channels).toBe(6);
  });
});

describe('parseFfprobeArgs', () => {
  it('accepts a positional input and stays in human mode', () => {
    const parsed = parseFfprobeArgs(['clip.mp4']);
    expect(parsed.inputPath).toBe('clip.mp4');
    expect(parsed.structured).toBe(false);
    expect(parsed.showFormat).toBe(true);
    expect(parsed.showStreams).toBe(true);
  });

  it('parses Remotion-style show_entries + select_streams + default=nw=1:nk=1', () => {
    const parsed = parseFfprobeArgs([
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=channels',
      '-of',
      'default=nw=1:nk=1',
      'clip.mp4',
    ]);
    expect(parsed.quiet).toBe(true);
    expect(parsed.structured).toBe(true);
    expect(parsed.selectStreams).toBe('a:0');
    expect(parsed.showEntries?.stream?.has('channels')).toBe(true);
    expect(parsed.outputFormat).toEqual({ kind: 'default', noWrappers: true, noKey: true });
  });

  it('rejects unsupported options instead of silently dropping them', () => {
    expect(() => parseFfprobeArgs(['-count_frames', 'clip.mp4'])).toThrow(
      /unsupported option '-count_frames'/
    );
    expect(() => parseFfprobeArgs(['-of', 'xml', 'clip.mp4'])).toThrow(/unsupported -of/);
    expect(() => parseFfprobeArgs(['-show_entries', 'packet=pts', 'clip.mp4'])).toThrow(
      /unsupported -show_entries section/
    );
  });
});

describe('selectProbeStreams', () => {
  const streams = parseFfmpegProbeLog(SAMPLE_LOG)!.streams;

  it('selects audio stream 0', () => {
    expect(selectProbeStreams(streams, 'a:0')).toHaveLength(1);
    expect(selectProbeStreams(streams, 'a:0')[0].codec_type).toBe('audio');
  });

  it('rejects unsupported select specs', () => {
    expect(() => selectProbeStreams(streams, 's:0')).toThrow(/unsupported -select_streams/);
  });
});

describe('createFfprobeCommand', () => {
  it('prints help that discloses the emulation', async () => {
    const cmd = createFfprobeCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/emulated/i);
    expect(result.stdout).toMatch(/not ship a real ffprobe/i);
  });

  it('gates -version on an installed core', async () => {
    const { tryLoadFfmpegCoreFromNodeModules } = await import(
      '../../../src/shell/supplemental-commands/ffmpeg-wasm.js'
    );
    vi.mocked(tryLoadFfmpegCoreFromNodeModules).mockResolvedValue(null);
    const cmd = createFfprobeCommand();
    const missing = await cmd.execute(['-version'], createMockCtx());
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain(FFMPEG_CORE_NOT_INSTALLED);

    vi.mocked(tryLoadFfmpegCoreFromNodeModules).mockResolvedValue({
      pkg: '@ffmpeg/core',
      coreSource: 'x',
      wasmBytes: new Uint8Array([1]),
    });
    const ok = await cmd.execute(['-version'], createMockCtx());
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toMatch(/emulated/);
  });

  it('returns channel count for Remotion-style argv', async () => {
    useFakeFfmpeg(makeFakeFfmpeg({}));
    const cmd = createFfprobeCommand();
    const result = await cmd.execute(
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=channels',
        '-of',
        'default=nw=1:nk=1',
        'clip.mp4',
      ],
      createMockCtx()
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1');
    expect(result.stderr).toBe('');
  });

  it('emits JSON with format duration and stream codecs', async () => {
    useFakeFfmpeg(makeFakeFfmpeg({}));
    const cmd = createFfprobeCommand();
    const result = await cmd.execute(
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', 'clip.mp4'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.format.duration).toBe('1.000000');
    expect(json.format.format_name).toContain('mp4');
    expect(json.streams[0].codec_name).toBe('h264');
    expect(json.streams[1].channels).toBe(1);
  });

  it('prefixes CSV rows with the section name and quotes comma fields', async () => {
    useFakeFfmpeg(makeFakeFfmpeg({}));
    const cmd = createFfprobeCommand();
    const withSection = await cmd.execute(
      ['-v', 'error', '-show_entries', 'stream=channels', '-of', 'csv', 'clip.mp4'],
      createMockCtx()
    );
    expect(withSection.exitCode).toBe(0);
    expect(withSection.stdout.trim()).toBe('stream,1');

    const valuesOnly = await cmd.execute(
      ['-v', 'error', '-show_entries', 'stream=channels', '-of', 'csv=p=0', 'clip.mp4'],
      createMockCtx()
    );
    expect(valuesOnly.stdout.trim()).toBe('1');

    const formatCsv = await cmd.execute(
      ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv', 'clip.mp4'],
      createMockCtx()
    );
    expect(formatCsv.stdout.trim()).toBe('format,"mov,mp4,m4a,3gp,3g2,mj2"');
  });

  it('serializes concurrent probes so log listeners never overlap', async () => {
    let active = 0;
    let maxActive = 0;
    const listeners = new Set<(e: { type: string; message: string }) => void>();
    const fake: FakeFfmpeg = {
      on: vi.fn((event: string, handler: (e: { type: string; message: string }) => void) => {
        if (event === 'log') listeners.add(handler);
      }),
      off: vi.fn((_event: string, handler: (e: { type: string; message: string }) => void) => {
        listeners.delete(handler);
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn(async (args: string[]) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const input = args[args.indexOf('-i') + 1] ?? 'unknown';
        for (const handler of listeners) {
          handler({ type: 'stderr', message: `Input #0, mov,mp4, from '${input}':` });
          handler({
            type: 'stderr',
            message: '  Duration: 00:00:01.00, start: 0.000000, bitrate: 100 kb/s',
          });
          handler({
            type: 'stderr',
            message: '  Stream #0:0: Audio: aac, 44100 Hz, mono, fltp, 70 kb/s',
          });
        }
        await new Promise((r) => setTimeout(r, 25));
        active -= 1;
        throw new Error('At least one output file must be specified');
      }),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      createDir: vi.fn().mockResolvedValue(true),
      mount: vi.fn().mockResolvedValue(true),
      unmount: vi.fn().mockResolvedValue(true),
      deleteDir: vi.fn().mockResolvedValue(true),
    };
    useFakeFfmpeg(fake);
    const cmd = createFfprobeCommand();
    const argv = [
      '-v',
      'error',
      '-show_entries',
      'stream=channels',
      '-of',
      'default=nw=1:nk=1',
    ] as const;
    const [a, b] = await Promise.all([
      cmd.execute([...argv, 'a.mp4'], createMockCtx()),
      cmd.execute([...argv, 'b.mp4'], createMockCtx()),
    ]);
    expect(maxActive).toBe(1);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout.trim()).toBe('1');
    expect(b.stdout.trim()).toBe('1');
    const staged = mountedNames(fake);
    expect(staged).toHaveLength(2);
    expect(staged[0]).not.toBe(staged[1]);
    expect(staged.every((n) => !n.includes("'"))).toBe(true);
  });

  it('probes a VFS path whose basename contains an apostrophe', async () => {
    const fake = makeFakeFfmpeg({});
    useFakeFfmpeg(fake);
    const cmd = createFfprobeCommand();
    const result = await cmd.execute(
      [
        '-v',
        'error',
        '-show_entries',
        'stream=channels',
        '-of',
        'default=nw=1:nk=1',
        "/tmp/O'Brien.mp4",
      ],
      createMockCtx()
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1');
    const [name] = mountedNames(fake);
    expect(name).not.toContain("'");
    expect(name).toMatch(/\.mp4$/);
    // The mount point is where the core is told to read from.
    const execArgs = fake.exec.mock.calls[0][0] as string[];
    expect(execArgs[execArgs.indexOf('-i') + 1]).toBe(
      `${(fake.mount.mock.calls[0][2] as string).replace(/^\//, '')}/${name}`
    );
  });

  it('rejects unsupported options with a clear error', async () => {
    const cmd = createFfprobeCommand();
    const result = await cmd.execute(['-show_frames', 'clip.mp4'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/unsupported option '-show_frames'/);
    expect(getFfmpeg).not.toHaveBeenCalled();
  });

  it('recycles the shared core on a wasm trap and skips MEMFS cleanup', async () => {
    // Don't emit logs before the trap so we take the fault path that recycles.
    const fake = makeFakeFfmpeg({
      execError: new Error('RuntimeError: memory access out of bounds'),
    });
    fake.on = vi.fn();
    useFakeFfmpeg(fake);

    const cmd = createFfprobeCommand();
    const result = await cmd.execute(['-of', 'json', 'clip.mp4'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/wasm core faulted/);
    expect(recycleFfmpeg).toHaveBeenCalledWith(fake);
    // #2766 invariant: after recycle the worker is gone — do not
    // re-enter it via unmount (wrapper ERROR_NOT_LOADED is not our
    // guarantee).
    expect(fake.unmount).not.toHaveBeenCalled();
    expect(fake.deleteFile).not.toHaveBeenCalled();
  });

  it('reports missing input without booting the core', async () => {
    const cmd = createFfprobeCommand();
    const result = await cmd.execute(
      ['clip.mp4'],
      createMockCtx({ fs: { exists: vi.fn().mockResolvedValue(false) } })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/input file not found/);
    expect(getFfmpeg).not.toHaveBeenCalled();
  });
});

describe('ffprobe via mediabunny', () => {
  async function wavCtx() {
    const { makeWav } = await import('./ffmpeg/wav-fixture.js');
    const wav = makeWav({ channels: 2, sampleRate: 44100, seconds: 0.5 });
    return createMockCtx({
      fs: {
        exists: vi.fn(async (p: string) => p === '/home/tone.wav'),
        readFileBuffer: vi.fn(async () => wav),
      },
    });
  }

  it('answers a Remotion-style channel query from mediabunny, no wasm boot', async () => {
    const result = await createFfprobeCommand().execute(
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=channels',
        '-of',
        'default=nw=1:nk=1',
        'tone.wav',
      ],
      await wavCtx()
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('2');
    expect(getFfmpeg).not.toHaveBeenCalled();
  }, 20_000);

  it('emits typed JSON with the wav format and pcm stream', async () => {
    const result = await createFfprobeCommand().execute(
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', 'tone.wav'],
      await wavCtx()
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      format: { format_name: string; duration: string; filename: string };
      streams: Array<{ codec_name: string; sample_rate: string; channels: number }>;
    };
    expect(parsed.format.format_name).toBe('wav');
    expect(parsed.format.filename).toBe('tone.wav');
    expect(Number(parsed.format.duration)).toBeCloseTo(0.5, 2);
    expect(parsed.streams[0]).toMatchObject({
      codec_name: 'pcm_s16le',
      sample_rate: '44100',
      channels: 2,
    });
    expect(getFfmpeg).not.toHaveBeenCalled();
  }, 20_000);

  it('FFMPEG_ENGINE=wasm takes the emulated path even for a readable container', async () => {
    const fake = makeFakeFfmpeg({});
    useFakeFfmpeg(fake);
    const ctx = await wavCtx();
    (ctx as unknown as { env: Map<string, string> }).env.set('FFMPEG_ENGINE', 'wasm');
    const result = await createFfprobeCommand().execute(['-of', 'json', 'tone.wav'], ctx);
    expect(result.exitCode).toBe(0);
    expect(getFfmpeg).toHaveBeenCalledTimes(1);
  });

  it('FFMPEG_ENGINE=mediabunny refuses an unreadable container instead of emulating', async () => {
    const ctx = createMockCtx();
    (ctx as unknown as { env: Map<string, string> }).env.set('FFMPEG_ENGINE', 'mediabunny');
    const result = await createFfprobeCommand().execute(['-of', 'json', 'clip.mp4'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not a container mediabunny reads/);
    expect(getFfmpeg).not.toHaveBeenCalled();
  });
});
