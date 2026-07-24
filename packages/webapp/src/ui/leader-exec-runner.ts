/**
 * `leader-exec-runner.ts` — runs a CLI follower's `slicc … exec` command in the
 * leader's own (in-browser virtual) shell, streaming output blocks back as they
 * arrive.
 *
 * The leader tray's `LeaderSyncManager.execInShell` option is wired to this in
 * `wc-tray.ts`. It opens a short-lived headless `TerminalSessionClient` against
 * the kernel-worker's `TerminalSessionHost` — the same streaming surface the
 * panel terminals use — so a CLI `exec` gets the leader's real shell environment
 * (VFS, secrets, mounts). `onEvent` relays each `terminal-output` block live;
 * the resolved exit code closes the run.
 */

import { TerminalSessionClient } from '../kernel/terminal-session-client.js';
import type { TerminalSessionId } from '../shell/terminal-protocol.js';
import type { OffscreenClient } from './offscreen-client.js';

let execSeq = 0;

/** Options for a single leader-side shell exec on behalf of a CLI follower. */
export interface LeaderExecInShellOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Aborting sends SIGINT to the running command. */
  signal: AbortSignal;
  /** Called with each streamed stdout/stderr block as it arrives. */
  onChunk: (stream: 'stdout' | 'stderr', data: string) => void;
}

/**
 * Run `opts.command` in the leader's shell and resolve with the exit code.
 * Streams output through `opts.onChunk`. Never rejects — a failure to open the
 * session or run the command resolves with a non-zero exit and an `error`.
 */
export async function runLeaderExecInShell(
  client: OffscreenClient,
  opts: LeaderExecInShellOptions
): Promise<{ exitCode: number; error?: string }> {
  const sid: TerminalSessionId = `ssh-exec-${++execSeq}-${Date.now()}`;
  const session = new TerminalSessionClient({
    client,
    sid,
    onEvent: (event) => {
      if (event.type === 'terminal-output') opts.onChunk(event.stream, event.data);
    },
  });
  const onAbort = (): void => session.signal('SIGINT');
  try {
    await session.open({ cwd: opts.cwd, env: opts.env });
    if (opts.signal.aborted) session.signal('SIGINT');
    else opts.signal.addEventListener('abort', onAbort, { once: true });
    const result = await session.exec(opts.command);
    // stdout/stderr were already streamed via onEvent; only the exit matters.
    return { exitCode: result.exitCode };
  } catch (err) {
    return { exitCode: 1, error: err instanceof Error ? err.message : String(err) };
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    session.close();
    session.dispose();
  }
}
