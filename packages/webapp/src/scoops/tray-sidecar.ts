import type {
  AgentEvent,
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
  TraySyncCapabilities,
} from '@slicc/shared-ts';
import { base64ToUint8, TRAY_SYNC_PROTOCOL_VERSION } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { FollowerTrayRuntimeStatus } from './tray-follower-status.js';
import { getLeaderTrayRuntimeStatus } from './tray-leader.js';
import { TraySyncChannel } from './tray-sync-protocol.js';
import type {
  FollowerAutoReconnectHandle,
  FollowerTrayStatusSink,
  TrayDataChannelLike,
} from './tray-webrtc.js';
import { startFollowerWithAutoReconnect } from './tray-webrtc.js';

const log = createLogger('tray-sidecar');

export const SIDECAR_RUNTIME_TAG = 'slicc-sidecar';

export const MAX_SIDECAR_ATTACHMENTS = 8;

const MAX_RUN_UNITS = 4 * 1024 * 1024;

const SIDECAR_CAPABILITIES: TraySyncCapabilities = { exec: false };

export interface SidecarAttachmentInfo {
  name: string;
  joinUrl: string;
  trayId: string | null;
  state: FollowerTrayRuntimeStatus['state'];
  attachedAt: number;
  error: string | null;
}

export interface SidecarChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface SidecarRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;

  error?: string;

  truncated?: boolean;
}

export interface SidecarRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onChunk?: (chunk: SidecarChunk) => void;
}

export interface SidecarPromptOptions extends SidecarRunOptions {
  steer?: boolean;
}

export interface SidecarWatchOptions extends SidecarRunOptions {
  durationMs: number;

  scoopJid?: string;

  untilIdle?: boolean;
}

class RunBuffer {
  stdout = '';
  stderr = '';
  truncated = false;
  private units = 0;

  constructor(private readonly onChunk?: (chunk: SidecarChunk) => void) {}

  push(stream: 'stdout' | 'stderr', text: string): void {
    if (this.truncated || text.length === 0) return;
    this.units += text.length;
    if (this.units > MAX_RUN_UNITS) {
      this.truncated = true;
      return;
    }
    if (stream === 'stdout') this.stdout += text;
    else this.stderr += text;
    this.onChunk?.({ stream, text });
  }

  result(exitCode: number, error?: string): SidecarRunResult {
    return {
      stdout: this.truncated ? `${this.stdout}\n[output truncated at cap]` : this.stdout,
      stderr: this.stderr,
      exitCode,
      ...(error ? { error } : {}),
      ...(this.truncated ? { truncated: true } : {}),
    };
  }
}

class SidecarAttachment {
  private handle: FollowerAutoReconnectHandle | null = null;
  private channel: TraySyncChannel<FollowerToLeaderMessage, LeaderToFollowerMessage> | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<(message: LeaderToFollowerMessage) => void>();
  private readonly dropListeners = new Set<(reason: string) => void>();
  private status: FollowerTrayRuntimeStatus | null = null;
  readonly attachedAt = Date.now();
  private currentJoinUrl: string;

  private startPromise: Promise<void> | null = null;

  constructor(
    readonly name: string,
    joinUrl: string
  ) {
    this.currentJoinUrl = joinUrl;
  }

  private readonly statusSink: FollowerTrayStatusSink = {
    get: () =>
      this.status ?? {
        state: 'inactive',
        joinUrl: this.currentJoinUrl,
        trayId: null,
        error: null,
        lastPingTime: null,
        reconnectAttempts: 0,
        attachAttempts: 0,
        lastAttachCode: null,
        connectingSince: null,
        lastError: null,
      },
    set: (next) => {
      this.status = next;
    },
  };

  get info(): SidecarAttachmentInfo {
    const status = this.statusSink.get();
    return {
      name: this.name,
      joinUrl: this.currentJoinUrl,
      trayId: status.trayId,
      state: status.state,
      attachedAt: this.attachedAt,
      error: status.error,
    };
  }

  get connected(): boolean {
    return this.channel !== null && this.statusSink.get().state === 'connected';
  }

  get dead(): boolean {
    return this.statusSink.get().state === 'error';
  }

  async ready(): Promise<void> {
    await (this.startPromise ?? Promise.resolve());
  }

  async start(timeoutMs: number): Promise<void> {
    this.startPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.stop();
        reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s connecting to leader`));
      }, timeoutMs);

      this.handle = startFollowerWithAutoReconnect(
        {
          joinUrl: this.currentJoinUrl,
          runtime: SIDECAR_RUNTIME_TAG,
          statusSink: this.statusSink,
          onJoinUrlChanged: (next) => {
            this.currentJoinUrl = next;
          },
        },
        {
          onConnected: (connection) => {
            this.wire(connection.channel);
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          },
          onReconnecting: () => {
            this.notifyDropped('connection dropped; reconnecting');
          },
          onGaveUp: (lastError) => {
            this.notifyDropped(`reconnect gave up: ${lastError}`);
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.stop();
            reject(new Error(lastError));
          },
        }
      );
    });
    return await this.startPromise;
  }

  private wire(rawChannel: TrayDataChannelLike): void {
    const isReconnect = this.channel !== null;
    this.unsubscribe?.();
    const channel = new TraySyncChannel<FollowerToLeaderMessage, LeaderToFollowerMessage>(
      rawChannel
    );
    this.channel = channel;
    this.unsubscribe = channel.onMessage((message) => this.dispatch(message));
    channel.send({
      type: 'hello',
      protocolVersion: TRAY_SYNC_PROTOCOL_VERSION,
      runtime: SIDECAR_RUNTIME_TAG,
      capabilities: SIDECAR_CAPABILITIES,
    });
    log.info(isReconnect ? 'Sidecar reconnected' : 'Sidecar attached', { name: this.name });

    if (isReconnect) this.notifyDropped('reconnected mid-request; the reply was lost');
  }

  private dispatch(message: LeaderToFollowerMessage): void {
    if (message.type === 'ping') {
      this.channel?.send({ type: 'pong' });
      return;
    }
    if (message.type === 'pong') return;

    if (message.type === 'exec.request') {
      this.channel?.send({
        type: 'exec.response',
        requestId: message.requestId,
        exitCode: 127,
        error: 'slicc sidecar is a client-only attachment and does not accept exec',
      });
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(message);
      } catch (err) {
        log.error('Sidecar listener threw', {
          name: this.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  send(message: FollowerToLeaderMessage): boolean {
    return this.channel?.send(message) ?? false;
  }

  onMessage(listener: (message: LeaderToFollowerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDropped(listener: (reason: string) => void): () => void {
    this.dropListeners.add(listener);
    return () => this.dropListeners.delete(listener);
  }

  private notifyDropped(reason: string): void {
    for (const listener of [...this.dropListeners]) {
      try {
        listener(reason);
      } catch {}
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.channel?.close();
    this.channel = null;
    this.handle?.cancel();
    this.handle = null;
    this.notifyDropped('detached');
    this.listeners.clear();
    this.dropListeners.clear();
  }
}

export function parseSidecarJoinUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`join URL must be http(s): ${raw}`);
  }
  if (!url.pathname.includes('/join/')) {
    throw new Error(`not a tray join URL (expected .../join/<token>): ${raw}`);
  }
  return url;
}

export function isOwnTrayJoinUrl(url: URL): boolean {
  const own = getLeaderTrayRuntimeStatus().session?.joinUrl;
  if (!own) return false;
  try {
    const ownUrl = new URL(own);
    return ownUrl.origin === url.origin && ownUrl.pathname === url.pathname;
  } catch {
    return false;
  }
}

type VerbOutcome = 'complete' | 'abort' | 'expire' | 'dropped';

interface VerbControl {
  finish(exitCode: number, error?: string): void;
}

interface RunVerbOptions extends SidecarRunOptions {
  expireMs?: number;
}

function runVerb(
  attachment: SidecarAttachment,
  options: RunVerbOptions,
  buffer: RunBuffer,
  onMessage: (message: LeaderToFollowerMessage, control: VerbControl) => void
): Promise<{ result: SidecarRunResult; outcome: VerbOutcome }> {
  return new Promise((resolve) => {
    let settled = false;
    let offMessage: (() => void) | null = null;
    let offDropped: (() => void) | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;

    const settle = (outcome: VerbOutcome, exitCode: number, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      offMessage?.();
      offDropped?.();
      if (onAbort) options.signal?.removeEventListener('abort', onAbort);
      resolve({ result: buffer.result(exitCode, error), outcome });
    };

    const control: VerbControl = {
      finish: (exitCode, error) => settle('complete', exitCode, error),
    };

    offMessage = attachment.onMessage((message) => onMessage(message, control));
    offDropped = attachment.onDropped((reason) =>
      settle('dropped', 1, `connection lost: ${reason}`)
    );

    if (options.timeoutMs !== undefined) {
      const seconds = Math.round(options.timeoutMs / 1000);

      timeoutTimer = setTimeout(
        () => settle('abort', 124, `timed out after ${seconds}s`),
        options.timeoutMs
      );
    }
    if (options.expireMs !== undefined) {
      expiryTimer = setTimeout(() => settle('expire', 0), options.expireMs);
    }

    if (options.signal) {
      if (options.signal.aborted) {
        settle('abort', 130, 'interrupted');
        return;
      }
      onAbort = () => settle('abort', 130, 'interrupted');
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function promptRejectedReason(error: string | undefined): string {
  const reason = error?.trim();
  return reason ? `the leader rejected the prompt: ${reason}` : 'the leader rejected the prompt';
}

function handlePromptFrame(
  message: LeaderToFollowerMessage,
  messageId: string,
  buffer: RunBuffer,
  state: { sawProcessing: boolean },
  control: VerbControl
): void {
  if (message.type === 'user_message_ack') {
    if (message.messageId !== messageId) return;
    if (message.state === 'rejected') {
      buffer.push('stderr', `${promptRejectedReason(message.error)}\n`);
      control.finish(1);
    }

    return;
  }
  if (message.type === 'agent_event') {
    const event = message.event;
    if (event.type === 'content_delta') buffer.push('stdout', event.text);
    else if (event.type === 'turn_end') control.finish(0);
    else if (event.type === 'error') {
      buffer.push('stderr', `${event.error}\n`);
      control.finish(1);
    }
    return;
  }
  if (message.type === 'status') {
    if (message.scoopStatus === 'processing') state.sawProcessing = true;
    else if (state.sawProcessing) control.finish(0);
    return;
  }
  if (message.type === 'error') {
    buffer.push('stderr', `${message.error}\n`);
    control.finish(1);
  }
}

export class SidecarRegistry {
  private readonly attachments = new Map<string, SidecarAttachment>();
  private counter = 0;

  list(): SidecarAttachmentInfo[] {
    return [...this.attachments.values()].map((a) => a.info);
  }

  async attach(opts: {
    joinUrl: string;
    name?: string;
    connectTimeoutMs?: number;
  }): Promise<SidecarAttachmentInfo> {
    const url = parseSidecarJoinUrl(opts.joinUrl);
    if (isOwnTrayJoinUrl(url)) {
      throw new Error(
        "refusing to attach to this instance's own tray — that would deadlock the leader thread"
      );
    }
    const existing = this.findByJoinUrl(url);
    if (existing?.dead) {
      log.info('Replacing a dead sidecar attachment', { name: existing.name });
      this.detach(existing.name);
    } else if (existing) {
      await existing.ready();

      if (!existing.dead) return existing.info;
      this.detach(existing.name);
    }
    if (this.attachments.size >= MAX_SIDECAR_ATTACHMENTS) {
      throw new Error(
        `too many sidecar attachments (${MAX_SIDECAR_ATTACHMENTS}); detach one first`
      );
    }
    const name = opts.name ?? `slicc-${++this.counter}`;
    if (this.attachments.has(name)) throw new Error(`attachment '${name}' already exists`);

    const attachment = new SidecarAttachment(name, url.toString());
    this.attachments.set(name, attachment);
    try {
      await attachment.start(opts.connectTimeoutMs ?? 30_000);
    } catch (err) {
      this.attachments.delete(name);
      throw err;
    }
    return attachment.info;
  }

  detach(name: string): boolean {
    const attachment = this.attachments.get(name);
    if (!attachment) return false;
    attachment.stop();
    this.attachments.delete(name);
    return true;
  }

  detachAll(): void {
    for (const name of [...this.attachments.keys()]) this.detach(name);
  }

  private findByJoinUrl(url: URL): SidecarAttachment | undefined {
    const key = `${url.origin}${url.pathname}`;
    return [...this.attachments.values()].find((a) => {
      try {
        const existing = new URL(a.info.joinUrl);
        return `${existing.origin}${existing.pathname}` === key;
      } catch {
        return false;
      }
    });
  }

  private require(name: string): SidecarAttachment {
    const attachment = this.attachments.get(name);
    if (!attachment) throw new Error(`no such attachment: ${name}`);
    if (!attachment.connected) throw new Error(`attachment '${name}' is not connected`);
    return attachment;
  }

  async prompt(
    name: string,
    text: string,
    options: SidecarPromptOptions = {}
  ): Promise<SidecarRunResult> {
    const attachment = this.require(name);
    const buffer = new RunBuffer(options.onChunk);
    const state = { sawProcessing: false };
    const messageId = crypto.randomUUID();

    const run = runVerb(attachment, options, buffer, (message, control) => {
      handlePromptFrame(message, messageId, buffer, state, control);
    });

    const sent = attachment.send({
      type: 'user_message',
      text,
      messageId,
      ...(options.steer ? { steer: true } : {}),
    });
    if (!sent) return { stdout: '', stderr: '', exitCode: 1, error: 'failed to send user_message' };

    const { result, outcome } = await run;

    if (outcome === 'abort') attachment.send({ type: 'abort' });
    return result;
  }

  async exec(
    name: string,
    command: string,
    options: SidecarRunOptions & { cwd?: string; env?: Record<string, string>; stdin?: string } = {}
  ): Promise<SidecarRunResult> {
    const attachment = this.require(name);
    const requestId = crypto.randomUUID();
    const buffer = new RunBuffer(options.onChunk);

    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();

    const run = runVerb(attachment, options, buffer, (message, control) => {
      if (message.type === 'exec.chunk' && message.requestId === requestId) {
        let bytes: Uint8Array;
        try {
          bytes = base64ToUint8(message.data);
        } catch {
          return;
        }
        const decoder = message.stream === 'stdout' ? stdoutDecoder : stderrDecoder;
        buffer.push(message.stream, decoder.decode(bytes, { stream: true }));
        return;
      }
      if (message.type === 'exec.response' && message.requestId === requestId) {
        buffer.push('stdout', stdoutDecoder.decode());
        buffer.push('stderr', stderrDecoder.decode());
        control.finish(message.exitCode, message.error);
      }
    });

    const sent = attachment.send({
      type: 'exec.request',
      requestId,
      command,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.stdin ? { stdin: options.stdin } : {}),
    });
    if (!sent) return { stdout: '', stderr: '', exitCode: 1, error: 'failed to send exec.request' };

    const { result, outcome } = await run;
    if (outcome === 'abort') {
      attachment.send({ type: 'exec.signal', requestId, signal: 'SIGINT' });
    }
    return result;
  }

  async watch(name: string, options: SidecarWatchOptions): Promise<SidecarRunResult> {
    const attachment = this.require(name);
    const buffer = new RunBuffer(options.onChunk);
    let sawProcessing = false;

    const { result } = await runVerb(
      attachment,

      { ...options, timeoutMs: undefined, expireMs: options.durationMs },
      buffer,
      (message, control) => {
        if (message.type === 'user_message_echo') {
          buffer.push('stdout', `\n> ${message.text}\n`);
          return;
        }
        if (message.type === 'agent_event') {
          if (options.scoopJid && message.scoopJid !== options.scoopJid) return;
          buffer.push('stdout', renderWatchEvent(message.event));
          return;
        }
        if (message.type === 'status') {
          if (options.scoopJid && message.scoopJid !== options.scoopJid) return;
          if (message.scoopStatus === 'processing') sawProcessing = true;
          else if (sawProcessing && options.untilIdle) control.finish(0);
          return;
        }
        if (message.type === 'error') buffer.push('stderr', `${message.error}\n`);
      }
    );
    return result;
  }
}

function renderWatchEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'content_delta':
      return event.text;
    case 'tool_use_start':
      return `\n[tool] ${event.toolName} ${compactArgs(event.toolInput)}\n`;
    case 'tool_result':
      return `[${event.isError ? 'tool-error' : 'tool-ok'}] ${truncateOneLine(event.result, 200)}\n`;
    case 'turn_end':
      return '\n';
    case 'error':
      return `[error] ${event.error}\n`;
    default:
      return '';
  }
}

function compactArgs(input: unknown): string {
  if (input === undefined || input === null) return '';
  try {
    return truncateOneLine(JSON.stringify(input), 120);
  } catch {
    return '';
  }
}

function truncateOneLine(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`;
}
