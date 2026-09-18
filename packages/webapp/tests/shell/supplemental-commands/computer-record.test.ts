import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MINIMAL_JPEG } from '../../../src/computers/encode-frame.js';
import {
  collectPolledFrames,
  concatFrameBytes,
  encodeFramesWithFfmpeg,
} from '../../../src/shell/supplemental-commands/computer/record.js';

const { mockRunFfmpeg } = vi.hoisted(() => ({
  mockRunFfmpeg: vi.fn(),
}));

vi.mock('../../../src/shell/supplemental-commands/ffmpeg/run.js', () => ({
  runFfmpeg: (...args: unknown[]) => mockRunFfmpeg(...args),
}));

interface EncodeCtx {
  env: Map<string, string>;
  fs: { writeFile: (path: string, data: Uint8Array) => Promise<void> };
}

describe('collectPolledFrames', () => {
  it('grabs one still when the duration is shorter than the interval', async () => {
    let shots = 0;
    const collected = await collectPolledFrames({
      durationMs: 100,
      fps: 2,
      now: () => 0,
      sleep: async () => {
        throw new Error('should not sleep');
      },
      screenshot: async () => {
        shots += 1;
        return {
          seq: shots,
          mime: 'image/jpeg',
          width: 8,
          height: 4,
          bytes: MINIMAL_JPEG,
        };
      },
    });
    expect(shots).toBe(1);
    expect(collected.frames).toHaveLength(1);
    expect(collected.width).toBe(8);
    expect(collected.height).toBe(4);
  });

  it('polls at fps until duration elapses', async () => {
    let t = 0;
    let shots = 0;
    const collected = await collectPolledFrames({
      durationMs: 1000,
      fps: 4,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      screenshot: async () => {
        shots += 1;
        return {
          seq: shots,
          mime: 'image/jpeg',
          width: 16,
          height: 8,
          bytes: MINIMAL_JPEG,
        };
      },
    });
    expect(collected.frames).toHaveLength(4);
    expect(concatFrameBytes(collected.frames).byteLength).toBe(MINIMAL_JPEG.byteLength * 4);
  });
});

describe('encodeFramesWithFfmpeg', () => {
  beforeEach(() => {
    mockRunFfmpeg.mockReset();
  });
  it('pipes concatenated JPEGs through ffmpeg image2pipe', async () => {
    mockRunFfmpeg.mockImplementation(async (args: string[], ctx: EncodeCtx) => {
      expect(args).toEqual(expect.arrayContaining(['-f', 'image2pipe', '-c:v', 'mjpeg']));
      expect(args).toContain('libvpx');
      expect(ctx.env.get('FFMPEG_ENGINE')).toBe('wasm');
      await ctx.fs.writeFile(args.at(-1) as string, Uint8Array.of(7, 7));
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const written = new Map<string, Uint8Array>();
    const write = async (path: string, data: Uint8Array) => {
      written.set(path, data);
    };
    const ctx = {
      cwd: '/',
      env: new Map<string, string>(),
      fs: {
        resolvePath: (_base: string, path: string) => path,
        mkdir: async () => undefined,
        writeFile: write,
        readFile: async (path: string) => written.get(path) ?? new Uint8Array(0),
      },
    };
    const result = await encodeFramesWithFfmpeg({
      frames: [MINIMAL_JPEG, MINIMAL_JPEG],
      fps: 2,
      dest: '/clip.webm',
      width: 2,
      height: 2,
      durationMs: 1000,
      ctx: ctx as never,
    });
    expect(result.mime).toBe('video/webm');
    expect(written.get('/tmp/computer-record-frames.mjpeg')?.byteLength).toBe(
      MINIMAL_JPEG.byteLength * 2
    );
    expect(mockRunFfmpeg).toHaveBeenCalledOnce();
  });

  it('surfaces a failed ffmpeg encode', async () => {
    mockRunFfmpeg.mockResolvedValue({
      stdout: '',
      stderr: 'ffmpeg: encoder not found\n',
      exitCode: 1,
    });
    const ctx = {
      cwd: '/',
      env: new Map<string, string>(),
      fs: {
        resolvePath: (_base: string, path: string) => path,
        mkdir: async () => undefined,
        writeFile: async () => undefined,
      },
    };
    await expect(
      encodeFramesWithFfmpeg({
        frames: [MINIMAL_JPEG],
        fps: 2,
        dest: '/clip.webm',
        width: 2,
        height: 2,
        durationMs: 100,
        ctx: ctx as never,
      })
    ).rejects.toThrow('ffmpeg: encoder not found');
  });
});
