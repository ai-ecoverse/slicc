import type {
  TerminalClearedMsg,
  TerminalControlMsg,
  TerminalEventMsg,
  TerminalExitMsg,
  TerminalMediaPreviewMsg,
  TerminalOutputMsg,
  TerminalSessionId,
  TerminalStatusMsg,
} from '../shell/terminal-protocol.js';

export interface TerminalSessionClientOptions {
  client: TerminalSessionTransport;

  sid: TerminalSessionId;

  onEvent?: (event: TerminalEventMsg) => void;
}

export interface TerminalExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface TerminalExecOptions {
  cwd?: string;
  env?: Record<string, string>;

  discardCapturedOutput?: boolean;

  stdin?: string;
}

export interface TerminalSessionTransport {
  sendRaw(message: TerminalControlMsg): void;
  onTerminalEvent(handler: (event: TerminalEventMsg) => void): () => void;
}

export class TerminalSessionClient {
  private readonly client: TerminalSessionTransport;
  private readonly sid: TerminalSessionId;
  private readonly onEvent: ((event: TerminalEventMsg) => void) | null;
  private nextExecId = 1;
  private pending = new Map<string, (result: TerminalExecResult) => void>();

  private buffers = new Map<string, { stdout: string; stderr: string }>();

  private opened = false;
  private openWaiters: Array<(err?: Error) => void> = [];
  private unsubscribe: (() => void) | null = null;

  private openRetryTimer: ReturnType<typeof setInterval> | null = null;

  private openTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TerminalSessionClientOptions) {
    this.client = options.client;
    this.sid = options.sid;
    this.onEvent = options.onEvent ?? null;

    this.unsubscribe = this.subscribeToEvents();
  }

  open(
    opts: {
      cwd?: string;
      env?: Record<string, string>;

      retryMs?: number;

      timeoutMs?: number;
    } = {}
  ): Promise<void> {
    if (this.opened) return Promise.resolve();
    const retryMs = opts.retryMs ?? 500;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const envelope = {
      type: 'terminal-open' as const,
      sid: this.sid,
      cwd: opts.cwd,
      env: opts.env,
    };
    return new Promise((resolve, reject) => {
      this.openWaiters.push((err) => {
        this.clearOpenTimers();
        if (err) reject(err);
        else resolve();
      });
      this.send(envelope);

      this.openRetryTimer = setInterval(() => {
        if (this.opened || this.openWaiters.length === 0) {
          this.clearOpenTimers();
          return;
        }
        this.send(envelope);
      }, retryMs);

      this.openTimeoutTimer = setTimeout(() => {
        if (this.opened || this.openWaiters.length === 0) return;
        const err = new Error(`terminal-open timed out after ${timeoutMs}ms`);
        const waiters = this.openWaiters;
        this.openWaiters = [];
        this.clearOpenTimers();
        for (const waiter of waiters) waiter(err);
      }, timeoutMs);
    });
  }

  private clearOpenTimers(): void {
    if (this.openRetryTimer) {
      clearInterval(this.openRetryTimer);
      this.openRetryTimer = null;
    }
    if (this.openTimeoutTimer) {
      clearTimeout(this.openTimeoutTimer);
      this.openTimeoutTimer = null;
    }
  }

  exec(command: string, opts: TerminalExecOptions = {}): Promise<TerminalExecResult> {
    const execId = `e${this.nextExecId++}`;
    const { discardCapturedOutput = false, ...request } = opts;
    return new Promise((resolve) => {
      this.pending.set(execId, resolve);
      if (!discardCapturedOutput) this.buffers.set(execId, { stdout: '', stderr: '' });
      this.send({ type: 'terminal-exec', sid: this.sid, execId, command, ...request });
    });
  }

  signal(sig: 'SIGINT' | 'SIGTERM' | 'SIGSTOP' | 'SIGCONT' | 'SIGKILL'): void {
    this.send({ type: 'terminal-signal', sid: this.sid, signal: sig });
  }

  resize(cols: number, rows: number): void {
    this.send({ type: 'terminal-resize', sid: this.sid, cols, rows });
  }

  close(): void {
    const hadPendingOpen = this.openWaiters.length > 0;
    if (!this.opened && !hadPendingOpen) {
      this.clearOpenTimers();
      return;
    }

    if (this.opened || hadPendingOpen) this.send({ type: 'terminal-close', sid: this.sid });
    this.opened = false;

    const waiters = this.openWaiters;
    this.openWaiters = [];
    this.clearOpenTimers();
    for (const waiter of waiters) waiter(new Error('terminal session closed'));
    for (const [execId, resolve] of this.pending) {
      const buf = this.buffers.get(execId) ?? { stdout: '', stderr: '' };
      resolve({ stdout: buf.stdout, stderr: buf.stderr, exitCode: 130 });
    }
    this.pending.clear();
    this.buffers.clear();
  }

  dispose(): void {
    this.close();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private send(msg: TerminalControlMsg): void {
    this.client.sendRaw(msg);
  }

  private subscribeToEvents(): () => void {
    const handler = (event: TerminalEventMsg): void => {
      if (event.sid !== this.sid) return;
      this.handleEvent(event);
    };
    return this.client.onTerminalEvent(handler);
  }

  private handleEvent(event: TerminalEventMsg): void {
    this.onEvent?.(event);
    switch (event.type) {
      case 'terminal-status':
        this.handleStatusEvent(event as TerminalStatusMsg);
        return;
      case 'terminal-output':
        this.handleOutputEvent(event as TerminalOutputMsg);
        return;
      case 'terminal-exit':
        this.handleExitEvent(event as TerminalExitMsg);
        return;
      case 'terminal-cleared':
      case 'terminal-media-preview':
        return;
    }

    event satisfies never;
  }

  private handleStatusEvent(status: TerminalStatusMsg): void {
    if (status.state === 'opened') {
      this.opened = true;
      this.flushOpenWaiters();
    } else if (status.state === 'closed') {
      this.opened = false;
    } else if (status.state === 'error') {
      this.opened = false;
      this.flushOpenWaiters(new Error(status.error ?? 'terminal session error'));
    }
  }

  private flushOpenWaiters(err?: Error): void {
    const waiters = this.openWaiters;
    this.openWaiters = [];
    this.clearOpenTimers();
    for (const waiter of waiters) waiter(err);
  }

  private handleOutputEvent(out: TerminalOutputMsg): void {
    if (out.execId !== undefined) {
      const buf = this.buffers.get(out.execId);
      if (buf) appendOutputChunk(buf, out);
      return;
    }
    for (const buf of this.buffers.values()) appendOutputChunk(buf, out);
  }

  private handleExitEvent(exit: TerminalExitMsg): void {
    const resolve = this.pending.get(exit.execId);
    const buf = this.buffers.get(exit.execId);
    this.pending.delete(exit.execId);
    this.buffers.delete(exit.execId);
    if (resolve) {
      resolve({
        stdout: buf?.stdout ?? '',
        stderr: buf?.stderr ?? '',
        exitCode: exit.exitCode,
      });
    }
  }
}

function appendOutputChunk(buf: { stdout: string; stderr: string }, out: TerminalOutputMsg): void {
  if (out.stream === 'stdout') buf.stdout += out.data;
  else buf.stderr += out.data;
}

export type {
  TerminalClearedMsg,
  TerminalControlMsg,
  TerminalEventMsg,
  TerminalExitMsg,
  TerminalMediaPreviewMsg,
  TerminalOutputMsg,
  TerminalSessionId,
  TerminalStatusMsg,
};
