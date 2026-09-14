export type TerminalSessionId = string;

export interface TerminalOpenMsg {
  type: 'terminal-open';
  sid: TerminalSessionId;

  cwd?: string;

  env?: Record<string, string>;

  cols?: number;
  rows?: number;
}

export interface TerminalCloseMsg {
  type: 'terminal-close';
  sid: TerminalSessionId;
}

export interface TerminalStdinMsg {
  type: 'terminal-stdin';
  sid: TerminalSessionId;

  data: string;
}

export interface TerminalExecMsg {
  type: 'terminal-exec';
  sid: TerminalSessionId;

  execId: string;
  command: string;

  cwd?: string;

  env?: Record<string, string>;

  stdin?: string;
}

export interface TerminalSignalMsg {
  type: 'terminal-signal';
  sid: TerminalSessionId;
  signal: 'SIGINT' | 'SIGTERM' | 'SIGSTOP' | 'SIGCONT' | 'SIGKILL';
}

export interface TerminalResizeMsg {
  type: 'terminal-resize';
  sid: TerminalSessionId;
  cols: number;
  rows: number;
}

export type TerminalControlMsg =
  | TerminalOpenMsg
  | TerminalCloseMsg
  | TerminalStdinMsg
  | TerminalExecMsg
  | TerminalSignalMsg
  | TerminalResizeMsg;

export interface TerminalOutputMsg {
  type: 'terminal-output';
  sid: TerminalSessionId;

  execId?: string;

  stream: 'stdout' | 'stderr';

  data: string;
}

export interface TerminalMediaPreviewMsg {
  type: 'terminal-media-preview';
  sid: TerminalSessionId;

  path: string;
  mediaType: string;

  data: string;
}

export interface TerminalExitMsg {
  type: 'terminal-exit';
  sid: TerminalSessionId;
  execId: string;
  exitCode: number;
}

export interface TerminalClearedMsg {
  type: 'terminal-cleared';
  sid: TerminalSessionId;
}

export interface TerminalStatusMsg {
  type: 'terminal-status';
  sid: TerminalSessionId;
  state: 'opened' | 'closed' | 'error';
  error?: string;
}

export type TerminalEventMsg =
  | TerminalOutputMsg
  | TerminalMediaPreviewMsg
  | TerminalExitMsg
  | TerminalClearedMsg
  | TerminalStatusMsg;

export function isTerminalControlMsg(msg: unknown): msg is TerminalControlMsg {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as { type?: unknown }).type;
  return (
    t === 'terminal-open' ||
    t === 'terminal-close' ||
    t === 'terminal-stdin' ||
    t === 'terminal-exec' ||
    t === 'terminal-signal' ||
    t === 'terminal-resize'
  );
}

export function isTerminalEventMsg(msg: unknown): msg is TerminalEventMsg {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as { type?: unknown }).type;
  return (
    t === 'terminal-output' ||
    t === 'terminal-media-preview' ||
    t === 'terminal-exit' ||
    t === 'terminal-cleared' ||
    t === 'terminal-status'
  );
}
