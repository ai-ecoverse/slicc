import type { ComputerDescriptor, ComputerFrame, ComputerInputEvent } from '@slicc/shared-ts';
import { uint8ToBase64 } from '@slicc/shared-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputerBackend, ComputerScreenshotOpts } from '../../../src/computers/backend.js';
import { MINIMAL_JPEG } from '../../../src/computers/encode-frame.js';
import {
  ComputerRegistry,
  resetComputerRegistryForTests,
} from '../../../src/computers/registry.js';
import {
  chainVerbs,
  parseGlobals,
} from '../../../src/shell/supplemental-commands/computer/parse.js';
import { createComputerCommand } from '../../../src/shell/supplemental-commands/computer-command.js';

class FakeBackend implements ComputerBackend {
  events: ComputerInputEvent[] = [];
  shots = 0;

  constructor(readonly id = 'fake') {}

  describe(): ComputerDescriptor {
    return {
      id: this.id,
      kind: 'jsh',
      title: this.id,
      size: { width: 1000, height: 500 },
      state: 'live',
      capabilities: {
        screenshot: true,
        text: true,
        frames: 'poll',
        keyboard: true,
        mouse: 'absolute',
        scroll: true,
        exec: false,
        inputAllowed: true,
      },
      pid: null,
    };
  }

  async screenshot(opts: ComputerScreenshotOpts = { format: 'jpeg' }): Promise<ComputerFrame> {
    this.shots += 1;
    const max = opts.maxWidth ?? 768;
    const scale = 1000 > max ? max / 1000 : 1;
    return {
      seq: this.shots,
      mime: 'image/jpeg',
      width: Math.round(1000 * scale),
      height: Math.round(500 * scale),
      bytes: MINIMAL_JPEG,
    };
  }

  async text(): Promise<string | null> {
    return 'login:';
  }

  async input(events: ComputerInputEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async close(): Promise<void> {}
}

const PULL_JPEG = Uint8Array.of(0xff, 0xd8, 0x01, 0xd9);
const PUSH_JPEG = Uint8Array.of(0xff, 0xd8, 0x02, 0xd9);

class FakePushBackend implements ComputerBackend {
  events: ComputerInputEvent[] = [];
  pullShots = 0;
  cachedShots = 0;
  private sink: ((frame: ComputerFrame) => void) | null = null;
  private lastPushed: ComputerFrame | null = null;
  watching = false;

  constructor(readonly id = 'push') {}

  describe(): ComputerDescriptor {
    return {
      id: this.id,
      kind: 'jsh',
      title: this.id,
      size: { width: 640, height: 400 },
      state: 'live',
      capabilities: {
        screenshot: true,
        text: true,
        frames: 'push',
        keyboard: true,
        mouse: 'absolute',
        scroll: false,
        exec: false,
        inputAllowed: true,
      },
      pid: null,
    };
  }

  subscribe(_fps: number, onFrame: (frame: ComputerFrame) => void, _maxWidth?: number): () => void {
    this.watching = true;
    this.sink = onFrame;
    if (this.lastPushed) onFrame(this.lastPushed);
    return () => {
      this.watching = false;
      this.sink = null;
    };
  }

  emit(seq: number): ComputerFrame {
    const frame: ComputerFrame = {
      seq,
      mime: 'image/jpeg',
      width: 640,
      height: 400,
      bytes: PUSH_JPEG,
    };
    this.lastPushed = frame;
    this.sink?.(frame);
    return frame;
  }

  async screenshot(opts: ComputerScreenshotOpts = { format: 'jpeg' }): Promise<ComputerFrame> {
    if (!opts.pull && this.watching) {
      this.cachedShots += 1;
      if (this.lastPushed) return this.lastPushed;
      return new Promise(() => {
        /* wait for a pushed frame — tests time this out */
      });
    }
    this.pullShots += 1;
    return {
      seq: 99,
      mime: 'image/jpeg',
      width: 640,
      height: 400,
      bytes: PULL_JPEG,
    };
  }

  async input(events: ComputerInputEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async close(): Promise<void> {}
}

function makeCtx(env = new Map<string, string>()) {
  const written = new Map<string, Uint8Array | string>();
  return {
    written,
    ctx: {
      fs: {
        resolvePath: (_base: string, path: string) => (path.startsWith('/') ? path : `/${path}`),
        writeFile: async (path: string, data: Uint8Array | string) => {
          written.set(path, data);
        },
        mkdir: async () => {},
      },
      cwd: '/',
      env,
    } as never,
  };
}

afterEach(() => {
  resetComputerRegistryForTests();
});

describe('computer command', () => {
  it('prints help', async () => {
    const cmd = createComputerCommand({ registry: new ComputerRegistry(null) });
    const { ctx } = makeCtx();
    const help = await cmd.execute(['--help'], ctx);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('xdotool');
    expect(help.stdout).toContain('left_click');
    expect(help.stdout).toContain('add ssh');
    expect(help.stdout).toContain('add url');
    expect(help.stdout).toContain('image2pipe');
  });

  it('answers click --help without dispatching input', async () => {
    const backend = new FakeBackend();
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    const cmd = createComputerCommand({ registry });
    const { ctx } = makeCtx();
    const help = await cmd.execute(['click', '--help'], ctx);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('computer click');
    expect(backend.events).toEqual([]);
  });

  it('lists registered computers and screenshots with a scale line', async () => {
    const backend = new FakeBackend('box');
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    const cmd = createComputerCommand({ registry });
    const { ctx, written } = makeCtx();
    const ls = await cmd.execute(['ls'], ctx);
    expect(ls.stdout).toContain('box');
    expect(ls.stdout).not.toContain('target:');
    const shot = await cmd.execute(['screenshot', '--size', 'medium'], ctx);
    expect(shot.exitCode).toBe(0);
    expect(shot.stdout).toMatch(/^target: box\n/);
    expect(shot.stdout).toContain('1000x500 → 768x384');
    expect(shot.stdout).toContain('screen: ');
    expect([...written.keys()].some((p) => p.endsWith('.jpg'))).toBe(true);
  });

  it('stamps target: after resolving, but not on ls/use or --json', async () => {
    const backend = new FakeBackend('box');
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    const cmd = createComputerCommand({ registry });
    const { ctx } = makeCtx();
    const used = await cmd.execute(['use', 'box'], ctx);
    expect(used.stdout).toBe('using box\n');
    expect(used.stdout).not.toContain('target:');
    const json = await cmd.execute(['screenshot', '--json'], ctx);
    expect(json.exitCode).toBe(0);
    expect(json.stdout).not.toContain('target:');
    expect(JSON.parse(json.stdout)).toMatchObject({ id: 'box' });
  });

  it('chains click + type and writes a frozen frame after input', async () => {
    const backend = new FakeBackend();
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    registry.rememberShot('fake', { width: 500, height: 250, scale: 0.5, at: 1 });
    const cmd = createComputerCommand({ registry });
    const { ctx } = makeCtx();
    const result = await cmd.execute(['click', '1', '--at', '10,20', 'type', 'hi'], ctx);
    expect(result.exitCode).toBe(0);
    expect(backend.events).toEqual([
      { type: 'click', button: 1, count: 1, x: 20, y: 40 },
      { type: 'text', text: 'hi' },
    ]);
    expect(result.stdout).toContain('screen: ');
  });

  it('look-click-look writes a fresh frozen frame after each poke', async () => {
    const backend = new FakeBackend();
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    const cmd = createComputerCommand({ registry });
    const { ctx, written } = makeCtx();
    const look = await cmd.execute(['screenshot'], ctx);
    expect(look.exitCode).toBe(0);
    expect(look.stdout).toMatch(/screen: .*\/1\.jpg/);
    const click = await cmd.execute(['--native', 'click', '1', '--at', '10,20'], ctx);
    expect(click.exitCode).toBe(0);
    expect(backend.events).toEqual([{ type: 'click', button: 1, count: 1, x: 10, y: 20 }]);
    expect(click.stdout).toMatch(/screen: .*\/2\.jpg/);
    const look2 = await cmd.execute(['screenshot'], ctx);
    expect(look2.exitCode).toBe(0);
    expect(look2.stdout).toMatch(/screen: .*\/3\.jpg/);
    expect(backend.shots).toBe(3);
    const jpgs = [...written.keys()].filter((p) => p.endsWith('.jpg'));
    expect(jpgs).toHaveLength(3);
  });

  it('keeps the coordinate space fixed across repeated pokes (issue #3297)', async () => {
    // A backend whose encoded frame comes back narrower than the requested
    // maxWidth (the DPR shrink of #3296). The frozen frame must not feed that
    // shrink back into lastShot, or the scale decays 1.25x per poke.
    class DecayBackend extends FakeBackend {
      async screenshot(opts: ComputerScreenshotOpts = { format: 'jpeg' }): Promise<ComputerFrame> {
        this.shots += 1;
        const max = opts.maxWidth ?? 768;
        const shot = Math.round(max * 0.8);
        return {
          seq: this.shots,
          mime: 'image/jpeg',
          width: shot,
          height: Math.round(shot / 2),
          bytes: MINIMAL_JPEG,
        };
      }
    }
    const backend = new DecayBackend();
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    const cmd = createComputerCommand({ registry });
    const { ctx } = makeCtx();
    await cmd.execute(['screenshot'], ctx);
    for (let i = 0; i < 4; i++) {
      await cmd.execute(['click', '1', '--at', '100,100'], ctx);
    }
    const clicks = backend.events.filter((e) => e.type === 'click');
    expect(clicks).toHaveLength(4);
    const first = clicks[0];
    for (const click of clicks) {
      expect(click).toEqual(first);
    }
  });

  it('maps Anthropic left_click coords and --native opt-out', async () => {
    const backend = new FakeBackend();
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    registry.rememberShot('fake', { width: 500, height: 250, scale: 0.5, at: 1 });
    const cmd = createComputerCommand({ registry });
    const { ctx } = makeCtx();
    await cmd.execute(['left_click', '10', '20'], ctx);
    expect(backend.events[0]).toMatchObject({ type: 'click', button: 1, x: 20, y: 40 });
    backend.events = [];
    await cmd.execute(['--native', 'left_click', '10', '20'], ctx);
    expect(backend.events[0]).toMatchObject({ type: 'click', button: 1, x: 10, y: 20 });
  });

  it('parses click <button> <x> <y> without leaking the last coord as a verb', async () => {
    const backend = new FakeBackend();
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    const cmd = createComputerCommand({ registry });
    const { ctx } = makeCtx();
    const result = await cmd.execute(['--native', 'click', '1', '100', '200', 'type', 'hi'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/unknown verb/);
    expect(backend.events).toEqual([
      { type: 'click', button: 1, count: 1, x: 100, y: 200 },
      { type: 'text', text: 'hi' },
    ]);
    backend.events = [];
    const down = await cmd.execute(['--native', 'mousedown', '100', '200'], ctx);
    expect(down.exitCode).toBe(0);
    expect(backend.events).toEqual([{ type: 'button', button: 1, down: true, x: 100, y: 200 }]);
  });

  it('honors -c after the verb so type does not eat the tokens', async () => {
    const a = new FakeBackend('a');
    const b = new FakeBackend('b');
    const registry = new ComputerRegistry(null);
    registry.register(a);
    registry.register(b);
    const cmd = createComputerCommand({ registry });
    const { ctx } = makeCtx();
    const shot = await cmd.execute(['screenshot', '-c', 'b'], ctx);
    expect(shot.exitCode).toBe(0);
    expect(shot.stdout).toMatch(/^target: b\n/);
    expect(b.shots).toBe(1);
    expect(a.shots).toBe(0);
    const typed = await cmd.execute(['type', '-c', 'a', 'hello'], ctx);
    expect(typed.exitCode).toBe(0);
    expect(a.events).toEqual([{ type: 'text', text: 'hello' }]);
    expect(b.events).toEqual([]);
  });

  it('resolves $COMPUTER and errors when none match', async () => {
    const registry = new ComputerRegistry(null);
    registry.register(new FakeBackend('a'));
    registry.register(new FakeBackend('b'));
    const cmd = createComputerCommand({ registry });
    const { ctx } = makeCtx(new Map([['COMPUTER', 'b']]));
    const info = await cmd.execute(['info'], ctx);
    expect(info.stdout).toMatch(/^target: b\n/);
    expect(info.stdout).toContain('id: b');
    const miss = await cmd.execute(['-c', 'nope', 'info'], ctx);
    expect(miss.exitCode).toBe(1);
    expect(miss.stderr).toContain('unknown computer');
  });

  it('dumps text when the backend supports it', async () => {
    const registry = new ComputerRegistry(null);
    registry.register(new FakeBackend());
    const cmd = createComputerCommand({ registry });
    const { ctx } = makeCtx();
    const text = await cmd.execute(['text'], ctx);
    expect(text.stdout).toContain('login:');
  });

  it('maps tab screenshot-space clicks through lastShot scale then DPR to CSS', async () => {
    function pngHeader(width: number, height: number): Uint8Array {
      const bytes = new Uint8Array(24);
      bytes[0] = 0x89;
      bytes[1] = 0x50;
      bytes[2] = 0x4e;
      bytes[3] = 0x47;
      bytes[16] = (width >>> 24) & 255;
      bytes[17] = (width >>> 16) & 255;
      bytes[18] = (width >>> 8) & 255;
      bytes[19] = width & 255;
      bytes[20] = (height >>> 24) & 255;
      bytes[21] = (height >>> 16) & 255;
      bytes[22] = (height >>> 8) & 255;
      bytes[23] = height & 255;
      return bytes;
    }
    const sent: Array<{ method: string; params: unknown }> = [];
    const tab = {
      send: vi.fn(async (method: string, params?: unknown) => {
        sent.push({ method, params });
        return {};
      }),
      screenshot: vi.fn(async (opts: { format?: string; maxWidth?: number } = {}) => {
        const size =
          opts.maxWidth && opts.maxWidth < 5120
            ? { width: 614, height: 324 }
            : { width: 5120, height: 2704 };
        return uint8ToBase64(pngHeader(size.width, size.height));
      }),
      evaluate: vi.fn(async () => 2.5),
    };
    const browser = {
      listAllTargets: vi.fn(async () => [
        { targetId: 'T1', title: 'Probe', url: 'https://example.test/' },
      ]),
      withTab: vi.fn(async (_id: string, fn: (t: typeof tab) => Promise<unknown>) => fn(tab)),
    };
    const registry = new ComputerRegistry(null);
    const cmd = createComputerCommand({ registry, browser: browser as never });
    const { ctx } = makeCtx();
    expect((await cmd.execute(['add', 'tab', 'T1'], ctx)).exitCode).toBe(0);
    const shot = await cmd.execute(['screenshot', '--size', '614'], ctx);
    expect(shot.exitCode).toBe(0);
    const info = await cmd.execute(['info', '--json'], ctx);
    const descriptor = JSON.parse(info.stdout) as {
      size: { width: number; height: number };
      lastShot: { width: number; height: number; scale: number };
    };
    expect(descriptor.size).toEqual({ width: 5120, height: 2704 });
    expect(descriptor.lastShot.width).toBe(614);
    expect(descriptor.lastShot.scale).toBeCloseTo(614 / 5120);
    const click = await cmd.execute(['click', '1', '--at', '132,96'], ctx);
    expect(click.exitCode).toBe(0);
    const pressed = sent.find(
      (s) =>
        s.method === 'Input.dispatchMouseEvent' &&
        (s.params as { type?: string }).type === 'mousePressed'
    );
    expect(pressed?.params).toMatchObject({ x: 440, y: 320 });
    sent.length = 0;
    const native = await cmd.execute(['--native', 'click', '1', '--at', '1100,800'], ctx);
    expect(native.exitCode).toBe(0);
    const nativePressed = sent.find(
      (s) =>
        s.method === 'Input.dispatchMouseEvent' &&
        (s.params as { type?: string }).type === 'mousePressed'
    );
    expect(nativePressed?.params).toMatchObject({ x: 440, y: 320 });
  });

  it('add tab uses a local backend when browser is injected without panelRpc', async () => {
    const jpeg = uint8ToBase64(MINIMAL_JPEG);
    const tab = {
      send: vi.fn(async () => ({})),
      screenshot: vi.fn(async () => jpeg),
    };
    const browser = {
      listAllTargets: vi.fn(async () => [
        { targetId: 'T1', title: 'Example', url: 'https://example.test/' },
      ]),
      withTab: vi.fn(async (_id: string, fn: (t: typeof tab) => Promise<unknown>) => fn(tab)),
    };
    const registry = new ComputerRegistry(null);
    const cmd = createComputerCommand({ registry, browser: browser as never });
    const { ctx } = makeCtx();
    const added = await cmd.execute(['add', 'tab', 'T1', '-n', 'ex'], ctx);
    expect(added.exitCode).toBe(0);
    expect(added.stdout).toContain('tab:T1');
    expect(registry.get('tab:T1')).toBeTruthy();
    const shot = await cmd.execute(['screenshot'], ctx);
    expect(shot.exitCode).toBe(0);
    expect(browser.withTab).toHaveBeenCalled();
    expect(tab.screenshot).toHaveBeenCalled();
  });

  it('add tab uses panel-RPC when a client is provided', async () => {
    const jpeg = uint8ToBase64(MINIMAL_JPEG);
    const call = vi.fn(async (op: string) => {
      if (op === 'computer-tab-screenshot') {
        return {
          mime: 'image/jpeg',
          base64: jpeg,
          width: 1,
          height: 1,
          title: 'Example',
          url: 'https://example.test/',
        };
      }
      return { ok: true };
    });
    const browser = {
      listAllTargets: vi.fn(async () => [
        { targetId: 'T1', title: 'Example', url: 'https://example.test/' },
      ]),
      withTab: vi.fn(),
    };
    const registry = new ComputerRegistry(null);
    const cmd = createComputerCommand({
      registry,
      browser: browser as never,
      panelRpc: { call } as never,
    });
    const { ctx } = makeCtx();
    const added = await cmd.execute(['add', 'tab', 'https://example.test/'], ctx);
    expect(added.exitCode).toBe(0);
    await cmd.execute(['screenshot'], ctx);
    expect(call).toHaveBeenCalledWith(
      'computer-tab-screenshot',
      expect.objectContaining({ targetId: 'T1' })
    );
    expect(browser.withTab).not.toHaveBeenCalled();
  });

  it('refuses to register a SLICC app tab', async () => {
    const browser = {
      listAllTargets: vi.fn(async () => [
        { targetId: 'APP', title: 'SLICC', url: 'https://www.sliccy.ai/' },
      ]),
      withTab: vi.fn(),
    };
    const cmd = createComputerCommand({
      registry: new ComputerRegistry(null),
      browser: browser as never,
    });
    const { ctx } = makeCtx();
    const added = await cmd.execute(['add', 'tab', 'APP'], ctx);
    expect(added.exitCode).toBe(1);
    expect(added.stderr).toContain('refusing SLICC app tab');
    expect(browser.withTab).not.toHaveBeenCalled();
  });

  it('add screen --__resolved registers a bridged backend', async () => {
    const jpeg = new ArrayBuffer(MINIMAL_JPEG.byteLength);
    new Uint8Array(jpeg).set(MINIMAL_JPEG);
    const call = vi.fn(async (_op: string, payload: { session?: string }) => {
      if (payload.session === 'frame') {
        return { bytes: jpeg, width: 640, height: 360, mimeType: 'image/jpeg' };
      }
      if (payload.session === 'stop') {
        return {
          bytes: new ArrayBuffer(0),
          width: 0,
          height: 0,
          mimeType: 'application/octet-stream',
        };
      }
      return {
        bytes: new ArrayBuffer(0),
        width: 0,
        height: 0,
        mimeType: 'application/octet-stream',
      };
    });
    const registry = new ComputerRegistry(null);
    const cmd = createComputerCommand({
      registry,
      panelRpc: { call } as never,
    });
    const { ctx } = makeCtx();
    const added = await cmd.execute(
      ['add', 'screen', '--__resolved', 'screen1', '-n', 'Desk'],
      ctx
    );
    expect(added.exitCode).toBe(0);
    expect(added.stdout).toContain('screen:screen1');
    expect(registry.get('screen:screen1')).toBeTruthy();
    const ls = await cmd.execute(['ls'], ctx);
    expect(ls.stdout).toContain('screen');
    expect(ls.stdout).toContain('[display slot]');
    const shot = await cmd.execute(['screenshot'], ctx);
    expect(shot.exitCode).toBe(0);
    expect(call).toHaveBeenCalledWith(
      'screencapture',
      expect.objectContaining({ session: 'frame', handle: 'screen1' })
    );
    const typed = await cmd.execute(['type', 'hi'], ctx);
    expect(typed.exitCode).toBe(1);
    expect(typed.stderr).toContain('input is not allowed');
  });

  it('add screen without a gesture or --__resolved fails', async () => {
    const cmd = createComputerCommand({
      registry: new ComputerRegistry(null),
      panelRpc: { call: vi.fn() } as never,
    });
    const { ctx } = makeCtx();
    const added = await cmd.execute(['add', 'screen'], ctx);
    expect(added.exitCode).toBe(1);
    expect(added.stderr).toContain('needs a user gesture');
  });

  it('record writes a clip for screen and encodes worker-hosted kinds via ffmpeg', async () => {
    const webm = Uint8Array.of(1, 2, 3);
    class ScreenBackend extends FakeBackend {
      constructor() {
        super('screen:screen1');
      }
      describe(): ComputerDescriptor {
        return {
          ...super.describe(),
          id: 'screen:screen1',
          kind: 'screen',
          title: 'Desk',
          capabilities: {
            screenshot: true,
            text: false,
            frames: 'poll',
            keyboard: false,
            mouse: 'none',
            scroll: false,
            exec: false,
            inputAllowed: false,
          },
        };
      }
      async recordClip(durationMs: number) {
        return {
          bytes: webm,
          mime: 'video/webm',
          width: 10,
          height: 10,
          durationMs,
        };
      }
    }
    const registry = new ComputerRegistry(null);
    registry.register(new ScreenBackend());
    const cmd = createComputerCommand({ registry });
    const { ctx, written } = makeCtx();
    const rec = await cmd.execute(['record', '-V', '2', 'out.webm'], ctx);
    expect(rec.exitCode).toBe(0);
    expect(rec.stdout).toContain('recorded 2000ms');
    expect(written.get('/out.webm')).toEqual(webm);

    const other = new ComputerRegistry(null);
    other.register(new FakeBackend());
    const encoded = Uint8Array.of(9, 9, 9);
    const otherCmd = createComputerCommand({
      registry: other,
      encodeRecordedFrames: async ({ frames, dest, ctx: encodeCtx, sourcePath }) => {
        expect(sourcePath || frames.length > 0).toBeTruthy();
        await encodeCtx.fs.writeFile(dest, encoded);
        return { mime: 'video/webm' };
      },
    });
    const polled = makeCtx();
    const worker = await otherCmd.execute(['record', '-V', '0.1', 'jsh.webm'], polled.ctx);
    expect(worker.exitCode).toBe(0);
    expect(worker.stdout).toContain('recorded 100ms');
    expect(polled.written.get('/jsh.webm')).toEqual(encoded);
  });

  it('record rejects --fps above 10', async () => {
    const registry = new ComputerRegistry(null);
    registry.register(new FakeBackend());
    const cmd = createComputerCommand({ registry });
    const { ctx } = makeCtx();
    const rec = await cmd.execute(['record', '--fps', '11', '-V', '1'], ctx);
    expect(rec.exitCode).toBe(1);
    expect(rec.stderr).toContain('--fps exceeds 10');
  });

  it('watch and --stop drive kernel start/stop control', async () => {
    const backend = new FakeBackend();
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    const watched: Array<{ id: string; fps: number }> = [];
    const unwatched: string[] = [];
    const cmd = createComputerCommand({
      registry,
      watch: (id, fps) => {
        watched.push({ id, fps });
      },
      unwatch: (id) => {
        unwatched.push(id);
      },
    });
    const { ctx } = makeCtx();
    const start = await cmd.execute(['watch', '--fps', '4'], ctx);
    expect(start.exitCode).toBe(0);
    expect(start.stdout).toContain('watching fake at 4 fps');
    expect(watched).toEqual([{ id: 'fake', fps: 4 }]);
    const stop = await cmd.execute(['watch', '--stop'], ctx);
    expect(stop.stdout).toContain('unwatched fake');
    expect(unwatched).toEqual(['fake']);
  });

  it('rejects input the descriptor forbids', async () => {
    const backend = new FakeBackend('locked');
    backend.describe = () => ({
      ...new FakeBackend('locked').describe(),
      capabilities: {
        screenshot: true,
        text: false,
        frames: 'none',
        keyboard: false,
        mouse: 'none',
        scroll: false,
        exec: false,
        inputAllowed: false,
      },
    });
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    const cmd = createComputerCommand({ registry });
    const { ctx } = makeCtx();
    const typed = await cmd.execute(['type', 'hi'], ctx);
    expect(typed.exitCode).toBe(1);
    expect(typed.stderr).toContain('input is not allowed');
    expect(backend.events).toEqual([]);
  });

  it('emits a wire drag for touch backends and takes a fresh post-action frame', async () => {
    const backend = new FakeBackend('phone');
    backend.describe = () => ({
      ...new FakeBackend('phone').describe(),
      capabilities: {
        screenshot: true,
        text: false,
        frames: 'push',
        keyboard: true,
        mouse: 'touch',
        scroll: true,
        exec: false,
        inputAllowed: true,
      },
    });
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    const cmd = createComputerCommand({ registry });
    const { ctx, written } = makeCtx();
    const shot = await cmd.execute(['screenshot'], ctx);
    expect(shot.stdout).toContain('1000x500 → 768x384');
    const before = [...written.keys()];
    const drag = await cmd.execute(['--native', 'drag', '10', '10', '40', '40'], ctx);
    expect(drag.exitCode).toBe(0);
    expect(backend.events).toEqual([{ type: 'drag', x1: 10, y1: 10, x2: 40, y2: 40 }]);
    expect(backend.shots).toBeGreaterThan(1);
    const after = [...written.keys()].filter((p) => !before.includes(p));
    expect(after.some((p) => p.endsWith('.jpg'))).toBe(true);
  });

  it('push backend without a watch still exits 0 after click', async () => {
    const backend = new FakePushBackend();
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    const cmd = createComputerCommand({ registry });
    const { ctx, written } = makeCtx();
    const result = await cmd.execute(['click', '1', '--at', '100,50'], ctx);
    expect(result.exitCode).toBe(0);
    expect(backend.events).toEqual([{ type: 'click', button: 1, count: 1, x: 100, y: 50 }]);
    expect(backend.pullShots).toBe(1);
    expect(backend.cachedShots).toBe(0);
    expect(result.stdout).toContain('screen: ');
    expect([...written.values()].some((data) => data === PULL_JPEG)).toBe(true);
  });

  it('watch path still uses a pushed frame after click', async () => {
    const backend = new FakePushBackend();
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    let stop: (() => void) | undefined;
    const cmd = createComputerCommand({
      registry,
      watch: () => {
        stop = backend.subscribe(4, () => {});
      },
      unwatch: () => {
        stop?.();
      },
      isWatching: () => backend.watching,
    });
    const { ctx, written } = makeCtx();
    const watch = await cmd.execute(['watch', '--fps', '4'], ctx);
    expect(watch.exitCode).toBe(0);
    backend.emit(7);
    const result = await cmd.execute(['click', '1', '--at', '111,122'], ctx);
    expect(result.exitCode).toBe(0);
    expect(backend.events).toEqual([{ type: 'click', button: 1, count: 1, x: 111, y: 122 }]);
    expect(backend.cachedShots).toBe(1);
    expect(backend.pullShots).toBe(0);
    expect(result.stdout).toContain('screen: ');
    expect([...written.values()].some((data) => data === PUSH_JPEG)).toBe(true);
  });

  it('falls back to on-demand screenshot when a live watch never pushes', async () => {
    const backend = new FakePushBackend();
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    let stop: (() => void) | undefined;
    const cmd = createComputerCommand({
      registry,
      watch: () => {
        stop = backend.subscribe(4, () => {});
      },
      unwatch: () => {
        stop?.();
      },
      isWatching: () => backend.watching,
      postActionTimeoutMs: 20,
    });
    const { ctx, written } = makeCtx();
    await cmd.execute(['watch', '--fps', '4'], ctx);
    const result = await cmd.execute(['click', '1', '--at', '10,20'], ctx);
    expect(result.exitCode).toBe(0);
    expect(backend.events).toHaveLength(1);
    expect(backend.cachedShots).toBe(1);
    expect(backend.pullShots).toBe(1);
    expect(result.stdout).toContain('screen: ');
    expect([...written.values()].some((data) => data === PULL_JPEG)).toBe(true);
  });

  it('on-demand screenshot still works on a push backend', async () => {
    const backend = new FakePushBackend();
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    const cmd = createComputerCommand({ registry });
    const { ctx, written } = makeCtx();
    const shot = await cmd.execute(['screenshot'], ctx);
    expect(shot.exitCode).toBe(0);
    expect(shot.stdout).toContain('640x400');
    expect(shot.stdout).toContain('screen: ');
    expect(backend.pullShots).toBe(1);
    expect([...written.values()].some((data) => data === PULL_JPEG)).toBe(true);
  });

  it('does not fail a landed poke when the frozen frame cannot be captured', async () => {
    const backend = new FakeBackend();
    backend.screenshot = async () => {
      throw new Error('capture exploded');
    };
    const registry = new ComputerRegistry(null);
    registry.register(backend);
    const cmd = createComputerCommand({ registry });
    const { ctx } = makeCtx();
    const result = await cmd.execute(['type', 'hi'], ctx);
    expect(result.exitCode).toBe(0);
    expect(backend.events).toEqual([{ type: 'text', text: 'hi' }]);
    expect(result.stderr).toContain('screenshot failed after input: capture exploded');
    expect(result.stdout).toContain('target: fake');
  });
});

describe('computer parse', () => {
  it('strips globals then chains xdotool verbs', () => {
    const g = parseGlobals(['-c', 'vm0', '--json', 'click', '1', 'type', 'hi']);
    expect(g.computer).toBe('vm0');
    expect(g.json).toBe(true);
    expect(chainVerbs(g.rest).map((c) => c.verb)).toEqual(['click', 'type']);
  });

  it('maps double_click onto click --repeat 2', () => {
    const [call] = chainVerbs(['double_click', '8', '9']);
    expect(call.verb).toBe('click');
    expect(call.args).toContain('1');
    expect(call.args).toContain('--repeat');
    expect(call.args).toContain('2');
  });

  it('extracts -c/--json/--native after the verb', () => {
    const shot = parseGlobals(['screenshot', '-c', 'tab:T1']);
    expect(shot.computer).toBe('tab:T1');
    expect(shot.rest).toEqual(['screenshot']);
    const typed = parseGlobals(['type', '-c', 'tab:T1', 'hello', '--json']);
    expect(typed.computer).toBe('tab:T1');
    expect(typed.json).toBe(true);
    expect(typed.rest).toEqual(['type', 'hello']);
    const escaped = parseGlobals(['type', '--', '-c', 'not-a-computer']);
    expect(escaped.computer).toBeUndefined();
    expect(escaped.rest).toEqual(['type', '--', '-c', 'not-a-computer']);
  });

  it('takes button plus two coords for click/mousedown/mouseup', () => {
    const chained = chainVerbs(['click', '1', '100', '200', 'type', 'hi']);
    expect(chained.map((c) => c.verb)).toEqual(['click', 'type']);
    expect(chained[0].args).toEqual(['1', '100', '200']);
    expect(chained[1].args).toEqual(['hi']);
    expect(chainVerbs(['click', 'left', '100', '200'])[0].args).toEqual(['left', '100', '200']);
    expect(chainVerbs(['mousedown', '100', '200'])[0].args).toEqual(['100', '200']);
    expect(chainVerbs(['mouseup', '2', '50', '60'])[0].args).toEqual(['2', '50', '60']);
  });

  it('parses record -V as a value flag, not a positional', () => {
    const [call] = chainVerbs(['record', '-V', '10', 'clip.webm']);
    expect(call.verb).toBe('record');
    expect(call.args).toEqual(['-V', '10', 'clip.webm']);
  });

  it('add ssh registers a view-only follower desktop', async () => {
    const sshExec = vi.fn(async (_runtimeId: string, command: string) => {
      if (command.includes('SLICC_SSH_PROBE')) {
        return {
          stdout: 'SLICC_SSH_PROBE Darwin screencapture cliclick xcrun \n',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const registry = new ComputerRegistry(null);
    const cmd = createComputerCommand({
      registry,
      listFollowers: () => [{ runtimeId: 'follower-abc', exec: true, floatType: 'standalone' }],
      sshExec,
    });
    const { ctx } = makeCtx();
    const added = await cmd.execute(['add', 'ssh', 'follower-abc', '-n', 'desk'], ctx);
    expect(added.exitCode).toBe(0);
    expect(added.stdout).toContain('ssh:follower-abc');
    const ls = await cmd.execute(['ls'], ctx);
    expect(ls.stdout).toContain('[view-only]');
    const typed = await cmd.execute(['type', 'hi'], ctx);
    expect(typed.exitCode).toBe(1);
    expect(typed.stderr).toContain('input is not allowed');
  });

  it('add ssh --allow-input rides sudo and shows the input badge', async () => {
    const sshExec = vi.fn(async (_runtimeId: string, command: string) => {
      if (command.includes('SLICC_SSH_PROBE')) {
        return {
          stdout: 'SLICC_SSH_PROBE Darwin screencapture cliclick \n',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const requestApproval = vi.fn(async () => ({ decision: 'allow' as const }));
    const registry = new ComputerRegistry(null);
    const cmd = createComputerCommand({
      registry,
      listFollowers: () => [{ runtimeId: 'follower-abc', exec: true, floatType: 'standalone' }],
      sshExec,
      sudoBroker: { requestApproval },
    });
    const { ctx } = makeCtx();
    const added = await cmd.execute(['add', 'ssh', 'follower-abc', '--allow-input'], ctx);
    expect(added.exitCode).toBe(0);
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'command', detail: expect.stringContaining('--allow-input') })
    );
    const ls = await cmd.execute(['ls'], ctx);
    expect(ls.stdout).toContain('[input]');
  });

  it('add ssh --allow-input fails closed when sudo denies', async () => {
    const sshExec = vi.fn(async () => ({
      stdout: 'SLICC_SSH_PROBE Darwin screencapture cliclick \n',
      stderr: '',
      exitCode: 0,
    }));
    const cmd = createComputerCommand({
      registry: new ComputerRegistry(null),
      listFollowers: () => [{ runtimeId: 'follower-abc', exec: true, floatType: 'standalone' }],
      sshExec,
      sudoBroker: { requestApproval: async () => ({ decision: 'deny' }) },
    });
    const { ctx } = makeCtx();
    const added = await cmd.execute(['add', 'ssh', 'follower-abc', '--allow-input'], ctx);
    expect(added.exitCode).toBe(1);
    expect(added.stderr).toContain('approval denied');
  });

  it('add ssh refuses an iOS follower as the computer', async () => {
    const cmd = createComputerCommand({
      registry: new ComputerRegistry(null),
      listFollowers: () => [{ runtimeId: 'iphone-1', exec: true, floatType: 'ios' }],
      sshExec: vi.fn(),
    });
    const { ctx } = makeCtx();
    const added = await cmd.execute(['add', 'ssh', 'iphone-1'], ctx);
    expect(added.exitCode).toBe(1);
    expect(added.stderr).toContain('iOS follower');
  });

  it('add ssh uses a computer-only follower without probing tray-exec', async () => {
    const sshExec = vi.fn();
    const capture = vi.fn(async () => ({
      bytes: MINIMAL_JPEG,
      mime: 'image/jpeg' as const,
      width: 1,
      height: 1,
      nativeWidth: 1920,
      nativeHeight: 1080,
    }));
    const input = vi.fn();
    const unwatch = vi.fn();
    const registry = new ComputerRegistry(null);
    const cmd = createComputerCommand({
      registry,
      listFollowers: () => [
        {
          runtimeId: 'sliccstart-computer-1',
          computer: true,
          exec: false,
          floatType: 'standalone',
        },
      ],
      sshExec,
      nativeComputer: () => ({ capture, input, unwatch }),
    });
    const { ctx } = makeCtx();
    const added = await cmd.execute(['add', 'ssh', 'sliccstart-computer-1', '-n', 'desk'], ctx);
    expect(added.exitCode).toBe(0);
    expect(sshExec).not.toHaveBeenCalled();
    const shot = await cmd.execute(['screenshot'], ctx);
    expect(shot.exitCode).toBe(0);
    expect(capture).toHaveBeenCalled();
  });

  it('points a failed add ssh at `host`, the lister that shows a computer-only follower (#3388)', async () => {
    const cmd = createComputerCommand({
      registry: new ComputerRegistry(null),
      // The roster that produced the bug: capture-only, so `ssh --list` (exec
      // only) cannot show it and must not be the command the error names.
      listFollowers: () => [
        {
          runtimeId: 'sliccstart-computer-1',
          computer: true,
          exec: false,
          floatType: 'standalone',
        },
      ],
      sshExec: vi.fn(),
    });
    const { ctx } = makeCtx();
    const missed = await cmd.execute(['add', 'ssh', 'follower-nope'], ctx);
    expect(missed.exitCode).toBe(1);
    expect(missed.stderr).toContain('no exec-capable or computer-capable follower');
    expect(missed.stderr).toContain('`host`');
    expect(missed.stderr).toContain('[computer]');
    expect(missed.stderr).not.toMatch(/try `ssh --list`/);
  });

  it('add ssh --allow-input on a computer follower does not need cliclick', async () => {
    const requestApproval = vi.fn(async () => ({ decision: 'allow' as const }));
    const input = vi.fn();
    const cmd = createComputerCommand({
      registry: new ComputerRegistry(null),
      listFollowers: () => [
        {
          runtimeId: 'sliccstart-computer-1',
          computer: true,
          exec: false,
          floatType: 'standalone',
        },
      ],
      sshExec: vi.fn(),
      nativeComputer: () => ({
        capture: async () => ({
          bytes: MINIMAL_JPEG,
          mime: 'image/jpeg' as const,
          width: 1,
          height: 1,
          nativeWidth: 1,
          nativeHeight: 1,
        }),
        input,
        unwatch: vi.fn(),
      }),
      sudoBroker: { requestApproval },
    });
    const { ctx } = makeCtx();
    const added = await cmd.execute(['add', 'ssh', 'sliccstart-computer-1', '--allow-input'], ctx);
    expect(added.exitCode).toBe(0);
    const typed = await cmd.execute(['type', 'hi'], ctx);
    expect(typed.exitCode).toBe(0);
    expect(input).toHaveBeenCalled();
  });

  it('surfaces Accessibility denial from native input through the shell verb', async () => {
    const requestApproval = vi.fn(async () => ({ decision: 'allow' as const }));
    const input = vi.fn(async () => {
      throw new Error(
        'Accessibility is not allowed. Grant it in System Settings → Privacy & Security → Accessibility, then try again.'
      );
    });
    const cmd = createComputerCommand({
      registry: new ComputerRegistry(null),
      listFollowers: () => [
        {
          runtimeId: 'sliccstart-computer-1',
          computer: true,
          exec: false,
          floatType: 'standalone',
        },
      ],
      sshExec: vi.fn(),
      nativeComputer: () => ({
        capture: async () => ({
          bytes: MINIMAL_JPEG,
          mime: 'image/jpeg' as const,
          width: 1,
          height: 1,
          nativeWidth: 1,
          nativeHeight: 1,
        }),
        input,
        unwatch: vi.fn(),
      }),
      sudoBroker: { requestApproval },
    });
    const { ctx } = makeCtx();
    const added = await cmd.execute(['add', 'ssh', 'sliccstart-computer-1', '--allow-input'], ctx);
    expect(added.exitCode).toBe(0);
    const typed = await cmd.execute(['type', 'hi'], ctx);
    expect(typed.exitCode).toBe(1);
    expect(typed.stderr).toContain('Accessibility is not allowed');
    expect(typed.stderr).toContain('System Settings');
  });

  it('add ssh --sim refuses a computer-only follower', async () => {
    const cmd = createComputerCommand({
      registry: new ComputerRegistry(null),
      listFollowers: () => [
        {
          runtimeId: 'sliccstart-computer-1',
          computer: true,
          exec: false,
          floatType: 'standalone',
        },
      ],
      sshExec: vi.fn(),
      nativeComputer: () => ({
        capture: async () => {
          throw new Error('unused');
        },
        input: vi.fn(),
        unwatch: vi.fn(),
      }),
    });
    const { ctx } = makeCtx();
    const added = await cmd.execute(['add', 'ssh', 'sliccstart-computer-1', '--sim', 'UDID'], ctx);
    expect(added.exitCode).toBe(1);
    expect(added.stderr).toContain('--sim needs an exec-capable');
  });

  it('add url probes GET /computer through the injected fetch', async () => {
    const jpeg = MINIMAL_JPEG;
    const urlFetch = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/computer') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(
            JSON.stringify({
              kind: 'vnc',
              title: 'computer-demo',
              size: { width: 1, height: 1 },
              state: 'live',
              capabilities: {
                screenshot: true,
                text: true,
                frames: 'poll',
                keyboard: true,
                mouse: 'absolute',
                scroll: true,
                exec: false,
                inputAllowed: true,
              },
            })
          ),
        };
      }
      if (path === '/computer/screenshot') {
        return { status: 200, headers: { 'content-type': 'image/jpeg' }, body: jpeg };
      }
      if (path === '/computer/text') {
        return {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: new TextEncoder().encode('demo\n'),
        };
      }
      if (path === '/computer/input') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        };
      }
      return { status: 404, headers: { 'content-type': 'text/plain' }, body: new Uint8Array() };
    });
    const registry = new ComputerRegistry(null);
    const cmd = createComputerCommand({ registry, urlFetch });
    const { ctx } = makeCtx();
    const added = await cmd.execute(
      ['add', 'url', 'http://127.0.0.1:5710/computer', '-n', 'demo'],
      ctx
    );
    expect(added.exitCode).toBe(0);
    expect(added.stdout).toContain('url:127.0.0.1:5710');
    expect(added.stdout).toContain('demo');
    const ls = await cmd.execute(['ls'], ctx);
    expect(ls.stdout).toContain('url');
    const text = await cmd.execute(['text'], ctx);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('demo');
    const typed = await cmd.execute(['type', 'hi'], ctx);
    expect(typed.exitCode).toBe(0);
    expect(urlFetch.mock.calls.some((c) => String(c[0]).includes('/computer/input'))).toBe(true);
  });

  it('add url refuses a non-http base', async () => {
    const cmd = createComputerCommand({
      registry: new ComputerRegistry(null),
      urlFetch: vi.fn(),
    });
    const { ctx } = makeCtx();
    const added = await cmd.execute(['add', 'url', 'ws://127.0.0.1:5710'], ctx);
    expect(added.exitCode).toBe(1);
    expect(added.stderr).toContain('only http(s) bases');
  });
});
