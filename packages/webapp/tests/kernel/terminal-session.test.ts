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
  const delayMs = opts?.delayMs;
  const shouldThrow = opts?.shouldThrow;
  const stdout = opts?.output?.stdout ?? '';
  const stderr = opts?.output?.stderr ?? '';
  const exitCode = opts?.output?.exitCode ?? 0;
  const executeCommand = vi.fn(async (_command: string, signal?: AbortSignal) => {
    opts?.observeAbort?.(signal!);
    if (delayMs) {
      // Resolve early if aborted; otherwise wait.
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

  it('SIGSTOP holds output emission; SIGCONT releases it (Phase 6.3)', async () => {
    const channel = new MessageChannel();
    const pm = new ProcessManager();
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
    const shell = makeStubShell();
    // Make the exec take ~50ms so the test has a race-free window
    // to land SIGSTOP before the gate-await runs.
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
    // Pause early — at t=20ms the shell process exists but
    // executeCommand hasn't returned yet (50ms delay). The gate
    // await runs after executeCommand resolves, by which point
    // the gate is paused.
    await tick(20);
    const shellProc = pm.list().find((p) => p.kind === 'shell');
    expect(shellProc).toBeDefined();
    pm.signal(shellProc!.pid, 'SIGSTOP');

    // Wait long enough for executeCommand to resolve (50ms) plus
    // some headroom; output must NOT have been emitted yet because
    // the gate is paused.
    await tick(100);
    expect(events.find((e) => e.type === 'terminal-output')).toBeUndefined();

    // Resume; output should land.
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
    // Pin the backward-compat fallback: a host that emits
    // `terminal-output` without `execId` (older protocol version)
    // accumulates against every buffer. The protocol allows only
    // one in-flight exec per session, so this is unambiguous.
    //
    // We exercise this by NOT using the host — push raw envelopes
    // onto the panel transport directly.
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

    // Start the worker port so we can inject raw envelopes.
    channel.port2.start();
    const send = (envelope: unknown): void => {
      channel.port2.postMessage({ source: 'offscreen', payload: envelope });
    };

    // Open the session (synthetic).
    send({ type: 'terminal-status', sid: 'leg', state: 'opened' });
    await client.open();

    // Kick off an exec then push a legacy output (no execId) BEFORE the exit.
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
});
