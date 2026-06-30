/**
 * CherryHostTransport — `CDPTransport` implementation for the cherry
 * follower mode, alongside `CDPClient` (WebSocket / CLI) and
 * `ExtensionBridgeTransport` (thin extension `chrome.runtime` Port).
 *
 * Runs INSIDE the embedded SLICC follower iframe. Instead of a WebSocket or
 * chrome.debugger, it sends `cdp.request` envelopes to the host SDK
 * (`window.parent`) and resolves on `cdp.response`. It synthesizes the session
 * lifecycle BrowserAPI depends on (Target.getTargets/attachToTarget,
 * Page/Runtime/DOM.enable, getFrameTree) and — critically — emits
 * `Page.frameNavigated` + `Page.loadEventFired` after a `Page.navigate`
 * resolves so `BrowserAPI.navigate()` doesn't hang.
 */

import { createLogger } from '../core/logger.js';
import {
  acceptEnvelope,
  CHERRY_PROTOCOL_VERSION,
  type CherryEnvelope,
  isCherryEnvelope,
} from './cherry-host-protocol.js';
import type { CDPTransport } from './transport.js';
import type { CDPConnectOptions, CDPEventListener, ConnectionState } from './types.js';

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

const SYNTHETIC_SESSION = 'cherry-session';
const SYNTHETIC_TARGET = 'cherry-target';
const SYNTHETIC_FRAME = 'cherry-frame';
const DEFAULT_TIMEOUT = 30000;

export class CherryHostTransport implements CDPTransport {
  private opts: CherryHostTransportOptions;
  private channelId: string | null = null;
  private nextId = 1;
  private _state: ConnectionState = 'disconnected';
  private pending = new Map<
    number,
    { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private listeners = new Map<string, Set<CDPEventListener>>();
  private connectResolve: (() => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private _joinUrl: string | null = null;
  private _features: {
    terminal: boolean;
    files: boolean;
    memory: boolean;
    browser: boolean;
    modelSelector: boolean;
    thinkingMode: boolean;
    history: boolean;
    nav: boolean;
    newSprinkle: boolean;
  } = {
    terminal: true,
    files: true,
    memory: true,
    browser: true,
    modelSelector: true,
    thinkingMode: true,
    history: true,
    nav: true,
    newSprinkle: true,
  };
  private boundHandler = (ev: MessageEvent) => this.handleMessage(ev);

  /**
   * Invoked when the host SDK emits a `host.event` (host page → cone). The
   * cherry boot path wires this to forward the event to the leader over the
   * tray channel, where it surfaces as a `cherry` lick.
   */
  onHostEvent: ((name: string, detail?: unknown) => void) | null = null;

  constructor(opts: CherryHostTransportOptions) {
    this.opts = opts;
  }

  get state(): ConnectionState {
    return this._state;
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
    modelSelector: boolean;
    thinkingMode: boolean;
    history: boolean;
    nav: boolean;
    newSprinkle: boolean;
  } {
    return this._features;
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

  async send(
    method: string,
    params?: Record<string, unknown>,
    _sessionId?: string,
    timeout = 30000
  ): Promise<Record<string, unknown>> {
    if (this._state !== 'connected') throw new Error('Cherry transport is not connected');

    const synthetic = this.handleSynthetic(method, params);
    if (synthetic) return synthetic;

    const id = this.nextId++;
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
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

    if (method === 'Page.navigate') {
      this.synthesizeNavigationLifecycle(result, params?.url as string | undefined);
    }
    return result;
  }

  on(event: string, listener: CDPEventListener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: string, listener: CDPEventListener): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
    }
  }

  once(event: string, timeout = 30000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Timed out waiting for event: ${event}`));
      }, timeout);
      const handler: CDPEventListener = (params) => {
        clearTimeout(timer);
        this.off(event, handler);
        resolve(params);
      };
      this.on(event, handler);
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

  private emit(method: string, params: Record<string, unknown>): void {
    const set = this.listeners.get(method);
    if (!set) return;
    for (const l of set) {
      try {
        l(params);
      } catch {
        /* one listener must not break others */
      }
    }
  }

  /** Methods the transport answers locally to satisfy BrowserAPI's session setup. */
  private handleSynthetic(
    method: string,
    _params?: Record<string, unknown>
  ): Promise<Record<string, unknown>> | null {
    switch (method) {
      case 'Target.getTargets':
        return Promise.resolve({
          targetInfos: [
            {
              targetId: SYNTHETIC_TARGET,
              type: 'page',
              title: 'Cherry Host Page',
              url: typeof location !== 'undefined' ? location.href : 'about:blank',
              attached: true,
            },
          ],
        });
      case 'Target.attachToTarget':
        return Promise.resolve({ sessionId: SYNTHETIC_SESSION });
      case 'Target.detachFromTarget':
      case 'Target.closeTarget':
        return Promise.resolve({ success: true });
      case 'Page.enable':
      case 'Runtime.enable':
      case 'DOM.enable':
      case 'Page.bringToFront':
        return Promise.resolve({});
      case 'Page.getFrameTree':
        return Promise.resolve({
          frameTree: {
            frame: {
              id: SYNTHETIC_FRAME,
              loaderId: 'cherry-loader',
              url: typeof location !== 'undefined' ? location.href : 'about:blank',
              securityOrigin: this.opts.targetOrigin,
              mimeType: 'text/html',
            },
            childFrames: [],
          },
        });
      case 'Runtime.createIsolatedWorld':
        return Promise.resolve({ executionContextId: 1 });
      default:
        return null;
    }
  }

  private synthesizeNavigationLifecycle(
    navResult: Record<string, unknown>,
    navigatedUrl?: string
  ): void {
    const frameId = (navResult.frameId as string) ?? SYNTHETIC_FRAME;
    const url = navigatedUrl ?? (typeof location !== 'undefined' ? location.href : 'about:blank');
    this.emit('Page.frameNavigated', {
      frame: {
        id: frameId,
        loaderId: 'cherry-loader',
        url,
        securityOrigin: this.opts.targetOrigin,
        mimeType: 'text/html',
      },
      sessionId: SYNTHETIC_SESSION,
    });
    this.emit('Page.loadEventFired', {
      timestamp: Date.now() / 1000,
      sessionId: SYNTHETIC_SESSION,
    });
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
        this._features = env.features ?? {
          terminal: true,
          files: true,
          memory: true,
          browser: true,
          modelSelector: true,
          thinkingMode: true,
          history: true,
          nav: true,
          newSprinkle: true,
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
          sessionId: env.sessionId ?? SYNTHETIC_SESSION,
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
