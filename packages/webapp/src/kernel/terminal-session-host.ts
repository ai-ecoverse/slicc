import { base64ToUint8 } from '@slicc/shared-ts';
import type { ByteString } from 'just-bash';
import type {
  HeadlessShellLike,
  HeadlessShellOptions,
} from '../shell/almost-bash-shell-headless.js';
import { bytesToStdin, EMPTY_BYTES } from '../shell/just-bash-compat.js';
import type {
  TerminalCloseMsg,
  TerminalControlMsg,
  TerminalEventMsg,
  TerminalExecMsg,
  TerminalExitMsg,
  TerminalOpenMsg,
  TerminalOutputMsg,
  TerminalSessionId,
  TerminalSignalMsg,
  TerminalStatusMsg,
} from '../shell/terminal-protocol.js';
import type {
  ExtensionMessage,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
} from './messages.js';
import type { Process, ProcessManager, ProcessOwner, Signal } from './process-manager.js';
import type { KernelTransport } from './types.js';

export type TerminalShellFactory = (
  sid: TerminalSessionId,
  options: { cwd?: string; env?: Record<string, string> }
) => HeadlessShellLike & { dispose?: () => void };

export interface TerminalSessionHostOptions {
  transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>;

  createShell: TerminalShellFactory;

  processManager?: ProcessManager;

  defaultOwner?: ProcessOwner;

  logger?: {
    warn(msg: string, ...rest: unknown[]): void;
    debug?(msg: string, ...rest: unknown[]): void;
  };
}

interface Session {
  shell: HeadlessShellLike & { dispose?: () => void };

  currentExec: AbortController | null;

  currentProcess: Process | null;
}

export class TerminalSessionHost {
  private readonly transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>;
  private readonly createShell: TerminalShellFactory;
  private readonly log: NonNullable<TerminalSessionHostOptions['logger']>;
  private readonly pm: ProcessManager | null;
  private readonly defaultOwner: ProcessOwner;
  private readonly sessions = new Map<TerminalSessionId, Session>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: TerminalSessionHostOptions) {
    this.transport = options.transport;
    this.createShell = options.createShell;
    this.log = options.logger ?? console;
    this.pm = options.processManager ?? null;
    this.defaultOwner = options.defaultOwner ?? { kind: 'system' };
  }

  start(): () => void {
    if (this.unsubscribe) return () => this.dispose();
    this.unsubscribe = this.transport.onMessage((envelope) => {
      if (!isExtensionEnvelope(envelope)) return;
      if (envelope.source !== 'panel') return;
      const payload = envelope.payload as PanelToOffscreenMessage;
      if (!isTerminalControlMsg(payload)) return;
      void this.handleControl(payload).catch((err) => {
        this.log.warn('[terminal-session-host] handler error', err);
      });
    });
    return () => this.dispose();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [, session] of this.sessions) {
      if (session.currentProcess && this.pm) {
        this.pm.signal(session.currentProcess.pid, 'SIGTERM');
        this.pm.exit(session.currentProcess.pid, null);
      } else {
        session.currentExec?.abort();
      }
      session.shell.dispose?.();
    }
    this.sessions.clear();
  }

  private async handleControl(msg: TerminalControlMsg): Promise<void> {
    switch (msg.type) {
      case 'terminal-open':
        return this.handleOpen(msg);
      case 'terminal-close':
        return this.handleClose(msg);
      case 'terminal-exec':
        return this.handleExec(msg);
      case 'terminal-signal':
        return this.handleSignal(msg);
      case 'terminal-stdin':
      case 'terminal-resize':
        return;
    }
  }

  private async handleOpen(msg: TerminalOpenMsg): Promise<void> {
    if (this.sessions.has(msg.sid)) {
      this.emitStatus(msg.sid, 'error', 'session already open');
      return;
    }
    try {
      const shell = this.createShell(msg.sid, { cwd: msg.cwd, env: msg.env });
      this.sessions.set(msg.sid, { shell, currentExec: null, currentProcess: null });
      this.emitStatus(msg.sid, 'opened');
    } catch (err) {
      this.emitStatus(msg.sid, 'error', err instanceof Error ? err.message : String(err));
    }
  }

  private async handleClose(msg: TerminalCloseMsg): Promise<void> {
    const session = this.sessions.get(msg.sid);
    if (!session) return;
    if (session.currentProcess && this.pm) {
      this.pm.signal(session.currentProcess.pid, 'SIGTERM');
      this.pm.exit(session.currentProcess.pid, null);
    } else {
      session.currentExec?.abort();
    }
    session.shell.dispose?.();
    this.sessions.delete(msg.sid);
    this.emitStatus(msg.sid, 'closed');
  }

  private emitExit(msg: TerminalExecMsg, exitCode: number): void {
    this.emit({
      type: 'terminal-exit',
      sid: msg.sid,
      execId: msg.execId,
      exitCode,
    } satisfies TerminalExitMsg);
  }

  private emitStream(msg: TerminalExecMsg, stream: 'stdout' | 'stderr', data: string): void {
    this.emit({
      type: 'terminal-output',
      sid: msg.sid,
      execId: msg.execId,
      stream,
      data,
    } satisfies TerminalOutputMsg);
  }

  private async handleExec(msg: TerminalExecMsg): Promise<void> {
    const session = this.sessions.get(msg.sid);
    if (!session) {
      this.emitExit(msg, 127);
      this.log.warn('[terminal-session-host] exec on unknown session', msg.sid);
      return;
    }

    if (session.currentExec) {
      this.emitExit(msg, 130);
      return;
    }

    const abort = new AbortController();
    session.currentExec = abort;
    session.shell.applySessionOverrides?.({ cwd: msg.cwd, env: msg.env });
    const proc = this.pm
      ? this.pm.spawn({
          kind: 'shell',
          argv: [msg.command],
          cwd: session.shell.getCwd?.() ?? undefined,
          owner: this.defaultOwner,
          adoptAbort: abort,
        })
      : null;
    session.currentProcess = proc;
    try {
      let stdin: ByteString = EMPTY_BYTES;
      if (msg.stdin) {
        try {
          stdin = bytesToStdin(base64ToUint8(msg.stdin));
        } catch {
          this.emitExit(msg, 127);
          this.log.warn(
            '[terminal-session-host] exec with invalid stdin (expected base64)',
            msg.sid
          );
          return;
        }
      }
      const result = await session.shell.executeCommand(
        msg.command,
        abort.signal,
        proc?.pid,
        stdin
      );
      await this.emitExecSuccess(msg, result, abort, proc);
    } catch (err) {
      this.emitExecError(msg, err, abort, proc);
    } finally {
      if (session.currentExec === abort) {
        session.currentExec = null;
        session.currentProcess = null;
      }
    }
  }

  private async emitExecSuccess(
    msg: TerminalExecMsg,
    result: { stdout: string; stderr: string; exitCode: number },
    abort: AbortController,
    proc: Process | null
  ): Promise<void> {
    const exitCode = abort.signal.aborted
      ? signalExitCode(proc?.terminatedBy ?? 'SIGINT')
      : result.exitCode;
    if (!abort.signal.aborted) {
      if (proc) await proc.gate.wait();
      if (result.stdout) this.emitStream(msg, 'stdout', result.stdout);
      if (result.stderr) this.emitStream(msg, 'stderr', result.stderr);
    }
    this.emitExit(msg, exitCode);

    if (proc && this.pm) {
      this.pm.exit(proc.pid, abort.signal.aborted ? null : result.exitCode);
    }
  }

  private emitExecError(
    msg: TerminalExecMsg,
    err: unknown,
    abort: AbortController,
    proc: Process | null
  ): void {
    if (abort.signal.aborted) {
      this.emitExit(msg, signalExitCode(proc?.terminatedBy ?? 'SIGINT'));
      if (proc && this.pm) this.pm.exit(proc.pid, null);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.emitStream(msg, 'stderr', `Error: ${message}\n`);
    this.emitExit(msg, 1);
    if (proc && this.pm) this.pm.exit(proc.pid, 1);
  }

  private async handleSignal(msg: TerminalSignalMsg): Promise<void> {
    const session = this.sessions.get(msg.sid);
    if (!session) {
      this.log.warn('[terminal-session-host] signal on unknown session', msg.sid);
      return;
    }

    if (msg.signal === 'SIGINT' || msg.signal === 'SIGTERM' || msg.signal === 'SIGKILL') {
      if (session.currentProcess && this.pm) {
        this.pm.signal(session.currentProcess.pid, msg.signal);
      } else {
        session.currentExec?.abort();
      }
    }
  }

  private emit(event: TerminalEventMsg): void {
    this.transport.send(event as OffscreenToPanelMessage);
  }

  private emitStatus(
    sid: TerminalSessionId,
    state: 'opened' | 'closed' | 'error',
    error?: string
  ): void {
    const msg: TerminalStatusMsg = error
      ? { type: 'terminal-status', sid, state, error }
      : { type: 'terminal-status', sid, state };
    this.emit(msg);
  }
}

function isExtensionEnvelope(value: unknown): value is ExtensionMessage {
  return typeof value === 'object' && value !== null && 'source' in value && 'payload' in value;
}

function signalExitCode(sig: Signal): number {
  switch (sig) {
    case 'SIGINT':
      return 130;
    case 'SIGTERM':
      return 143;
    case 'SIGKILL':
      return 137;
    case 'SIGSTOP':
    case 'SIGCONT':
      return 130;
  }
}

function isTerminalControlMsg(payload: unknown): payload is TerminalControlMsg {
  if (typeof payload !== 'object' || payload === null) return false;
  const t = (payload as { type?: unknown }).type;
  return (
    t === 'terminal-open' ||
    t === 'terminal-close' ||
    t === 'terminal-exec' ||
    t === 'terminal-signal' ||
    t === 'terminal-stdin' ||
    t === 'terminal-resize'
  );
}

export function createAlmostBashShellTerminalFactory(
  buildShell: (
    cwd?: string,
    env?: Record<string, string>
  ) => HeadlessShellLike & {
    dispose?: () => void;
  }
): TerminalShellFactory {
  return (_sid, opts) => buildShell(opts.cwd, opts.env);
}

export type { HeadlessShellOptions };
