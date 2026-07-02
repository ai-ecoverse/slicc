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

import { createLogger } from '../core/logger.js';
import {
  acceptEnvelope,
  CHERRY_PROTOCOL_VERSION,
  type CherryEnvelope,
  isCherryEnvelope,
} from './cherry-host-protocol.js';
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

export class CherryHostTransport extends SyntheticCdpTransport {
  private opts: CherryHostTransportOptions;
  private channelId: string | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private connectResolve: (() => void) | null = null;
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
  private boundHandler = (ev: MessageEvent) => this.handleMessage(ev);

  /**
   * Invoked when the host SDK emits a `host.event` (host page → cone). The
   * cherry boot path wires this to forward the event to the leader over the
   * tray channel, where it surfaces as a `cherry` lick.
   */
  onHostEvent: ((name: string, detail?: unknown) => void) | null = null;

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

  async connect(options?: CDPConnectOptions): Promise<void> {
    if (this._state !== 'disconnected') {
      throw new Error(`Cannot connect: state is ${this._state}`);
    }
    this._state = 'connecting';
    this.channelId = `cherry-${crypto.randomUUID()}`;
    if (typeof window !== 'undefined') {
      window.addEventListener('message', this.boundHandler);
    }
    const timeoutMs = options?.timeout ?? DEFAULT_TIMEOUT;
    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (typeof window !== 'undefined') {
          window.removeEventListener('message', this.boundHandler);
        }
        this._state = 'disconnected';
        this.channelId = null;
        this.connectResolve = null;
        reject(new Error(`Cherry handshake timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.post({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: this.channelId!,
        kind: 'handshake.hello',
        capabilities: this.opts.capabilities ?? {
          navigate: true,
          screenshot: true,
          openUrl: true,
        },
      });
    });
  }

  disconnect(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.boundHandler);
    }
    for (const [, p] of this.pending) p.reject(new Error('Cherry transport disconnected'));
    this.pending.clear();
    this._state = 'disconnected';
    this.channelId = null;
  }

  /**
   * Forward non-synthetic methods via postMessage to the host SDK.
   */
  protected async forward(
    method: string,
    params?: Record<string, unknown>,
    _sessionId?: string,
    timeout = DEFAULT_TIMEOUT
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Cherry CDP timed out after ${timeout}ms: ${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.post({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: this.channelId!,
        kind: 'cdp.request',
        id,
        method,
        params,
      });
    });
  }

  /** Test seam: inject a MessageEvent without a real window. */
  __test_receive(event: MessageEvent): void {
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
      cherry: CHERRY_PROTOCOL_VERSION,
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
    if (
      !acceptEnvelope(event, {
        allowOrigins: this.opts.allowOrigins,
        expectedSource: this.opts.counterpart as unknown as MessageEventSource,
        channelId: this.channelId,
      })
    ) {
      // A well-formed cherry envelope rejected by the gate signals a
      // misconfiguration (wrong host origin, source/channel mismatch) rather
      // than unrelated postMessage noise — log it so it doesn't surface only as
      // an opaque 30s connect timeout. Plain noise is filtered out silently.
      if (isCherryEnvelope(event.data)) {
        log.warn('Rejected a cherry envelope (origin/source/channel mismatch)', {
          origin: event.origin,
          allowOrigins: this.opts.allowOrigins,
        });
      }
      return;
    }
    const env = event.data as CherryEnvelope;
    switch (env.kind) {
      case 'handshake.welcome':
        if (this.connectTimer !== null) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        this._state = 'connected';
        this._joinUrl = env.joinUrl ?? null;
        this._theme = env.theme ?? null;
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
        log.info('Cherry handshake complete', { channelId: this.channelId });
        this.connectResolve?.();
        this.connectResolve = null;
        return;
      case 'cdp.response': {
        const p = this.pending.get(env.id);
        if (!p) return;
        this.pending.delete(env.id);
        if (env.error)
          p.reject(new Error(`Cherry CDP error: ${env.error.message} (${env.error.code})`));
        else p.resolve(env.result ?? {});
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
      default:
        return;
    }
  }
}
