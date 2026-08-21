import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFollowerSprinkleInstancesGetter } from '../../../src/shell/sprinkle-instances.js';
import { createSprinkleCommand } from '../../../src/shell/supplemental-commands/sprinkle-command.js';
import type { SprinkleManager } from '../../../src/ui/sprinkle-manager.js';

describe('sprinkle command', () => {
  let mockMgr: Partial<SprinkleManager>;
  let command: ReturnType<typeof createSprinkleCommand>;

  beforeEach(() => {
    mockMgr = {
      refresh: vi.fn().mockResolvedValue(undefined),
      available: vi.fn().mockReturnValue([
        {
          name: 'dash',
          path: '/shared/sprinkles/dash/dash.shtml',
          title: 'Dashboard',
          autoOpen: false,
        },
      ]),
      opened: vi.fn().mockReturnValue([]),
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      sendToSprinkle: vi.fn().mockReturnValue({ leader: true, followers: [] }),
    };
    // Publish on `globalThis` — the command looks there directly so the
    // same lookup works in both the page realm (where the real manager
    // lives on `window`) and the kernel-worker realm (where the proxy
    // is published on `globalThis`).
    (globalThis as any).__slicc_sprinkleManager = mockMgr;
    command = createSprinkleCommand();
  });

  afterEach(() => {
    delete (globalThis as any).__slicc_sprinkleManager;
    setFollowerSprinkleInstancesGetter(null);
  });

  const run = (args: string[]) => {
    return (command as any).execute(args, {
      cwd: '/',
      env: {},
      fs: {} as any,
    });
  };

  it('shows help with no args', async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage:');
  });

  it('list shows available sprinkles', async () => {
    const result = await run(['list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('dash');
    expect(result.stdout).toContain('Dashboard');
  });

  it('list shows [open] for open sprinkles', async () => {
    (mockMgr.opened as ReturnType<typeof vi.fn>).mockReturnValue(['dash']);
    const result = await run(['list']);
    expect(result.stdout).toContain('[open]');
  });

  it('open calls mgr.open', async () => {
    const result = await run(['open', 'dash']);
    expect(result.exitCode).toBe(0);
    expect(mockMgr.open).toHaveBeenCalledWith('dash');
  });

  it('open requires name', async () => {
    const result = await run(['open']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('name required');
  });

  it('close calls mgr.close', async () => {
    const result = await run(['close', 'dash']);
    expect(result.exitCode).toBe(0);
    expect(mockMgr.close).toHaveBeenCalledWith('dash');
  });

  it('close requires name', async () => {
    const result = await run(['close']);
    expect(result.exitCode).toBe(1);
  });

  it('refresh re-scans and reports count', async () => {
    const result = await run(['refresh']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1 sprinkle');
    expect(mockMgr.refresh).toHaveBeenCalled();
  });

  it('send pushes JSON data to sprinkle', async () => {
    const result = await run(['send', 'dash', '{"status":"ok"}']);
    expect(result.exitCode).toBe(0);
    expect(mockMgr.sendToSprinkle).toHaveBeenCalledWith('dash', { status: 'ok' }, undefined);
  });

  it('send rejects invalid JSON', async () => {
    const result = await run(['send', 'dash', 'not json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid JSON');
  });

  it('send requires name', async () => {
    const result = await run(['send']);
    expect(result.exitCode).toBe(1);
  });

  it('send requires data', async () => {
    const result = await run(['send', 'dash']);
    expect(result.exitCode).toBe(1);
  });

  it('unknown subcommand returns error', async () => {
    const result = await run(['unknown']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown subcommand');
  });

  it('`open --help` prints help instead of opening the sprinkle', async () => {
    const result = await run(['open', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('open <name>');
    expect(mockMgr.open).not.toHaveBeenCalled();
  });

  it('`chat --help` prints help instead of rendering the flag as Tool UI', async () => {
    // Regression: `chat` treats its trailing args as HTML, so asking it for
    // help rendered "--help" into the chat transcript.
    const result = await run(['chat', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('chat <html>');
  });

  it('returns error when sprinkle manager not initialized', async () => {
    delete (globalThis as any).__slicc_sprinkleManager; // clear the publish
    const cmd = createSprinkleCommand();
    const result = await (cmd as any).execute(['list'], { cwd: '/', env: {}, fs: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not initialized');
  });
  // ── issue #2166: unknown flags, targeting, and honest delivery ───────────

  describe('unknown flags', () => {
    it('list rejects an unrecognised flag instead of ignoring it', async () => {
      // The bug: `list --runtime=TOTALLY-FAKE-ID` printed the full listing and
      // exited 0, so a probe against a fabricated runtime "proved" delivery.
      const result = await run(['list', '--bogus=1']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unknown flag: --bogus');
    });

    it('list rejects a fabricated runtime id', async () => {
      const result = await run(['list', '--runtime=TOTALLY-FAKE-ID']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unknown runtime "TOTALLY-FAKE-ID"');
    });

    it('open, close, reload and refresh reject flags they do not take', async () => {
      for (const argv of [
        ['open', 'dash', '--runtime=x'],
        ['close', 'dash', '--runtime=x'],
        ['reload', 'dash', '--runtime=x'],
        ['refresh', '--runtime=x'],
      ]) {
        const result = await run(argv);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('unknown flag: --runtime');
      }
      expect(mockMgr.open).not.toHaveBeenCalled();
      expect(mockMgr.close).not.toHaveBeenCalled();
    });

    it('route still accepts its own flags', async () => {
      const result = await run(['route', 'dash', '--scoop', 'dash-scoop']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('dash-scoop');
    });

    it('send rejects an unrecognised flag rather than folding it into the JSON', async () => {
      // Previously this reported "invalid JSON" — the flag was concatenated
      // into the payload, which read as a malformed push rather than an
      // unsupported flag.
      const result = await run(['send', 'dash', '{"a":1}', '--nope']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unknown flag: --nope');
    });
  });

  describe('send targeting and delivery', () => {
    it('accepts --runtime=leader before or after the payload', async () => {
      for (const argv of [
        ['send', '--runtime=leader', 'dash', '{"a":1}'],
        ['send', 'dash', '{"a":1}', '--runtime=leader'],
        ['send', 'dash', '{"a":1}', '--runtime', 'leader'],
      ]) {
        const result = await run(argv);
        expect(result.exitCode).toBe(0);
        expect(mockMgr.sendToSprinkle).toHaveBeenCalledWith(
          'dash',
          { a: 1 },
          { runtime: 'leader' }
        );
      }
    });

    it('rejects a fabricated runtime without touching the manager', async () => {
      const result = await run(['send', 'dash', '{"a":1}', '--runtime=BOGUS']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unknown runtime "BOGUS"');
      expect(mockMgr.sendToSprinkle).not.toHaveBeenCalled();
    });

    it('reports how many instances the push reached', async () => {
      (mockMgr.sendToSprinkle as ReturnType<typeof vi.fn>).mockReturnValue({
        leader: true,
        followers: ['follower-8a474d67'],
      });
      const result = await run(['send', 'dash', '{"a":1}']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('2 instances');
      expect(result.stdout).toContain('leader, follower-8a474d67');
    });

    it('exits non-zero when the push reached nothing', async () => {
      // The reported bug: three pushes "succeeded" while the instance that
      // asked for them plausibly stayed empty.
      (mockMgr.sendToSprinkle as ReturnType<typeof vi.fn>).mockReturnValue({
        leader: false,
        followers: [],
      });
      const result = await run(['send', 'dash', '{"a":1}']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('nothing was delivered');
    });

    it('surfaces a runtime the manager could not resolve', async () => {
      (mockMgr.sendToSprinkle as ReturnType<typeof vi.fn>).mockReturnValue({
        leader: false,
        followers: [],
        unknownRuntime: 'follower-gone',
      });
      const result = await run(['send', 'dash', '{"a":1}']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unknown runtime "follower-gone"');
    });

    it('fails when the manager returns no delivery report', async () => {
      (mockMgr.sendToSprinkle as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      const result = await run(['send', 'dash', '{"a":1}']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('no delivery report');
    });
  });

  describe('list instances', () => {
    it('reports the leader instance for an open sprinkle', async () => {
      (mockMgr.opened as ReturnType<typeof vi.fn>).mockReturnValue(['dash']);
      const result = await run(['list']);
      expect(result.stdout).toContain('instance: leader');
    });

    it('reports follower instances from the mirrored report', async () => {
      (mockMgr.opened as ReturnType<typeof vi.fn>).mockReturnValue(['dash']);
      setFollowerSprinkleInstancesGetter(() => [
        { name: 'dash', runtimeId: 'follower-8a474d67', runtime: 'slicc-standalone' },
      ]);
      const result = await run(['list']);
      expect(result.stdout).toContain('instance: leader');
      expect(result.stdout).toContain('instance: follower-8a474d67 (slicc-standalone)');
    });

    it('--runtime filters the report to that runtime', async () => {
      (mockMgr.opened as ReturnType<typeof vi.fn>).mockReturnValue(['dash']);
      const result = await run(['list', '--runtime=leader']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('instance: leader');
      expect(result.stdout).not.toContain('follower-');
    });

    it('says so when the named runtime renders nothing', async () => {
      (mockMgr.opened as ReturnType<typeof vi.fn>).mockReturnValue([]);
      const result = await run(['list', '--runtime=leader']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No sprinkles are open on runtime "leader"');
    });
  });
});
