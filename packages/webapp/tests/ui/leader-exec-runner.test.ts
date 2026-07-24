import { describe, expect, it } from 'vitest';
import { runLeaderExecInShell } from '../../src/ui/leader-exec-runner.js';
import type { OffscreenClient } from '../../src/ui/offscreen-client.js';

interface TerminalEvent {
  type: string;
  sid: string;
  execId?: string;
  stream?: 'stdout' | 'stderr';
  data?: string;
  state?: string;
  exitCode?: number;
}

/**
 * Minimal OffscreenClient fake that drives the `TerminalSessionClient`
 * handshake: it acknowledges `terminal-open`, and on `terminal-exec` streams two
 * output blocks then exits (or, in signal mode, waits and exits on the signal).
 */
class FakeOffscreen {
  private handlers: Array<(e: TerminalEvent) => void> = [];
  readonly sentTypes: string[] = [];
  constructor(private readonly mode: 'auto' | 'signal') {}

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
      queueMicrotask(() => this.emit({ type: 'terminal-status', sid: msg.sid, state: 'opened' }));
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
    }
  }
  private lastExecSid = '';
  private lastExecId = '';
}

describe('runLeaderExecInShell', () => {
  it('streams stdout/stderr blocks and returns the exit code', async () => {
    const client = new FakeOffscreen('auto');
    const chunks: Array<[string, string]> = [];
    const res = await runLeaderExecInShell(client as unknown as OffscreenClient, {
      command: 'echo hi',
      signal: new AbortController().signal,
      onChunk: (stream, data) => chunks.push([stream, data]),
    });
    expect(res.exitCode).toBe(7);
    expect(chunks).toContainEqual(['stdout', 'hi\n']);
    expect(chunks).toContainEqual(['stderr', 'warn\n']);
  });

  it('forwards an abort to the session as a signal', async () => {
    const client = new FakeOffscreen('signal');
    const controller = new AbortController();
    const p = runLeaderExecInShell(client as unknown as OffscreenClient, {
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
  });
});
