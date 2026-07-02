/**
 * SyntheticCdpTransport — abstract base for CDP transports that synthesize
 * the session lifecycle locally (Target.getTargets, attachToTarget, Page.enable,
 * Page.getFrameTree, etc.) and delegate non-synthetic methods to a subclass-
 * specific backhaul.
 *
 * Used by:
 * - CherryHostTransport (postMessage to the host SDK in window.parent)
 * - PreviewBridgeCdpTransport (postMessage to the preview bridge bootstrap)
 */

import type { CDPTransport } from './transport.js';
import type { CDPConnectOptions, CDPEventListener, ConnectionState } from './types.js';

export interface SyntheticCdpTransportOptions {
  /** The URL reported in Target.getTargets (NOT location.href; may differ from the leader's page). */
  targetUrl: string;
  /** The origin reported in Page.getFrameTree. */
  targetOrigin: string;
  /** The title reported in Target.getTargets. */
  title: string;
  /** Synthetic CDP ids. Defaults to cherry-* for backward compatibility. */
  ids?: {
    target: string;
    session: string;
    frame: string;
    loader: string;
  };
}

const DEFAULT_SYNTHETIC_IDS = {
  target: 'cherry-target',
  session: 'cherry-session',
  frame: 'cherry-frame',
  loader: 'cherry-loader',
};

const DEFAULT_TIMEOUT = 30000;

export abstract class SyntheticCdpTransport implements CDPTransport {
  protected readonly targetUrl: string;
  protected readonly targetOrigin: string;
  protected readonly title: string;
  protected readonly syntheticIds: {
    target: string;
    session: string;
    frame: string;
    loader: string;
  };

  protected _state: ConnectionState = 'disconnected';
  private listeners = new Map<string, Set<CDPEventListener>>();

  constructor(opts: SyntheticCdpTransportOptions) {
    this.targetUrl = opts.targetUrl;
    this.targetOrigin = opts.targetOrigin;
    this.title = opts.title;
    this.syntheticIds = opts.ids ?? DEFAULT_SYNTHETIC_IDS;
  }

  get state(): ConnectionState {
    return this._state;
  }

  abstract connect(options?: CDPConnectOptions): Promise<void>;
  abstract disconnect(): void;

  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeout = DEFAULT_TIMEOUT
  ): Promise<Record<string, unknown>> {
    if (this._state !== 'connected') throw new Error('Transport is not connected');

    const synthetic = this.handleSynthetic(method, params);
    if (synthetic) return synthetic;

    const result = await this.forward(method, params, sessionId, timeout);

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

  once(event: string, timeout = DEFAULT_TIMEOUT): Promise<Record<string, unknown>> {
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

  /**
   * Subclass hook: forward non-synthetic methods to the backing transport.
   * Called only when the transport is connected.
   */
  protected abstract forward(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeout?: number
  ): Promise<Record<string, unknown>>;

  /**
   * Emit a CDP event to registered listeners.
   */
  protected emit(method: string, params: Record<string, unknown>): void {
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
              targetId: this.syntheticIds.target,
              type: 'page',
              title: this.title,
              url: this.targetUrl,
              attached: true,
            },
          ],
        });
      case 'Target.attachToTarget':
        return Promise.resolve({ sessionId: this.syntheticIds.session });
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
              id: this.syntheticIds.frame,
              loaderId: this.syntheticIds.loader,
              url: this.targetUrl,
              securityOrigin: this.targetOrigin,
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
    const frameId = (navResult.frameId as string) ?? this.syntheticIds.frame;
    const url = navigatedUrl ?? this.targetUrl;
    this.emit('Page.frameNavigated', {
      frame: {
        id: frameId,
        loaderId: this.syntheticIds.loader,
        url,
        securityOrigin: this.targetOrigin,
        mimeType: 'text/html',
      },
      sessionId: this.syntheticIds.session,
    });
    this.emit('Page.loadEventFired', {
      timestamp: Date.now() / 1000,
      sessionId: this.syntheticIds.session,
    });
  }
}
