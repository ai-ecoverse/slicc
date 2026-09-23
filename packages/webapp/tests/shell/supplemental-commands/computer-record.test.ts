import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MINIMAL_JPEG } from '../../../src/computers/encode-frame.js';
import {
  COMPUTER_RECORD_MAX_BYTES,
  COMPUTER_RECORD_MAX_FPS,
  COMPUTER_RECORD_MAX_FRAMES,
  collectPolledFrames,
  concatFrameBytes,
  encodeFramesWithFfmpeg,
  recordPolledClip,
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

function jpegFrame(seq: number, bytes: Uint8Array = MINIMAL_JPEG) {
  return {
    seq,
    mime: 'image/jpeg' as const,
    width: 8,
    height: 4,
    bytes,
  };
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
        return jpegFrame(shots);
      },
    });
    expect(shots).toBe(1);
    expect(collected.frameCount).toBe(1);
    expect(collected.width).toBe(8);
    expect(collected.height).toBe(4);
  });

  it('polls at fps until duration elapses', async () => {
    let t = 0;
    let shots = 0;
    const streamed: Uint8Array[] = [];
    const collected = await collectPolledFrames({
      durationMs: 1000,
      fps: 4,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      screenshot: async () => {
        shots += 1;
        return jpegFrame(shots);
      },
      onFrame: (bytes) => {
        streamed.push(bytes);
      },
    });
    expect(collected.frameCount).toBe(4);
    expect(concatFrameBytes(streamed).byteLength).toBe(MINIMAL_JPEG.byteLength * 4);
  });

  it('clamps fps above 10', async () => {
    let t = 0;
    const sleeps: number[] = [];
    await collectPolledFrames({
      durationMs: 300,
      fps: 60,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      screenshot: async () => jpegFrame(1),
    });
    expect(sleeps[0]).toBe(Math.round(1000 / COMPUTER_RECORD_MAX_FPS));
  });

  it('stops at the frame cap', async () => {
    let t = 0;
    const collected = await collectPolledFrames({
      durationMs: 60_000,
      fps: 10,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      screenshot: async () => jpegFrame(1),
    });
    expect(collected.frameCount).toBe(COMPUTER_RECORD_MAX_FRAMES);
    expect(collected.truncated).toBe(false);
    expect(collected.durationMs).toBe(60_000);
  });

  it('stops at the aggregate JPEG byte cap', async () => {
    const chunk = new Uint8Array(COMPUTER_RECORD_MAX_BYTES / 2);
    const collected = await collectPolledFrames({
      durationMs: 60_000,
      fps: 10,
      now: () => 0,
      sleep: async () => undefined,
      screenshot: async () => jpegFrame(1, chunk),
    });
    expect(collected.frameCount).toBe(2);
    expect(collected.byteLength).toBe(chunk.byteLength * 2);
    expect(collected.truncated).toBe(true);
    expect(collected.durationMs).toBe(Math.round((2 / COMPUTER_RECORD_MAX_FPS) * 1000));
  });

  it('does not append a still that would exceed the byte cap', async () => {
    const small = new Uint8Array(8);
    const huge = new Uint8Array(COMPUTER_RECORD_MAX_BYTES);
    let shots = 0;
    const streamed: number[] = [];
    const collected = await collectPolledFrames({
      durationMs: 60_000,
      fps: 10,
      now: () => 0,
      sleep: async () => undefined,
      screenshot: async () => {
        shots += 1;
        return jpegFrame(shots, shots === 1 ? small : huge);
      },
      onFrame: (bytes) => {
        streamed.push(bytes.byteLength);
      },
    });
    expect(shots).toBe(2);
    expect(streamed).toEqual([small.byteLength]);
    expect(collected.frameCount).toBe(1);
    expect(collected.truncated).toBe(true);
  });

  it('measures a slow capture instead of synthesising the timeline from fps (#3382)', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const collected = await collectPolledFrames({
      durationMs: 3000,
      fps: 2,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      screenshot: async () => {
        t += 1000;
        return jpegFrame(1);
      },
    });
    expect(collected.frameCount).toBe(3);
    expect(collected.durationMs).toBe(3000);
    expect(collected.frameRate).toBe('1/1');
    expect(collected.achievedFps).toBe(1);
    expect(collected.slow).toBe(true);
    expect(sleeps.every((ms) => ms === 0)).toBe(true);
  });

  it('reports wall time past the window when one capture overruns it (#3382)', async () => {
    let t = 0;
    const collected = await collectPolledFrames({
      durationMs: 3000,
      fps: 2,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      screenshot: async () => {
        t += 2500;
        return jpegFrame(1);
      },
    });
    expect(collected.frameCount).toBe(2);
    expect(collected.durationMs).toBe(5000);
    expect(collected.frameRate).toBe('2/5');
    expect(collected.slow).toBe(true);
  });

  it('counts capture latency against the interval', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const collected = await collectPolledFrames({
      durationMs: 1000,
      fps: 4,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      screenshot: async () => {
        t += 100;
        return jpegFrame(1);
      },
    });
    expect(sleeps).toEqual([150, 150, 150]);
    expect(collected.frameCount).toBe(4);
    expect(collected.durationMs).toBe(1000);
    expect(collected.frameRate).toBe('4/1');
    expect(collected.slow).toBe(false);
  });

  it('yields between polls so the event loop can run', async () => {
    let ticks = 0;
    const id = setInterval(() => {
      ticks += 1;
    }, 5);
    try {
      await collectPolledFrames({
        durationMs: 250,
        fps: 10,
        screenshot: async () => jpegFrame(1),
      });
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(id);
    }
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
    const mjpeg = [...written.entries()].find(([path]) => path.endsWith('.mjpeg'));
    expect(mjpeg?.[1]?.byteLength).toBe(MINIMAL_JPEG.byteLength * 2);
    expect(mockRunFfmpeg).toHaveBeenCalledOnce();
  });

  it('muxes at the measured frame rate when one is given', async () => {
    let seen: string[] = [];
    mockRunFfmpeg.mockImplementation(async (args: string[]) => {
      seen = args;
      return { stdout: '', stderr: '', exitCode: 0 };
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
    await encodeFramesWithFfmpeg({
      frames: [MINIMAL_JPEG],
      fps: 4,
      frameRate: '2/3',
      dest: '/clip.webm',
      width: 2,
      height: 2,
      durationMs: 4500,
      ctx: ctx as never,
    });
    expect(seen[seen.indexOf('-framerate') + 1]).toBe('2/3');
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

describe('recordPolledClip', () => {
  it('streams JPEGs into the encoder instead of retaining the array', async () => {
    const written = new Map<string, Uint8Array>();
    const ctx = {
      cwd: '/',
      env: new Map<string, string>(),
      fs: {
        resolvePath: (_base: string, path: string) => path,
        mkdir: async () => undefined,
        writeFile: async (path: string, data: Uint8Array) => {
          written.set(path, data);
        },
        readFile: async (path: string) => written.get(path) ?? new Uint8Array(0),
        appendFile: async (path: string, data: Uint8Array) => {
          const prev = written.get(path) ?? new Uint8Array(0);
          const next = new Uint8Array(prev.byteLength + data.byteLength);
          next.set(prev, 0);
          next.set(data, prev.byteLength);
          written.set(path, next);
        },
        rm: async (path: string) => {
          written.delete(path);
        },
      },
    };
    let encodeFrames: Uint8Array[] | undefined;
    let t = 0;
    const clip = await recordPolledClip({
      durationMs: 1000,
      fps: 4,
      dest: '/clip.webm',
      ctx: ctx as never,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      screenshot: async () => jpegFrame(1),
      encode: async (args) => {
        encodeFrames = args.frames;
        expect(args.sourcePath).toBeTruthy();
        await args.ctx.fs.writeFile(args.dest, Uint8Array.of(1, 2));
        return { mime: 'video/webm' };
      },
    });
    expect(encodeFrames).toEqual([]);
    expect(clip.mime).toBe('video/webm');
    expect(clip.durationMs).toBe(1000);
    expect(clip.truncated).toBeUndefined();
    expect(clip.frames).toBe(4);
    expect(clip.fps).toBe(4);
    expect(clip.requestedFps).toBe(4);
  });

  it('muxes a slow capture at the measured rate, not the requested fps (#3382)', async () => {
    const ctx = {
      cwd: '/',
      env: new Map<string, string>(),
      fs: {
        resolvePath: (_base: string, path: string) => path,
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        appendFile: async () => undefined,
        rm: async () => undefined,
      },
    };
    let t = 0;
    let frameRate: string | undefined;
    const clip = await recordPolledClip({
      durationMs: 4000,
      fps: 4,
      dest: '/clip.webm',
      ctx: ctx as never,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      screenshot: async () => {
        t += 1500;
        return jpegFrame(1);
      },
      encode: async (args) => {
        frameRate = args.frameRate;
        return { mime: 'video/webm' };
      },
    });
    expect(frameRate).toBe('2/3');
    expect(clip.durationMs).toBe(4500);
    expect(clip.frames).toBe(3);
    expect(clip.fps).toBeCloseTo(0.67, 2);
    expect(clip.slow).toBe(true);
  });

  it('starts each recording from a fresh MJPEG scratch file', async () => {
    const written = new Map<string, Uint8Array>();
    const ctx = {
      cwd: '/',
      env: new Map<string, string>(),
      fs: {
        resolvePath: (_base: string, path: string) => path,
        mkdir: async () => undefined,
        writeFile: async (path: string, data: Uint8Array) => {
          written.set(path, Uint8Array.from(data));
        },
        readFile: async (path: string) => written.get(path) ?? new Uint8Array(0),
        appendFile: async (path: string, data: Uint8Array) => {
          const prev = written.get(path) ?? new Uint8Array(0);
          const next = new Uint8Array(prev.byteLength + data.byteLength);
          next.set(prev, 0);
          next.set(data, prev.byteLength);
          written.set(path, next);
        },
        rm: async (path: string) => {
          written.delete(path);
        },
      },
    };
    const seen: Array<{ path: string; bytes: number }> = [];
    const run = async (shots: number) => {
      let n = 0;
      let t = 0;
      await recordPolledClip({
        durationMs: shots * 250,
        fps: 4,
        dest: `/clip-${shots}.webm`,
        ctx: ctx as never,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
        screenshot: async () => jpegFrame(++n),
        encode: async (args) => {
          const raw: unknown = await args.ctx.fs.readFile(args.sourcePath as string, {
            encoding: 'binary',
          });
          seen.push({
            path: args.sourcePath as string,
            bytes: raw instanceof Uint8Array ? raw.byteLength : 0,
          });
          return { mime: 'video/webm' };
        },
      });
    };
    await run(4);
    await run(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.path).not.toBe(seen[1]?.path);
    expect(seen[0]?.bytes).toBe(MINIMAL_JPEG.byteLength * 4);
    expect(seen[1]?.bytes).toBe(MINIMAL_JPEG.byteLength);
  });
});
