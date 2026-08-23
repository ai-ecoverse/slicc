/**
 * `leader-exec-runner.ts` — runs a CLI follower's `slicc … exec` command in the
 * leader's own (in-browser virtual) shell, streaming output blocks back as they
 * arrive.
 *
 * The leader tray's `LeaderSyncManager.execInShell` option is wired to this in
 * `wc-tray.ts`. It keeps one headless `TerminalSessionClient` per follower
 * connection against the kernel-worker's `TerminalSessionHost`, preserving cwd
 * and exported variables across submitted commands. Disconnect closes the
 * matching pooled session.
 *
 * KNOWN LIMITATION: `TerminalSessionHost` today `await`s the whole
 * `executeCommand` and emits stdout/stderr only after the command finishes
 * (`terminal-session-host.ts:23-27`). So for the `slicc … exec` direction (which
 * runs in the leader's virtual shell) a long-running command's output arrives at
 * completion, not incrementally — this surface is streaming-*shaped* but the
 * underlying shell is buffered. The `ssh` direction (a real OS on a Go follower)
 * DOES stream live. Piped stdin is forwarded bidirectionally on `exec.request`.
 * True incremental leader-shell output needs a streaming just-bash runtime and is
 * tracked as a follow-up.
 */

import { TerminalSessionClient } from '../kernel/terminal-session-client.js';
import type { TerminalSessionId } from '../shell/terminal-protocol.js';
import type { OffscreenClient } from './offscreen-client.js';

let sessionSeq = 0;

/** Options for a single leader-side shell exec on behalf of a CLI follower. */
export interface LeaderExecInShellOptions {
  command: string;
  /** Stable identifier for one follower connection. */
  sessionId: string;
  cwd?: string;
  env?: Record<string, string>;
  /** base64-encoded stdin bytes; omitted when nothing was piped. */
  stdin?: string;
  /** Aborting sends SIGINT to the running command. */
  signal: AbortSignal;
  /** Called with each streamed stdout/stderr block as it arrives. */
  onChunk: (stream: 'stdout' | 'stderr', data: string) => void;
}

interface LeaderExecSession {
  session: TerminalSessionClient;
  opened: Promise<void>;
  onChunk?: LeaderExecInShellOptions['onChunk'];
  running: boolean;
}

/** Owns the persistent virtual shells used by follower-originated exec requests. */
export class LeaderExecSessionPool {
  private readonly sessions = new Map<string, LeaderExecSession>();

  constructor(private readonly client: OffscreenClient) {}

  /** Run one command without closing the follower's shell afterward. */
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

  /** Close and forget one follower's shell, including any in-flight command. */
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
