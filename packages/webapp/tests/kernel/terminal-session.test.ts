import { describe, expect, it, type Mock, vi } from 'vitest';
import { ProcessManager } from '../../src/kernel/process-manager.js';
import { TerminalSessionClient } from '../../src/kernel/terminal-session-client.js';
import { TerminalSessionHost } from '../../src/kernel/terminal-session-host.js';
import {
  createBridgeMessageChannelTransport,
  createPanelMessageChannelTransport,
} from '../../src/kernel/transport-message-channel.js';
import type { HeadlessShellLike } from '../../src/shell/almost-bash-shell-headless.js';
import type { TerminalEventMsg } from '../../src/shell/terminal-protocol.js';
import { OffscreenClient } from '../../src/ui/offscreen-client.js';

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface StubShell extends HeadlessShellLike {
  applySessionOverrides: Mock<NonNullable<HeadlessShellLike['applySessionOverrides']>>;
  dispose: Mock<() => void>;
  executeCommand: Mock<HeadlessShellLike['executeCommand']>;
}

function makeStubShell(opts?: {
  output?: { stdout?: string; stderr?: string; exitCode?: number };
  delayMs?: number;
  shouldThrow?: boolean;
  observeAbort?: (signal: AbortSignal) => void;
}): StubShell {
  const delayMs = opts?.delayMs;
  const shouldThrow = opts?.shouldThrow;
  const stdout = opts?.output?.stdout ?? '';
  const stderr = opts?.output?.stderr ?? '';
  const exitCode = opts?.output?.exitCode ?? 0;
  const executeCommand = vi.fn(async (_command: string, signal?: AbortSignal) => {
    opts?.observeAbort?.(signal!);
    if (delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      }).catch(() => undefined);
    }
    if (shouldThrow) throw new Error('boom');
    return { stdout, stderr, exitCode };
  });
  return {
    applySessionOverrides: vi.fn(),
    dispose: vi.fn(),
    executeCommand,
    executeScriptFile: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    getBash: vi.fn(),
    getCwd: () => '/',
    getEnv: () => ({}),
    getJshCommandNames: vi.fn(async () => []),
    getScriptCatalog: vi.fn(),
    syncJshCommands: vi.fn(async () => undefined),
  } as unknown as StubShell;
}

function setupChannel(): {
  host: TerminalSessionHost;
  client: TerminalSessionClient;
  panelClient: OffscreenClient;
  shell: StubShell;
  events: TerminalEventMsg[];
  channel: MessageChannel;
  shellFactory: ReturnType<typeof vi.fn>;
  dispose: () => void;
} {
  const channel = new MessageChannel();

  const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
  const shell = makeStubShell();
  const shellFactory = vi.fn(() => shell);
  const host = new TerminalSessionHost({
    transport: bridgeTransport,
    createShell: shellFactory,
    logger: { warn: vi.fn(), debug: vi.fn() },
  });
  const stopHost = host.start();

  const panelTransport = createPanelMessageChannelTransport(channel.port1);
  const panelClient = new OffscreenClient(
    {
      onStatusChange: vi.fn(),
      onScoopCreated: vi.fn(),
      onScoopListUpdate: vi.fn(),
      onIncomingMessage: vi.fn(),
    },
    panelTransport
  );

  const events: TerminalEventMsg[] = [];
  const client = new TerminalSessionClient({
    client: panelClient,
    sid: 's1',
    onEvent: (e) => events.push(e),
  });

  return {
    host,
    client,
    panelClient,
    shell,
    events,
    channel,
    shellFactory,
    dispose: () => {
      client.close();
      stopHost();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe('TerminalSessionHost ⇄ TerminalSessionClient round-trip', () => {
  it('open → status: opened resolves', async () => {
    const ctx = setupChannel();
    await ctx.client.open({ cwd: '/tmp' });
    expect(ctx.shellFactory).toHaveBeenCalledWith('s1', { cwd: '/tmp', env: undefined });
    expect(ctx.events.some((e) => e.type === 'terminal-status' && e.state === 'opened')).toBe(true);
    ctx.dispose();
  });

  it('open with env forwards env through to the shell factory', async () => {
    const ctx = setupChannel();
    await ctx.client.open({
      cwd: '/workspace',
      env: { GITHUB_TOKEN: 'ghp_masked_xyz', NPM_TOKEN: 'npm_masked_abc' },
    });
    expect(ctx.shellFactory).toHaveBeenCalledWith('s1', {
      cwd: '/workspace',
      env: { GITHUB_TOKEN: 'ghp_masked_xyz', NPM_TOKEN: 'npm_masked_abc' },
    });
    ctx.dispose();
  });

  it('exec round-trips stdout + stderr + exit code', async () => {
    const ctx = setupChannel();
    ctx.shell.executeCommand.mockResolvedValue({
      stdout: 'hello\n',
      stderr: 'warning\n',
      exitCode: 0,
    });
    await ctx.client.open();
    const result = await ctx.client.exec('echo hello');
    expect(result).toEqual({ stdout: 'hello\n', stderr: 'warning\n', exitCode: 0 });

    expect(ctx.shell.executeCommand).toHaveBeenCalledWith(
      'echo hello',
      expect.any(AbortSignal),
      undefined,
      ''
    );
    ctx.dispose();
  });

  it('forwards base64 stdin through exec to executeCommand', async () => {
    const ctx = setupChannel();
    const stdin = Buffer.from('hello\n', 'utf-8').toString('base64');
    ctx.shell.executeCommand.mockResolvedValue({
      stdout: 'hello\n',
      stderr: '',
      exitCode: 0,
    });
    await ctx.client.open();
    await ctx.client.exec('cat', { stdin });
    expect(ctx.shell.executeCommand).toHaveBeenCalledWith(
      'cat',
      expect.any(AbortSignal),
      undefined,
      expect.anything()
    );
    const stdinArg = ctx.shell.executeCommand.mock.calls[0]?.[3];
    expect((stdinArg as unknown as string).length).toBeGreaterThan(0);
    ctx.dispose();
  });

  it('can stream output without retaining it in the exec result', async () => {
    const ctx = setupChannel();
    const output = 'x'.repeat(128 * 1024);
    ctx.shell.executeCommand.mockResolvedValue({ stdout: output, stderr: '', exitCode: 0 });
    await ctx.client.open();

    const result = await ctx.client.exec('large-output', { discardCapturedOutput: true });

    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(
      ctx.events
        .filter((event) => event.type === 'terminal-output')
        .map((event) => (event.type === 'terminal-output' ? event.data : ''))
        .join('')
    ).toBe(output);
    ctx.dispose();
  });

  it('applies per-exec cwd and env overrides before running a persistent shell command', async () => {
    const ctx = setupChannel();
    await ctx.client.open({ cwd: '/initial', env: { NAME: 'first' } });
    await ctx.client.exec('pwd', {
      cwd: '/workspace',
      env: { NAME: 'second', COLUMNS: '120', LINES: '40' },
    });

    expect(ctx.shell.applySessionOverrides).toHaveBeenCalledWith({
      cwd: '/workspace',
      env: { NAME: 'second', COLUMNS: '120', LINES: '40' },
    });
    expect(ctx.shell.applySessionOverrides.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.shell.executeCommand.mock.invocationCallOrder[0]
    );
    ctx.dispose();
  });

  it('exec failure surfaces a non-zero exit + stderr', async () => {
    const ctx = setupChannel();
    ctx.shell.executeCommand.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await ctx.client.open();
    const result = await ctx.client.exec('bad-cmd');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('boom');
    ctx.dispose();
  });

  it('signal SIGINT aborts the in-flight exec and emits exit 130', async () => {
    let observedSignal: AbortSignal | undefined;
    const ctx = setupChannel();
    ctx.shell.executeCommand.mockImplementation(async (_cmd, signal) => {
      observedSignal = signal;

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 500);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await ctx.client.open();

    const execP = ctx.client.exec('sleep 1');
    await tick(20);
    ctx.client.signal('SIGINT');
    const result = await execP;
    expect(result.exitCode).toBe(130);
    expect(observedSignal?.aborted).toBe(true);
    ctx.dispose();
  });

  it('exec on unknown session yields exit 127', async () => {
    const ctx = setupChannel();

    const result = await ctx.client.exec('echo hello');
    expect(result.exitCode).toBe(127);
    ctx.dispose();
  });

  it('close disposes the worker shell and rejects pending opens', async () => {
    const ctx = setupChannel();
    await ctx.client.open();
    expect(ctx.shell.dispose).not.toHaveBeenCalled();
    ctx.client.close();

    await vi.waitFor(() => expect(ctx.shell.dispose).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(ctx.events.some((e) => e.type === 'terminal-status' && e.state === 'closed')).toBe(
        true
      )
    );
    ctx.dispose();
  });

  it('close before open resolves still disposes the queued worker shell', async () => {
    const ctx = setupChannel();
    const openP = ctx.client.open({ retryMs: 1000 });

    ctx.client.close();

    await expect(openP).rejects.toThrow(/closed/);
    await vi.waitFor(() => expect(ctx.shellFactory).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(ctx.shell.dispose).toHaveBeenCalledTimes(1));
    ctx.dispose();
  });

  it('registers a kind:"shell" process on each exec when ProcessManager is provided', async () => {
    const channel = new MessageChannel();
    const pm = new ProcessManager();
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
    const shell = makeStubShell();
    shell.executeCommand.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
    const host = new TerminalSessionHost({
      transport: bridgeTransport,
      createShell: () => shell,
      processManager: pm,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const stopHost = host.start();
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const panelClient = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );
    const client = new TerminalSessionClient({ client: panelClient, sid: 'sp' });

    await client.open();
    expect(pm.list()).toHaveLength(0);

    const result = await client.exec('echo hi');
    expect(result.exitCode).toBe(0);
    const procs = pm.list();
    expect(procs).toHaveLength(1);
    expect(procs[0].kind).toBe('shell');
    expect(procs[0].argv).toEqual(['echo hi']);
    expect(procs[0].status).toBe('exited');
    expect(procs[0].exitCode).toBe(0);

    client.close();
    stopHost();
    channel.port1.close();
    channel.port2.close();
  });

  it('SIGINT through the manager records terminatedBy and emits exit 130', async () => {
    const channel = new MessageChannel();
    const pm = new ProcessManager();
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
    const shell = makeStubShell();
    shell.executeCommand.mockImplementation(async (_cmd, signal) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 500);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const host = new TerminalSessionHost({
      transport: bridgeTransport,
      createShell: () => shell,
      processManager: pm,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const stopHost = host.start();
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const panelClient = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );
    const client = new TerminalSessionClient({ client: panelClient, sid: 'sk' });

    await client.open();
    const execP = client.exec('sleep 1');
    await tick(20);
    client.signal('SIGINT');
    const result = await execP;
    expect(result.exitCode).toBe(130);
    const proc = pm.list()[0];
    expect(proc.terminatedBy).toBe('SIGINT');
    expect(proc.status).toBe('killed');
    expect(proc.exitCode).toBe(130);

    client.close();
    stopHost();
    channel.port1.close();
    channel.port2.close();
  });

  function setupResolveOnAbort(sid: string): {
    pm: ProcessManager;
    client: TerminalSessionClient;
    dispose: () => void;
  } {
    const channel = new MessageChannel();
    const pm = new ProcessManager();
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
    const shell = makeStubShell();

    shell.executeCommand.mockImplementation(async (_cmd, signal) => {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 500);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        });
      });
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const host = new TerminalSessionHost({
      transport: bridgeTransport,
      createShell: () => shell,
      processManager: pm,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const stopHost = host.start();
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const panelClient = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );
    const client = new TerminalSessionClient({ client: panelClient, sid });
    return {
      pm,
      client,
      dispose: () => {
        client.close();
        stopHost();
        channel.port1.close();
        channel.port2.close();
      },
    };
  }

  it('SIGTERM on a job that returns normally from the shell emits exit 143 (not 130)', async () => {
    const ctx = setupResolveOnAbort('st');
    await ctx.client.open();
    const execP = ctx.client.exec('long-runner');
    await tick(20);
    const proc = ctx.pm.list().find((p) => p.kind === 'shell')!;
    ctx.pm.signal(proc.pid, 'SIGTERM');
    const result = await execP;
    expect(result.exitCode).toBe(143);
    expect(proc.terminatedBy).toBe('SIGTERM');
    ctx.dispose();
  });

  it('SIGKILL on a job that returns normally from the shell emits exit 137 (not 130)', async () => {
    const ctx = setupResolveOnAbort('sk9');
    await ctx.client.open();
    const execP = ctx.client.exec('long-runner');
    await tick(20);
    const proc = ctx.pm.list().find((p) => p.kind === 'shell')!;
    ctx.pm.signal(proc.pid, 'SIGKILL');
    const result = await execP;
    expect(result.exitCode).toBe(137);
    expect(proc.terminatedBy).toBe('SIGKILL');
    ctx.dispose();
  });

  it('SIGINT on a job that returns normally from the shell still emits exit 130', async () => {
    const ctx = setupResolveOnAbort('si2');
    await ctx.client.open();
    const execP = ctx.client.exec('long-runner');
    await tick(20);
    const proc = ctx.pm.list().find((p) => p.kind === 'shell')!;
    ctx.pm.signal(proc.pid, 'SIGINT');
    const result = await execP;
    expect(result.exitCode).toBe(130);
    expect(proc.terminatedBy).toBe('SIGINT');
    ctx.dispose();
  });

  it('SIGSTOP holds output emission; SIGCONT releases it', async () => {
    const channel = new MessageChannel();
    const pm = new ProcessManager();
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
    const shell = makeStubShell();

    shell.executeCommand.mockImplementation(async (_cmd, signal) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 50);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      return { stdout: 'hello\n', stderr: '', exitCode: 0 };
    });
    const host = new TerminalSessionHost({
      transport: bridgeTransport,
      createShell: () => shell,
      processManager: pm,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const stopHost = host.start();
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const events: TerminalEventMsg[] = [];
    const panelClient = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );
    const client = new TerminalSessionClient({
      client: panelClient,
      sid: 'sg',
      onEvent: (e) => events.push(e),
    });

    await client.open();
    const execP = client.exec('echo hello');

    await tick(20);
    const shellProc = pm.list().find((p) => p.kind === 'shell');
    expect(shellProc).toBeDefined();
    pm.signal(shellProc!.pid, 'SIGSTOP');

    await tick(100);
    expect(events.find((e) => e.type === 'terminal-output')).toBeUndefined();

    pm.signal(shellProc!.pid, 'SIGCONT');
    const result = await execP;
    expect(result.stdout).toBe('hello\n');
    expect(events.some((e) => e.type === 'terminal-output')).toBe(true);

    client.close();
    stopHost();
    channel.port1.close();
    channel.port2.close();
  });

  it('SIGINT after SIGSTOP releases the gate and exits 130', async () => {
    const channel = new MessageChannel();
    const pm = new ProcessManager();
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
    const shell = makeStubShell();
    shell.executeCommand.mockImplementation(async (_cmd, signal) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 200);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      return { stdout: 'late\n', stderr: '', exitCode: 0 };
    });
    const host = new TerminalSessionHost({
      transport: bridgeTransport,
      createShell: () => shell,
      processManager: pm,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const stopHost = host.start();
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const panelClient = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );
    const client = new TerminalSessionClient({ client: panelClient, sid: 'si' });

    await client.open();
    const execP = client.exec('cmd');
    await tick(20);
    const proc = pm.list().find((p) => p.kind === 'shell')!;
    pm.signal(proc.pid, 'SIGSTOP');
    await tick(20);
    pm.signal(proc.pid, 'SIGINT');
    const result = await execP;
    expect(result.exitCode).toBe(130);
    expect(proc.terminatedBy).toBe('SIGINT');

    client.close();
    stopHost();
    channel.port1.close();
    channel.port2.close();
  });

  it('falls back to local AbortController without a ProcessManager', async () => {
    const ctx = setupChannel();
    await ctx.client.open();
    await ctx.client.exec('ls');

    ctx.dispose();
  });

  it('two execs in sequence round-trip independently (matched by execId)', async () => {
    const ctx = setupChannel();
    ctx.shell.executeCommand
      .mockResolvedValueOnce({ stdout: 'a', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'b', stderr: '', exitCode: 1 });
    await ctx.client.open();
    const r1 = await ctx.client.exec('echo a');
    const r2 = await ctx.client.exec('echo b');
    expect(r1.stdout).toBe('a');
    expect(r1.exitCode).toBe(0);
    expect(r2.stdout).toBe('b');
    expect(r2.exitCode).toBe(1);
    ctx.dispose();
  });

  it('host stamps execId on every terminal-output envelope', async () => {
    const ctx = setupChannel();
    ctx.shell.executeCommand.mockResolvedValue({
      stdout: 'hi',
      stderr: 'oops',
      exitCode: 0,
    });
    await ctx.client.open();
    await ctx.client.exec('echo hi');
    const outs = ctx.events.filter((e) => e.type === 'terminal-output');
    expect(outs.length).toBeGreaterThanOrEqual(2);
    for (const evt of outs) {
      const out = evt as { execId?: string };
      expect(typeof out.execId).toBe('string');
    }
    ctx.dispose();
  });

  it('legacy host without execId broadcasts to every in-flight buffer', async () => {
    const channel = new MessageChannel();
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const panelClient = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );
    const client = new TerminalSessionClient({ client: panelClient, sid: 'leg' });

    channel.port2.start();
    const send = (envelope: unknown): void => {
      channel.port2.postMessage({ source: 'offscreen', payload: envelope });
    };

    send({ type: 'terminal-status', sid: 'leg', state: 'opened' });
    await client.open();

    const execP = client.exec('whatever');
    await tick(5);
    send({ type: 'terminal-output', sid: 'leg', stream: 'stdout', data: 'legacy' });
    send({ type: 'terminal-exit', sid: 'leg', execId: 'e1', exitCode: 0 });
    const result = await execP;
    expect(result.stdout).toBe('legacy');

    client.close();
    channel.port1.close();
    channel.port2.close();
  });

  it('open retries until terminal-status: opened arrives (boot-race)', async () => {
    const channel = new MessageChannel();
    const shell = makeStubShell();
    const shellFactory = vi.fn(() => shell);
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const panelClient = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );
    const client = new TerminalSessionClient({ client: panelClient, sid: 'br' });

    const openP = client.open({ cwd: '/', retryMs: 20, timeoutMs: 2000 });

    await tick(50);

    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
    const host = new TerminalSessionHost({
      transport: bridgeTransport,
      createShell: shellFactory,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const stopHost = host.start();

    await openP;
    expect(shellFactory).toHaveBeenCalledWith('br', { cwd: '/', env: undefined });

    client.close();
    stopHost();
    channel.port1.close();
    channel.port2.close();
  });

  it('open rejects with timeout error when no host ever subscribes', async () => {
    const channel = new MessageChannel();
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const panelClient = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );
    const client = new TerminalSessionClient({ client: panelClient, sid: 'to' });

    await expect(client.open({ cwd: '/', retryMs: 10, timeoutMs: 50 })).rejects.toThrow(
      /timed out/
    );

    client.close();
    channel.port1.close();
    channel.port2.close();
  });

  it('close mid-open-retry rejects the pending open and stops retrying', async () => {
    const channel = new MessageChannel();
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const panelClient = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );
    const client = new TerminalSessionClient({ client: panelClient, sid: 'cm' });

    const openP = client.open({ cwd: '/', retryMs: 10, timeoutMs: 5000 });
    await tick(30);
    client.close();
    await expect(openP).rejects.toThrow(/closed/);

    channel.port1.close();
    channel.port2.close();
  });
});
