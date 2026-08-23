import { describe, expect, it, vi } from 'vitest';
import { TerminalSessionClient } from '../../src/kernel/terminal-session-client.js';
import { LeaderExecSessionPool } from '../../src/ui/leader-exec-runner.js';
import type { OffscreenClient } from '../../src/ui/offscreen-client.js';

interface TerminalEvent {
  type: string;
  sid: string;
  execId?: string;
  stream?: 'stdout' | 'stderr';
  data?: string;
  state?: string;
  exitCode?: number;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Minimal OffscreenClient fake that drives the `TerminalSessionClient`
 * handshake: it acknowledges `terminal-open`, and on `terminal-exec` streams two
 * output blocks then exits (or, in signal mode, waits and exits on the signal).
 */
class FakeOffscreen {
  private handlers: Array<(e: TerminalEvent) => void> = [];
  readonly sentTypes: string[] = [];
  constructor(private readonly mode: 'auto' | 'signal' | 'stateful' | 'pending-open') {}

  onTerminalEvent(h: (e: TerminalEvent) => void): () => void {
    this.handlers.push(h);
    return () => {
      this.handlers = this.handlers.filter((x) => x !== h);
    };
  }
  private emit(e: TerminalEvent): void {
    for (const h of [...this.handlers]) h(e);
  }
  sendRaw(msg: TerminalEvent): void {
    this.sentTypes.push(msg.type);
    if (msg.type === 'terminal-open') {
      if (this.mode !== 'pending-open') {
        queueMicrotask(() => this.emit({ type: 'terminal-status', sid: msg.sid, state: 'opened' }));
      }
    } else if (msg.type === 'terminal-exec' && this.mode === 'auto') {
      queueMicrotask(() => {
        this.emit({
          type: 'terminal-output',
          sid: msg.sid,
          execId: msg.execId,
          stream: 'stdout',
          data: 'hi\n',
        });
        this.emit({
          type: 'terminal-output',
          sid: msg.sid,
          execId: msg.execId,
          stream: 'stderr',
          data: 'warn\n',
        });
        this.emit({ type: 'terminal-exit', sid: msg.sid, execId: msg.execId, exitCode: 7 });
      });
    } else if (msg.type === 'terminal-signal' && this.mode === 'signal') {
      // A prior terminal-exec is pending; end it now that we were signalled.
      queueMicrotask(() =>
        this.emit({
          type: 'terminal-exit',
          sid: this.lastExecSid,
          execId: this.lastExecId,
          exitCode: 130,
        })
      );
    } else if (msg.type === 'terminal-exec' && this.mode === 'signal') {
      this.lastExecSid = msg.sid;
      this.lastExecId = msg.execId ?? '';
    } else if (msg.type === 'terminal-exec' && this.mode === 'stateful') {
      const state = this.states.get(msg.sid) ?? { cwd: '/', env: new Map<string, string>() };
      if (msg.cwd !== undefined) state.cwd = msg.cwd;
      for (const [name, value] of Object.entries(msg.env ?? {})) state.env.set(name, value);
      let stdout = '';
      if (msg.command === 'cd /tmp') state.cwd = '/tmp';
      else if (msg.command === 'pwd') stdout = `${state.cwd}\n`;
      else if (msg.command === 'export NAME=value') state.env.set('NAME', 'value');
      else if (msg.command?.startsWith('echo $')) {
        stdout = `${state.env.get(msg.command.slice('echo $'.length)) ?? ''}\n`;
      }
      this.states.set(msg.sid, state);
      queueMicrotask(() => {
        if (stdout) {
          this.emit({
            type: 'terminal-output',
            sid: msg.sid,
            execId: msg.execId,
            stream: 'stdout',
            data: stdout,
          });
        }
        this.emit({ type: 'terminal-exit', sid: msg.sid, execId: msg.execId, exitCode: 0 });
      });
    }
  }
  private lastExecSid = '';
  private lastExecId = '';
  private readonly states = new Map<string, { cwd: string; env: Map<string, string> }>();
}

describe('LeaderExecSessionPool', () => {
  it('streams stdout/stderr blocks and returns the exit code', async () => {
    const execSpy = vi.spyOn(TerminalSessionClient.prototype, 'exec');
    const client = new FakeOffscreen('auto');
    const pool = new LeaderExecSessionPool(client as unknown as OffscreenClient);
    const chunks: Array<[string, string]> = [];
    const res = await pool.run({
      sessionId: 'follower-1',
      command: 'echo hi',
      signal: new AbortController().signal,
      onChunk: (stream, data) => chunks.push([stream, data]),
    });
    expect(res.exitCode).toBe(7);
    expect(chunks).toContainEqual(['stdout', 'hi\n']);
    expect(chunks).toContainEqual(['stderr', 'warn\n']);
    expect(execSpy).toHaveBeenCalledWith('echo hi', {
      cwd: undefined,
      env: undefined,
      stdin: undefined,
      discardCapturedOutput: true,
    });
    pool.close('follower-1');
    execSpy.mockRestore();
  });

  it('forwards base64 stdin to the terminal session exec', async () => {
    const execSpy = vi.spyOn(TerminalSessionClient.prototype, 'exec');
    const client = new FakeOffscreen('auto');
    const pool = new LeaderExecSessionPool(client as unknown as OffscreenClient);
    const stdin = Buffer.from('piped\n', 'utf-8').toString('base64');
    await pool.run({
      sessionId: 'follower-stdin',
      command: 'cat',
      stdin,
      signal: new AbortController().signal,
      onChunk: () => {},
    });
    expect(execSpy).toHaveBeenCalledWith('cat', expect.objectContaining({ stdin }));
    pool.close('follower-stdin');
    execSpy.mockRestore();
  });

  it('forwards an abort to the session as a signal', async () => {
    const client = new FakeOffscreen('signal');
    const pool = new LeaderExecSessionPool(client as unknown as OffscreenClient);
    const controller = new AbortController();
    const p = pool.run({
      sessionId: 'follower-2',
      command: 'sleep 30',
      signal: controller.signal,
      onChunk: () => {},
    });
    // Let the session open + start the exec, then interrupt.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const res = await p;
    expect(res.exitCode).toBe(130);
    expect(client.sentTypes).toContain('terminal-signal');
    pool.close('follower-2');
  });

  it('pairs a queued open with close when the follower disconnects during the handshake', async () => {
    const client = new FakeOffscreen('pending-open');
    const pool = new LeaderExecSessionPool(client as unknown as OffscreenClient);
    const runP = pool.run({
      sessionId: 'opening-follower',
      command: 'pwd',
      signal: new AbortController().signal,
      onChunk: () => {},
    });

    pool.close('opening-follower');

    await expect(runP).resolves.toMatchObject({ exitCode: 1, error: 'terminal session closed' });
    expect(client.sentTypes).toEqual(['terminal-open', 'terminal-close']);
  });

  it('preserves cwd and exported variables across sequential follower commands', async () => {
    const client = new FakeOffscreen('stateful');
    const pool = new LeaderExecSessionPool(client as unknown as OffscreenClient);
    const stdout: string[] = [];
    const run = (command: string, overrides: { cwd?: string; env?: Record<string, string> } = {}) =>
      pool.run({
        sessionId: 'ios-follower',
        command,
        ...overrides,
        signal: new AbortController().signal,
        onChunk: (stream, data) => {
          if (stream === 'stdout') stdout.push(data);
        },
      });

    await run('cd /tmp');
    await run('pwd');
    await run('export NAME=value');
    await run('echo $NAME');
    await run('pwd', { cwd: '/workspace' });
    await run('echo $COLUMNS', { env: { COLUMNS: '120', LINES: '40' } });
    await run('echo $LINES');

    expect(stdout).toEqual(['/tmp\n', 'value\n', '/workspace\n', '120\n', '40\n']);
    expect(client.sentTypes.filter((type) => type === 'terminal-open')).toHaveLength(1);
    pool.close('ios-follower');
    expect(client.sentTypes.filter((type) => type === 'terminal-close')).toHaveLength(1);
  });
});
