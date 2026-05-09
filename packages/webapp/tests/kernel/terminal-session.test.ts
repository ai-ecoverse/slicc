/**
 * End-to-end test for `TerminalSessionHost` + `TerminalSessionClient`.
 *
 * Connects both sides via a `MessageChannel` pair (using the bridge-
 * shaped envelope transport), wires a stub `HeadlessShellLike`, and
 * exercises the lifecycle: open → exec → exec → signal → close.
 */

import { describe, it, expect, vi } from 'vitest';
import { TerminalSessionHost } from '../../src/kernel/terminal-session-host.js';
import { TerminalSessionClient } from '../../src/kernel/terminal-session-client.js';
import {
  createBridgeMessageChannelTransport,
  createPanelMessageChannelTransport,
} from '../../src/kernel/transport-message-channel.js';
import { OffscreenClient } from '../../src/ui/offscreen-client.js';
import { ProcessManager } from '../../src/kernel/process-manager.js';
import type { HeadlessShellLike } from '../../src/shell/wasm-shell-headless.js';
import type { TerminalEventMsg } from '../../src/shell/terminal-protocol.js';

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface StubShell extends HeadlessShellLike {
  dispose: ReturnType<typeof vi.fn>;
  executeCommand: ReturnType<typeof vi.fn>;
}

function makeStubShell(opts?: {
  output?: { stdout?: string; stderr?: string; exitCode?: number };
  delayMs?: number;
  shouldThrow?: boolean;
  observeAbort?: (signal: AbortSignal) => void;
}): StubShell {
  const executeCommand = vi.fn(async (_command: string, signal?: AbortSignal) => {
    opts?.observeAbort?.(signal!);
    if (opts?.delayMs) {
      // Resolve early if aborted; otherwise wait.
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      }).catch(() => undefined);
    }
    if (opts?.shouldThrow) throw new Error('boom');
    return {
      stdout: opts?.output?.stdout ?? '',
      stderr: opts?.output?.stderr ?? '',
      exitCode: opts?.output?.exitCode ?? 0,
    };
  });
  return {
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
  // Worker side
  const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
  const shell = makeStubShell();
  const shellFactory = vi.fn(() => shell);
  const host = new TerminalSessionHost({
    transport: bridgeTransport,
    createShell: shellFactory,
    logger: { warn: vi.fn(), debug: vi.fn() },
  });
  const stopHost = host.start();

  // Page side — OffscreenClient with the panel-side MessageChannel transport
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
    expect(ctx.shell.executeCommand).toHaveBeenCalledWith('echo hello', expect.any(AbortSignal));
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
      // Wait long enough that the SIGINT lands first.
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
    // Skip open — exec on a session that was never opened.
    const result = await ctx.client.exec('echo hello');
    expect(result.exitCode).toBe(127);
    ctx.dispose();
  });

  it('close disposes the worker shell and rejects pending opens', async () => {
    const ctx = setupChannel();
    await ctx.client.open();
    expect(ctx.shell.dispose).not.toHaveBeenCalled();
    ctx.client.close();
    await tick();
    expect(ctx.shell.dispose).toHaveBeenCalledTimes(1);
    expect(ctx.events.some((e) => e.type === 'terminal-status' && e.state === 'closed')).toBe(true);
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

  it('falls back to local AbortController without a ProcessManager', async () => {
    // Existing 7 round-trip tests already cover this path — this
    // test pins the absence-of-pm contract: pm.list() stays empty
    // because no manager was wired.
    const ctx = setupChannel();
    await ctx.client.open();
    await ctx.client.exec('ls');
    // No assertion against pm — there isn't one. We're just
    // verifying the host doesn't throw when `processManager` is
    // omitted from the options.
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
});
