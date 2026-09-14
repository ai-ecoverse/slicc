import { TerminalSessionClient } from '../kernel/terminal-session-client.js';
import type { TerminalSessionId } from '../shell/terminal-protocol.js';
import type { OffscreenClient } from './offscreen-client.js';

let sessionSeq = 0;

export interface LeaderExecInShellOptions {
  command: string;

  sessionId: string;
  cwd?: string;
  env?: Record<string, string>;

  stdin?: string;

  signal: AbortSignal;

  onChunk: (stream: 'stdout' | 'stderr', data: string) => void;
}

interface LeaderExecSession {
  session: TerminalSessionClient;
  opened: Promise<void>;
  onChunk?: LeaderExecInShellOptions['onChunk'];
  running: boolean;
}

export class LeaderExecSessionPool {
  private readonly sessions = new Map<string, LeaderExecSession>();

  constructor(private readonly client: OffscreenClient) {}

  async run(opts: LeaderExecInShellOptions): Promise<{ exitCode: number; error?: string }> {
    const entry = this.getOrCreate(opts);
    if (entry.running) {
      return { exitCode: 1, error: 'another terminal command is already running' };
    }
    entry.running = true;
    entry.onChunk = opts.onChunk;
    const onAbort = (): void => entry.session.signal('SIGINT');
    try {
      await entry.opened;
      opts.signal.addEventListener('abort', onAbort, { once: true });
      if (opts.signal.aborted) return { exitCode: 130 };
      const result = await entry.session.exec(opts.command, {
        cwd: opts.cwd,
        env: opts.env,
        stdin: opts.stdin,
        discardCapturedOutput: true,
      });
      return { exitCode: result.exitCode };
    } catch (err) {
      this.close(opts.sessionId);
      return { exitCode: 1, error: err instanceof Error ? err.message : String(err) };
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
      entry.onChunk = undefined;
      entry.running = false;
    }
  }

  close(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    entry.session.close();
    entry.session.dispose();
  }

  private getOrCreate(opts: LeaderExecInShellOptions): LeaderExecSession {
    const existing = this.sessions.get(opts.sessionId);
    if (existing) return existing;
    const sid: TerminalSessionId = `follower-exec-${++sessionSeq}-${Date.now()}`;
    const entry = {} as LeaderExecSession;
    entry.session = new TerminalSessionClient({
      client: this.client,
      sid,
      onEvent: (event) => {
        if (event.type === 'terminal-output') entry.onChunk?.(event.stream, event.data);
      },
    });
    entry.opened = entry.session.open({ cwd: opts.cwd, env: opts.env });
    entry.running = false;
    this.sessions.set(opts.sessionId, entry);
    return entry;
  }
}
