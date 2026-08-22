import { base64ToUint8, uint8ToBase64 } from '@slicc/shared-ts';
import type {
  TrayExecChunkMessage,
  TrayExecRequestMessage,
  TrayExecResponseMessage,
  TrayExecSignalMessage,
} from '../tray-sync-protocol.js';
import type { LeaderSyncContext } from './context.js';

/** Buffered result of a remote command executed on a follower (the `ssh` command). */
export interface RemoteExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set when the follower could not run the command at all. */
  error?: string;
}

/** Tracks a leader-initiated remote exec awaiting the follower's streamed reply. */
interface PendingRemoteExec {
  bootstrapId: string;
  stdout: string;
  stderr: string;
  /** Per-stream decoders preserve multibyte UTF-8 characters split across chunks. */
  stdoutDecoder: TextDecoder;
  stderrDecoder: TextDecoder;
  /** Total bytes buffered so far (memory-cap guard). */
  bytes: number;
  /** True once output was truncated at the byte cap. */
  truncated: boolean;
  onChunk?: (stream: 'stdout' | 'stderr', data: string) => void;
  resolve: (result: RemoteExecResult) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Cap one remote command's buffered output so it cannot exhaust page memory. */
const MAX_REMOTE_EXEC_BYTES = 16 * 1024 * 1024;

export class RemoteExecRouter {
  /** Leader-initiated remote execs awaiting a follower reply, keyed by requestId. */
  private readonly pendingRemoteExecs = new Map<string, PendingRemoteExec>();
  /** Follower-initiated local execs, keyed by `${bootstrapId}:${requestId}`. */
  private readonly localExecAborters = new Map<
    string,
    { bootstrapId: string; controller: AbortController }
  >();

  constructor(private readonly context: LeaderSyncContext) {
    context.followers.onFollowerRemoved({
      beforeRegistryCleanup: (bootstrapId) => this.handleFollowerRemoved(bootstrapId),
    });
  }

  /** Run a command on a connected follower and buffer its streamed result. */
  async execOnRemote(
    runtimeId: string,
    command: string,
    opts: {
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      signal?: AbortSignal;
      onChunk?: (stream: 'stdout' | 'stderr', data: string) => void;
      timeoutMs?: number;
    } = {}
  ): Promise<RemoteExecResult> {
    const resolved = this.context.followers.resolveFollowerByRuntimeId(runtimeId);
    if (!resolved) throw new Error(`No connected follower for '${runtimeId}'`);
    const { bootstrapId, follower } = resolved;
    if (!follower.peerCapabilities?.exec) {
      throw new Error(
        `Follower '${runtimeId}' is not an exec target — only a 'slicc … follow' CLI accepts commands`
      );
    }
    const requestId = `lexec-${crypto.randomUUID()}`;
    return new Promise<RemoteExecResult>((resolve, reject) => {
      const pending: PendingRemoteExec = {
        bootstrapId,
        stdout: '',
        stderr: '',
        stdoutDecoder: new TextDecoder('utf-8'),
        stderrDecoder: new TextDecoder('utf-8'),
        bytes: 0,
        truncated: false,
        onChunk: opts.onChunk,
        resolve,
        reject,
      };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.pendingRemoteExecs.delete(requestId)) return;
          this.sendExecSignal(bootstrapId, requestId, 'SIGKILL');
          reject(new Error(`exec on '${runtimeId}' timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
      this.pendingRemoteExecs.set(requestId, pending);

      if (opts.signal) {
        const onAbort = (): void => this.sendExecSignal(bootstrapId, requestId, 'SIGINT');
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      const sent = follower.sync.send({
        type: 'exec.request',
        requestId,
        command,
        cwd: opts.cwd,
        env: opts.env,
        stdin: opts.stdin,
      });
      if (!sent) {
        this.pendingRemoteExecs.delete(requestId);
        if (pending.timer) clearTimeout(pending.timer);
        reject(new Error(`Failed to send exec.request to follower '${runtimeId}'`));
      }
    });
  }

  /** Route all four exec wire messages in either direction. */
  handleFollowerExecMessage(
    bootstrapId: string,
    message:
      | TrayExecRequestMessage
      | TrayExecChunkMessage
      | TrayExecResponseMessage
      | TrayExecSignalMessage
  ): void {
    switch (message.type) {
      case 'exec.request':
        void this.handleFollowerExecRequest(bootstrapId, message);
        break;
      case 'exec.chunk':
        this.handleRemoteExecChunk(bootstrapId, message);
        break;
      case 'exec.response':
        this.handleRemoteExecResponse(bootstrapId, message);
        break;
      case 'exec.signal':
        this.handleFollowerExecSignal(bootstrapId, message);
        break;
    }
  }

  /** Send a signal to the follower running a leader-initiated exec. */
  private sendExecSignal(
    bootstrapId: string,
    requestId: string,
    signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'
  ): void {
    this.context.followers.followers
      .get(bootstrapId)
      ?.sync.send({ type: 'exec.signal', requestId, signal });
  }

  /** Accumulate and forward a streamed output block from a remote exec. */
  private handleRemoteExecChunk(bootstrapId: string, message: TrayExecChunkMessage): void {
    const pending = this.pendingRemoteExecs.get(message.requestId);
    if (!pending || pending.bootstrapId !== bootstrapId) return;
    let bytes: Uint8Array;
    try {
      bytes = base64ToUint8(message.data);
    } catch {
      return;
    }
    if (pending.truncated) return;
    pending.bytes += bytes.length;
    if (pending.bytes > MAX_REMOTE_EXEC_BYTES) pending.truncated = true;
    const decoder = message.stream === 'stdout' ? pending.stdoutDecoder : pending.stderrDecoder;
    const text = decoder.decode(bytes, { stream: true });
    if (message.stream === 'stdout') pending.stdout += text;
    else pending.stderr += text;
    pending.onChunk?.(message.stream, text);
  }

  /** Resolve a leader-initiated exec on its terminal response. */
  private handleRemoteExecResponse(bootstrapId: string, message: TrayExecResponseMessage): void {
    const pending = this.pendingRemoteExecs.get(message.requestId);
    if (!pending || pending.bootstrapId !== bootstrapId) return;
    this.pendingRemoteExecs.delete(message.requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.stdout += pending.stdoutDecoder.decode();
    pending.stderr += pending.stderrDecoder.decode();
    pending.resolve({
      stdout: pending.truncated ? `${pending.stdout}\n[output truncated at cap]` : pending.stdout,
      stderr: pending.stderr,
      exitCode: message.exitCode,
      error: message.error,
    });
  }

  /** Run a follower's command in the leader shell and stream its result back. */
  private async handleFollowerExecRequest(
    bootstrapId: string,
    message: TrayExecRequestMessage
  ): Promise<void> {
    const { requestId, command, cwd, env } = message;
    const execInShell = this.context.options.execInShell;
    if (!execInShell) {
      this.context.followers.followers.get(bootstrapId)?.sync.send({
        type: 'exec.response',
        requestId,
        exitCode: 127,
        error: 'exec is not supported on this leader',
      });
      return;
    }
    const controller = new AbortController();
    const abortKey = `${bootstrapId}:${requestId}`;
    this.localExecAborters.set(abortKey, { bootstrapId, controller });
    try {
      const result = await execInShell(command, {
        sessionId: bootstrapId,
        cwd,
        env,
        signal: controller.signal,
        onChunk: (stream, data) => {
          this.context.followers.followers.get(bootstrapId)?.sync.send({
            type: 'exec.chunk',
            requestId,
            stream,
            data: uint8ToBase64(new TextEncoder().encode(data)),
          });
        },
      });
      this.context.followers.followers.get(bootstrapId)?.sync.send({
        type: 'exec.response',
        requestId,
        exitCode: result.exitCode,
        error: result.error,
      });
    } catch (err) {
      this.context.followers.followers.get(bootstrapId)?.sync.send({
        type: 'exec.response',
        requestId,
        exitCode: 1,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.localExecAborters.delete(abortKey);
    }
  }

  /** Abort a local exec when its originating follower sends a signal. */
  private handleFollowerExecSignal(bootstrapId: string, message: TrayExecSignalMessage): void {
    this.localExecAborters.get(`${bootstrapId}:${message.requestId}`)?.controller.abort();
  }

  private handleFollowerRemoved(bootstrapId: string): void {
    for (const [requestId, pending] of this.pendingRemoteExecs) {
      if (pending.bootstrapId !== bootstrapId) continue;
      this.pendingRemoteExecs.delete(requestId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('follower disconnected before the command completed'));
    }
    for (const [requestId, entry] of this.localExecAborters) {
      if (entry.bootstrapId !== bootstrapId) continue;
      entry.controller.abort();
      this.localExecAborters.delete(requestId);
    }
    this.context.options.closeExecShell?.(bootstrapId);
  }
}
