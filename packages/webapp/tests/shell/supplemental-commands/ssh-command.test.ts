import type { ResolvedCommandContext } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSshCommand } from '../../../src/shell/supplemental-commands/ssh-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const hoisted = vi.hoisted(() => ({
  client: null as { call: ReturnType<typeof vi.fn> } | null,
  followers: [] as Array<{
    runtimeId: string;
    runtime?: string;
    connectedAt?: string;
    exec?: boolean;
    motd?: string;
  }>,
}));

vi.mock('../../../src/kernel/panel-rpc.js', () => ({
  getPanelRpcClient: () => hoisted.client,
}));

vi.mock('../../../src/shell/supplemental-commands/host-command.js', () => ({
  getConnectedFollowersWithFallback: () => hoisted.followers,
}));

/** ssh only reads `ctx.signal`; a bare object suffices. */
function ctx(signal?: AbortSignal): ResolvedCommandContext {
  return { signal } as unknown as ResolvedCommandContext;
}

describe('ssh command', () => {
  beforeEach(() => {
    hoisted.client = null;
    hoisted.followers = [];
  });

  it('has the correct name', () => {
    expect(createSshCommand().name).toBe('ssh');
  });

  it('shows help for --help and -h', async () => {
    for (const args of [['--help'], ['-h']]) {
      const r = await createSshCommand().execute(args, ctx());
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('ssh - run a command on a connected tray follower');
      expect(r.stdout).toContain('launches the approved destination');
    }
  });

  it('lists only exec-capable followers (bare, --list, -l)', async () => {
    hoisted.followers = [
      { runtimeId: 'follower-a', runtime: 'slicc-cli', exec: true },
      { runtimeId: 'follower-b', runtime: 'slicc-standalone', exec: false },
    ];
    for (const args of [[], ['--list'], ['-l']]) {
      const r = await createSshCommand().execute(args, ctx());
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('follower-a');
      expect(r.stdout).not.toContain('follower-b');
    }
  });

  it('shows each exec target’s advertised MOTD under it', async () => {
    hoisted.followers = [
      {
        runtimeId: 'follower-a',
        runtime: 'slicc-cli',
        exec: true,
        motd: 'slicc-cli exec target · alice@studio · darwin/arm64 · runner: sh -c',
      },
    ];
    const r = await createSshCommand().execute(['--list'], ctx());
    expect(r.stdout).toContain('  - follower-a');
    expect(r.stdout).toContain(
      '      slicc-cli exec target · alice@studio · darwin/arm64 · runner: sh -c'
    );
  });

  it('lists an iOS follower with its restricted-command MOTD', async () => {
    hoisted.followers = [
      {
        runtimeId: 'follower-ios',
        runtime: 'slicc-ios',
        exec: true,
        motd: 'SLICC iOS follower on iPhone — only supported command: open',
      },
    ];
    const r = await createSshCommand().execute(['--list'], ctx());
    expect(r.stdout).toContain('  - follower-ios (slicc-ios)');
    expect(r.stdout).toContain('      SLICC iOS follower on iPhone — only supported command: open');
  });

  it('reports when no follower is an exec target', async () => {
    hoisted.followers = [{ runtimeId: 'follower-b', exec: false }];
    const r = await createSshCommand().execute([], ctx());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No exec-capable followers');
  });

  it('errors when no panel bridge is available', async () => {
    hoisted.client = null;
    const r = await createSshCommand().execute(['follower-a', 'echo', 'hi'], ctx());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('not available');
  });

  it('runs a command and returns the buffered result', async () => {
    const call = vi.fn(async (op: string) =>
      op === 'tray-exec' ? { stdout: 'hi\n', stderr: '', exitCode: 0 } : { ok: true }
    );
    hoisted.client = { call };
    const r = await createSshCommand().execute(['follower-a', 'echo', 'hi'], ctx());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hi\n');
    expect(call).toHaveBeenCalledWith(
      'tray-exec',
      expect.objectContaining({
        runtimeId: 'follower-a',
        command: 'echo hi',
        execToken: expect.any(String),
      }),
      expect.any(Object)
    );
  });

  it('threads --cwd into the exec payload', async () => {
    const call = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    hoisted.client = { call };
    await createSshCommand().execute(['--cwd', '/tmp', 'follower-a', 'ls'], ctx());
    expect(call).toHaveBeenCalledWith(
      'tray-exec',
      expect.objectContaining({ cwd: '/tmp', command: 'ls', runtimeId: 'follower-a' }),
      expect.any(Object)
    );
  });

  it('surfaces a follower exec error with a non-zero exit', async () => {
    const call = vi.fn(async () => ({
      stdout: '',
      stderr: 'boom\n',
      exitCode: 2,
      error: 'not an exec target',
    }));
    hoisted.client = { call };
    const r = await createSshCommand().execute(['follower-a', 'echo'], ctx());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('not an exec target');
    expect(r.stderr).toContain('boom');
  });

  it('errors when the command is missing', async () => {
    hoisted.client = { call: vi.fn() };
    const r = await createSshCommand().execute(['follower-a'], ctx());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('missing command');
  });

  it('rejects unknown flags', async () => {
    const r = await createSshCommand().execute(['--bogus', 'follower-a', 'ls'], ctx());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('unknown flag');
  });

  it('rejects a non-positive --timeout', async () => {
    const r = await createSshCommand().execute(['--timeout', 'nope', 'follower-a', 'ls'], ctx());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--timeout');
  });

  it('forwards piped stdin to tray-exec as base64', async () => {
    const call = vi.fn(async () => ({ stdout: 'ok\n', stderr: '', exitCode: 0 }));
    hoisted.client = { call };
    const r = await createSshCommand().execute(
      ['follower-a', 'cat'],
      mockCommandContext({ stdin: 'piped in\n' })
    );
    expect(r.exitCode).toBe(0);
    expect(call).toHaveBeenCalledWith(
      'tray-exec',
      expect.objectContaining({
        runtimeId: 'follower-a',
        command: 'cat',
        stdin: Buffer.from('piped in\n', 'utf-8').toString('base64'),
      }),
      expect.any(Object)
    );
  });

  it('omits stdin when nothing was piped', async () => {
    const call = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    hoisted.client = { call };
    await createSshCommand().execute(['follower-a', 'echo', 'hi'], mockCommandContext());
    expect(call).toHaveBeenCalledWith(
      'tray-exec',
      expect.not.objectContaining({ stdin: expect.anything() }),
      expect.any(Object)
    );
  });

  it('forwards Ctrl+C as tray-exec-signal', async () => {
    const controller = new AbortController();
    let resolveExec!: (v: unknown) => void;
    const call = vi.fn((op: string) => {
      if (op === 'tray-exec') {
        return new Promise((resolve) => {
          resolveExec = resolve;
        });
      }
      return Promise.resolve({ ok: true });
    });
    hoisted.client = { call };
    const pending = createSshCommand().execute(
      ['follower-a', 'sleep', '10'],
      ctx(controller.signal)
    );
    await Promise.resolve();
    controller.abort();
    resolveExec({ stdout: '', stderr: '', exitCode: 130 });
    const r = await pending;
    expect(call).toHaveBeenCalledWith('tray-exec-signal', { execToken: expect.any(String) });
    expect(r.exitCode).toBe(130);
  });
});
