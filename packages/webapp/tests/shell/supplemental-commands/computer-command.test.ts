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
    const shot = await cmd.execute(['screenshot', '--size', 'medium'], ctx);
    expect(shot.exitCode).toBe(0);
    expect(shot.stdout).toContain('1000x500 → 768x384');
    expect(shot.stdout).toContain('screen: ');
    expect([...written.keys()].some((p) => p.endsWith('.jpg'))).toBe(true);
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

  it('resolves $COMPUTER and errors when none match', async () => {
    const registry = new ComputerRegistry(null);
    registry.register(new FakeBackend('a'));
    registry.register(new FakeBackend('b'));
    const cmd = createComputerCommand({ registry });
    const { ctx } = makeCtx(new Map([['COMPUTER', 'b']]));
    const info = await cmd.execute(['info'], ctx);
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
});
