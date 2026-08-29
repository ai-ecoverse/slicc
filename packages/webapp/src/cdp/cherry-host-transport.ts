/**
 * CherryHostTransport — `CDPTransport` implementation for the cherry
 * follower mode, alongside `CDPClient` (WebSocket / CLI) and
 * `ExtensionBridgeTransport` (thin extension `chrome.runtime` Port).
 *
 * Runs INSIDE the embedded SLICC follower iframe. Instead of a WebSocket or
 * chrome.debugger, it sends `cdp.request` envelopes to the host SDK
 * (`window.parent`) and resolves on `cdp.response`. It extends
 * `SyntheticCdpTransport` to inherit synthetic session lifecycle handling
 * and implements the postMessage backhaul.
 */

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
  /** The counterpart window (the host page = window.parent). */
  counterpart: Window;
  /** Allowlisted host origins. */
  allowOrigins: string[];
  /** Origin to target on postMessage (the host origin). */
  targetOrigin: string;
  capabilities?: { navigate: boolean; screenshot: boolean; openUrl: boolean };
}

const DEFAULT_TIMEOUT = 30000;

/** Wire rejection shape outside {@link TranscriptExportError} (e.g. abort handlers). */
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
  // Clamp to a canonical code even for TranscriptExportError instances: the
  // declared type is not a runtime guarantee (JS callers, unchecked casts, or
  // later mutation can carry a noncanonical `code`), so fall back to
  // 'transfer-corrupt' — the generic "something went wrong" sentinel.
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
    newSprinkle: boolean;
    monitor: boolean;
  } = {
    terminal: true,
    files: true,
    memory: true,
    browser: true,
    modelPicker: true,
    history: true,
    nav: true,
    newSprinkle: true,
    monitor: true,
  };
  private _theme: string | null = null;
  private _layout: string | null = null;
  private _effortLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null = null;
  private _flags: string | null = null;
  /**
   * Wire version negotiated with the host SDK. connect() posts one hello per
   * SUPPORTED_CHERRY_PROTOCOL_VERSIONS entry; the version of the welcome the
   * host answers with is pinned here and stamped on all subsequent outbound
   * envelopes (a vendored older SDK drops envelopes at any other version).
   */
  private negotiatedVersion: number = CHERRY_PROTOCOL_VERSION;
  private boundHandler = (ev: MessageEvent) => this.handleMessage(ev);

  /**
   * Invoked when the host SDK emits a `host.event` (host page → cone). The
   * cherry boot path wires this to forward the event to the leader over the
   * tray channel, where it surfaces as a `cherry` lick.
   */
  onHostEvent: ((name: string, detail?: unknown) => void) | null = null;

  /**
   * Invoked when the host SDK posts a `session.export.request` envelope.
   * The cherry boot path wires this to `FollowerSyncManager.requestTranscriptExport`.
   * The callback must return the verified application/zip Blob or reject with a
   * `TranscriptExportError`. Progress phases are forwarded via the supplied
   * `onProgress` helper without leaking filename, sha256, or byte size.
   */
  onExportRequest:
    | ((
        requestId: string,
        sessionId: string | undefined,
        signal: AbortSignal,
        onProgress: (progress: TranscriptExportProgress) => void
      ) => Promise<Blob>)
    | null = null;

  /** AbortControllers for in-flight host-initiated exports, keyed by requestId. */
  private readonly pendingHostExports = new Map<string, AbortController>();

  constructor(opts: CherryHostTransportOptions) {
    // Call super with injected metadata. Read the CONSTRUCTOR PARAMETER opts
    // (NOT this.opts; this is unavailable before super()).
    // Keep the typeof location guard for Node-based Vitest suite.
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

  /**
   * The embedding page's origin, as resolved once at boot by
   * `resolveParentOrigin()` (ancestorOrigins → referrer → same-origin) and used
   * as this transport's `postMessage` target.
   *
   * Exposed so consent UI can name the party that actually receives exported
   * bytes. Callers must not re-derive it from `location.ancestorOrigins`:
   * that API is non-standard and absent in Firefox, where Cherry still boots
   * via the referrer fallback — re-deriving would silently mislabel the
   * recipient at the consent boundary.
   */
  get hostOrigin(): string {
    return this.opts.targetOrigin;
  }

  /**
   * The host iframe's realm can soft-navigate (SPA route change / history
   * pushState) WITHOUT a CDP navigate, so report the live `location.href` rather
   * than the URL captured at construction — otherwise Target.getTargets /
   * Page.getFrameTree drift to the stale boot-time URL.
   */
  protected override getCurrentUrl(): string {
    return typeof location !== 'undefined' ? location.href : super.getCurrentUrl();
  }

  /**
   * The leader join URL the host SDK supplied in handshake.welcome, if any.
   * The cherry boot path reads this to start the follower against the same
   * leader the host provisioned.
   */
  get joinUrl(): string | null {
    return this._joinUrl;
  }

  /**
   * UI feature toggles received from the host SDK in handshake.welcome.
   * All features default to true for backward compatibility with older SDKs.
   */
  get features(): {
    terminal: boolean;
    files: boolean;
    memory: boolean;
    browser: boolean;
    modelPicker: boolean;
    history: boolean;
    nav: boolean;
    newSprinkle: boolean;
    monitor: boolean;
  } {
    return this._features;
  }

  /**
   * JSON-serialized SliccTheme from the host SDK's handshake.welcome.
   * Null when the host did not supply a theme.
   */
  get theme(): string | null {
    return this._theme;
  }

  /**
   * JSON-serialized `DockTreeSpec` from the host SDK's handshake.welcome.
   * Null when the host did not supply a layout.
   */
  get layout(): string | null {
    return this._layout;
  }

  /**
   * Locked effort level from the host SDK's handshake.welcome.
   * Null when the host did not supply one (UI picker remains visible).
   */
  get effortLevel(): 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null {
    return this._effortLevel;
  }

  /**
   * JSON-serialized feature-flag overrides from the host SDK's
   * handshake.welcome. Null when the host did not supply any.
   */
  get flags(): string | null {
    return this._flags;
  }

  /** The wire version negotiated at handshake (own version until connected). */
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
      // One hello per supported wire version, newest first, SAME channelId (a
      // host must not read the extra hellos as a reloaded-iframe re-handshake).
      // A host only answers the hello at its own version and warn-drops the
      // others, so a vendored older SDK still completes the handshake.
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

  /** Reject a pending connect() early (e.g. diagnosed version skew). No-op when not connecting. */
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
    // Abort any in-flight host-initiated exports so their Promises reject cleanly.
    for (const [, ctrl] of this.pendingHostExports) ctrl.abort();
    this.pendingHostExports.clear();
    this._state = 'disconnected';
    this.channelId = null;
  }

  /**
   * Forward non-synthetic methods via postMessage to the host SDK.
   */
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

  /** Test seam: inject a MessageEvent without a real window. */
  testReceive(event: MessageEvent): void {
    this.handleMessage(event);
  }

  /**
   * Push a `slicc.event` (cone → host page) out to the host SDK. This is the
   * iframe-side terminus of the `cherry-emit` outbound path: the leader sends a
   * `cherry.slicc_event` over the tray channel, the follower invokes this, and
   * the host SDK's `onSliccEvent` hook fires in `mountSlicc`.
   *
   * Drops the event before the handshake completes (no `channelId` to pin it to
   * the host's three-factor gate) rather than posting a malformed envelope.
   */
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

  // ---------------------------------------------------------------------------

  private post(env: CherryEnvelope): void {
    this.opts.counterpart.postMessage(env, this.opts.targetOrigin);
  }

  private handleMessage(event: MessageEvent): void {
    // While negotiating, accept any supported wire version; once connected,
    // narrow to the single version the welcome pinned.
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
    // v2-only envelope kinds must not be acted on over a v1-negotiated channel
    // (the host would silently drop our v2-shaped replies anyway).
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

  /**
   * Diagnose a message that failed the three-factor gate. A version-skewed
   * peer fails `isCherryEnvelope` itself — without a distinct log (and the
   * fast connect() rejection) the skew is indistinguishable from the 30s
   * handshake timeout.
   */
  private diagnoseRejectedMessage(event: MessageEvent, versions: readonly number[]): void {
    if (isCherryVersionMismatch(event.data, versions)) {
      log.warn('Cherry protocol version mismatch — update the older side', {
        peerVersion: event.data.cherry,
        supportedVersions: [...SUPPORTED_CHERRY_PROTOCOL_VERSIONS],
        origin: event.origin,
      });
      // Fail the pending connect() immediately instead of eating the 30s
      // timeout — but ONLY when ALL THREE factors match: origin, source, AND
      // the channelId nonce. acceptEnvelope rejected on version before its
      // nonce check could run, so restore it here — without it any hostile
      // frame could kill the handshake, and a DELAYED mismatch reply from a
      // previous connect attempt (different channelId) would fail an
      // unrelated pending connect. The host's genuine reply echoes this
      // attempt's hello channelId, so the nonce always matches when it should.
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
      // A well-formed cherry envelope rejected by the gate signals a
      // misconfiguration (wrong host origin, source/channel mismatch) rather
      // than unrelated postMessage noise — log it so it doesn't surface only
      // as an opaque 30s connect timeout. Plain noise is filtered silently.
      log.warn('Rejected a cherry envelope (origin/source/channel mismatch)', {
        origin: event.origin,
        allowOrigins: this.opts.allowOrigins,
      });
    }
  }

  /** Complete the handshake: pin the negotiated wire version and host-supplied config. */
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
      newSprinkle: true,
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
      // Only post progress if the request is still live.
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
