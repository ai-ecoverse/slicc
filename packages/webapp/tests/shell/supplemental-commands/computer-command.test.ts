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
    expect(help.stdout).toContain('add ssh');
    expect(help.stdout).toContain('add url');
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

  it('record writes a clip for screen and refuses other kinds', async () => {
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
    const otherCmd = createComputerCommand({ registry: other });
    const refused = await otherCmd.execute(['record'], makeCtx().ctx);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("not supported for 'jsh' yet (phase 4)");
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
        return { status: 200, headers: {}, body: new TextEncoder().encode('demo\n') };
      }
      if (path === '/computer/input') {
        return { status: 200, headers: {}, body: new TextEncoder().encode('{"ok":true}') };
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
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
