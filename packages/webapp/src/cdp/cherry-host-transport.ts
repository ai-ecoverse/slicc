import {
  type CDPPayload,
  TranscriptExportError,
  type TranscriptExportErrorCode,
  type TranscriptExportProgress,
  VALID_EXPORT_ERROR_CODES,
} from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import {
  acceptEnvelope,
  CHERRY_PROTOCOL_VERSION,
  type CherryEnvelope,
  type CherrySessionExportProgress,
  isCherryEnvelope,
  isCherryVersionMismatch,
  SUPPORTED_CHERRY_PROTOCOL_VERSIONS,
} from './cherry-host-protocol.js';
import { PendingRequestTable } from './pending-request-table.js';
import { SyntheticCdpTransport } from './synthetic-cdp-transport.js';
import type { CDPConnectOptions } from './types.js';

const log = createLogger('cherry-transport');

export interface CherryHostTransportOptions {
  counterpart: Window;

  allowOrigins: string[];

  targetOrigin: string;
  capabilities?: { navigate: boolean; screenshot: boolean; openUrl: boolean };
}

const DEFAULT_TIMEOUT = 30000;

interface RejectionWithExportCode {
  code?: unknown;
}

function exportErrorCodeFromRejection(err: unknown): TranscriptExportErrorCode {
  const maybeCode =
    err instanceof TranscriptExportError
      ? err.code
      : typeof err === 'object' && err !== null && 'code' in err
        ? (err as RejectionWithExportCode).code
        : undefined;

  if (
    typeof maybeCode === 'string' &&
    VALID_EXPORT_ERROR_CODES.has(maybeCode as TranscriptExportErrorCode)
  ) {
    return maybeCode as TranscriptExportErrorCode;
  }
  return 'transfer-corrupt';
}

export class CherryHostTransport extends SyntheticCdpTransport {
  private opts: CherryHostTransportOptions;
  private channelId: string | null = null;
  private nextId = 1;
  private pending = new PendingRequestTable<number>();
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private _joinUrl: string | null = null;
  private _features: {
    terminal: boolean;
    files: boolean;
    memory: boolean;
    browser: boolean;
    modelPicker: boolean;
    history: boolean;
    nav: boolean;
    monitor: boolean;
  } = {
    terminal: true,
    files: true,
    memory: true,
    browser: true,
    modelPicker: true,
    history: true,
    nav: true,
    monitor: true,
  };
  private _theme: string | null = null;
  private _layout: string | null = null;
  private _effortLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null = null;
  private _flags: string | null = null;

  private negotiatedVersion: number = CHERRY_PROTOCOL_VERSION;
  private boundHandler = (ev: MessageEvent) => this.handleMessage(ev);

  onHostEvent: ((name: string, detail?: unknown) => void) | null = null;

  onExportRequest:
    | ((
        requestId: string,
        sessionId: string | undefined,
        signal: AbortSignal,
        onProgress: (progress: TranscriptExportProgress) => void
      ) => Promise<Blob>)
    | null = null;

  private readonly pendingHostExports = new Map<string, AbortController>();

  constructor(opts: CherryHostTransportOptions) {
    super({
      targetUrl: typeof location !== 'undefined' ? location.href : 'about:blank',
      targetOrigin: opts.targetOrigin,
      title: 'Cherry Host Page',
      ids: {
        target: 'cherry-target',
        session: 'cherry-session',
        frame: 'cherry-frame',
        loader: 'cherry-loader',
      },
    });
    this.opts = opts;
  }

  get hostOrigin(): string {
    return this.opts.targetOrigin;
  }

  protected override getCurrentUrl(): string {
    return typeof location !== 'undefined' ? location.href : super.getCurrentUrl();
  }

  get joinUrl(): string | null {
    return this._joinUrl;
  }

  get features(): {
    terminal: boolean;
    files: boolean;
    memory: boolean;
    browser: boolean;
    modelPicker: boolean;
    history: boolean;
    nav: boolean;
    monitor: boolean;
  } {
    return this._features;
  }

  get theme(): string | null {
    return this._theme;
  }

  get layout(): string | null {
    return this._layout;
  }

  get effortLevel(): 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null {
    return this._effortLevel;
  }

  get flags(): string | null {
    return this._flags;
  }

  get negotiatedProtocolVersion(): number {
    return this.negotiatedVersion;
  }

  async connect(options?: CDPConnectOptions): Promise<void> {
    if (this._state !== 'disconnected') {
      throw new Error(`Cannot connect: state is ${this._state}`);
    }
    this._state = 'connecting';
    this.negotiatedVersion = CHERRY_PROTOCOL_VERSION;
    this.channelId = `cherry-${crypto.randomUUID()}`;
    if (typeof window !== 'undefined') {
      window.addEventListener('message', this.boundHandler);
    }
    const timeoutMs = options?.timeout ?? DEFAULT_TIMEOUT;
    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (typeof window !== 'undefined') {
          window.removeEventListener('message', this.boundHandler);
        }
        this._state = 'disconnected';
        this.channelId = null;
        this.connectResolve = null;
        this.connectReject = null;
        reject(
          new Error(
            `Cherry handshake timed out after ${timeoutMs}ms — no handshake.welcome ` +
              `from the embedding page (host SDK missing, not listening, or ` +
              `version-skewed; check the host page's console)`
          )
        );
      }, timeoutMs);

      for (const version of SUPPORTED_CHERRY_PROTOCOL_VERSIONS) {
        this.post({
          cherry: version,
          channelId: this.channelId!,
          kind: 'handshake.hello',
          capabilities: this.opts.capabilities ?? {
            navigate: true,
            screenshot: true,
            openUrl: true,
          },
        });
      }
    });
  }

  private failPendingConnect(err: Error): void {
    if (this.connectReject === null) return;
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.boundHandler);
    }
    this._state = 'disconnected';
    this.channelId = null;
    const reject = this.connectReject;
    this.connectResolve = null;
    this.connectReject = null;
    reject(err);
  }

  disconnect(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.boundHandler);
    }
    this.pending.rejectAll('Cherry transport disconnected');

    for (const [, ctrl] of this.pendingHostExports) ctrl.abort();
    this.pendingHostExports.clear();
    this._state = 'disconnected';
    this.channelId = null;
  }

  protected async forward(
    method: string,
    params?: CDPPayload,
    _sessionId?: string,
    timeout = DEFAULT_TIMEOUT
  ): Promise<CDPPayload> {
    const id = this.nextId++;
    const response = this.pending.issue(
      id,
      timeout,
      `Cherry CDP timed out after ${timeout}ms: ${method}`
    );
    this.post({
      cherry: this.negotiatedVersion,
      channelId: this.channelId!,
      kind: 'cdp.request',
      id,
      method,
      params,
    });
    return response;
  }

  testReceive(event: MessageEvent): void {
    this.handleMessage(event);
  }

  emitSliccEventToHost(name: string, detail?: unknown): void {
    if (!this.channelId) {
      log.warn('Dropping slicc.event before handshake (no channelId yet)', { name });
      return;
    }
    this.post({
      cherry: this.negotiatedVersion,
      channelId: this.channelId,
      kind: 'slicc.event',
      name,
      detail,
    });
  }

  private post(env: CherryEnvelope): void {
    this.opts.counterpart.postMessage(env, this.opts.targetOrigin);
  }

  private handleMessage(event: MessageEvent): void {
    const versions =
      this._state === 'connected' ? [this.negotiatedVersion] : SUPPORTED_CHERRY_PROTOCOL_VERSIONS;
    if (
      !acceptEnvelope(event, {
        allowOrigins: this.opts.allowOrigins,
        expectedSource: this.opts.counterpart as unknown as MessageEventSource,
        channelId: this.channelId,
        versions,
      })
    ) {
      this.diagnoseRejectedMessage(event, versions);
      return;
    }
    const env = event.data as CherryEnvelope;

    if (this.negotiatedVersion < 2 && env.kind.startsWith('session.export.')) {
      log.warn('Ignoring a v2-only envelope on a v1-negotiated cherry channel', {
        kind: env.kind,
      });
      return;
    }
    switch (env.kind) {
      case 'handshake.welcome':
        this.handleWelcome(env);
        return;
      case 'cdp.response': {
        if (env.error)
          this.pending.reject(
            env.id,
            new Error(`Cherry CDP error: ${env.error.message} (${env.error.code})`)
          );
        else this.pending.resolve(env.id, env.result ?? {});
        return;
      }
      case 'cdp.event':
        this.emit(env.method, {
          ...(env.params ?? {}),
          sessionId: env.sessionId ?? this.syntheticIds.session,
        });
        return;
      case 'host.event':
        this.onHostEvent?.(env.name, env.detail);
        return;
      case 'session.export.request':
        this.handleExportRequest(env);
        return;
      case 'session.export.cancel': {
        const ctrl = this.pendingHostExports.get(env.requestId);
        if (ctrl) {
          ctrl.abort();
          this.pendingHostExports.delete(env.requestId);
        }
        return;
      }
      default:
        return;
    }
  }

  private diagnoseRejectedMessage(event: MessageEvent, versions: readonly number[]): void {
    if (isCherryVersionMismatch(event.data, versions)) {
      log.warn('Cherry protocol version mismatch — update the older side', {
        peerVersion: event.data.cherry,
        supportedVersions: [...SUPPORTED_CHERRY_PROTOCOL_VERSIONS],
        origin: event.origin,
      });

      const trustedPeer =
        event.data.channelId === this.channelId &&
        this.opts.allowOrigins.includes(event.origin) &&
        event.source === (this.opts.counterpart as unknown as MessageEventSource);
      if (trustedPeer) {
        this.failPendingConnect(
          new Error(
            `Cherry protocol version mismatch (peer v${event.data.cherry}, ` +
              `ours v${CHERRY_PROTOCOL_VERSION}) — update the older side`
          )
        );
      }
    } else if (isCherryEnvelope(event.data, SUPPORTED_CHERRY_PROTOCOL_VERSIONS)) {
      log.warn('Rejected a cherry envelope (origin/source/channel mismatch)', {
        origin: event.origin,
        allowOrigins: this.opts.allowOrigins,
      });
    }
  }

  private handleWelcome(env: Extract<CherryEnvelope, { kind: 'handshake.welcome' }>): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this._state = 'connected';
    this.negotiatedVersion = env.cherry;
    this._joinUrl = env.joinUrl ?? null;
    this._theme = env.theme ?? null;
    this._layout = env.layout ?? null;
    this._effortLevel = env.effortLevel ?? null;
    this._flags = env.flags ?? null;
    this._features = env.features ?? {
      terminal: true,
      files: true,
      memory: true,
      browser: true,
      modelPicker: true,
      history: true,
      nav: true,
      monitor: true,
    };
    log.info('Cherry handshake complete', {
      channelId: this.channelId,
      negotiatedVersion: this.negotiatedVersion,
    });
    this.connectResolve?.();
    this.connectResolve = null;
    this.connectReject = null;
  }

  private handleExportRequest(
    env: Extract<CherryEnvelope, { kind: 'session.export.request' }>
  ): void {
    const { requestId, sessionId } = env;
    if (!this.onExportRequest || !this.channelId) {
      this.postExportError(requestId, 'transfer-aborted');
      return;
    }
    const abort = new AbortController();
    this.pendingHostExports.set(requestId, abort);
    const channelId = this.channelId;
    const onProgress = (progress: TranscriptExportProgress): void => {
      if (!this.pendingHostExports.has(requestId)) return;
      this.post({
        cherry: this.negotiatedVersion,
        channelId,
        kind: 'session.export.progress',
        requestId,
        phase: progress.phase as CherrySessionExportProgress['phase'],
        ...(progress.processedBytes !== undefined
          ? { processedBytes: progress.processedBytes }
          : {}),
        ...(progress.estimatedBytes !== undefined
          ? { estimatedBytes: progress.estimatedBytes }
          : {}),
      });
    };
    this.onExportRequest(requestId, sessionId, abort.signal, onProgress)
      .then((blob) => {
        this.pendingHostExports.delete(requestId);
        this.post({
          cherry: this.negotiatedVersion,
          channelId,
          kind: 'session.export.response',
          requestId,
          blob,
        });
      })
      .catch((err: unknown) => {
        this.pendingHostExports.delete(requestId);
        this.postExportError(requestId, exportErrorCodeFromRejection(err));
      });
  }

  private postExportError(requestId: string, code: string): void {
    if (!this.channelId) return;
    this.post({
      cherry: this.negotiatedVersion,
      channelId: this.channelId,
      kind: 'session.export.error',
      requestId,
      code,
    });
  }
}
