import type { CDPPayload } from '@slicc/shared-ts';
import { waitForEvent } from './pending-request-table.js';
import type { CDPTransport } from './transport.js';
import type { CDPConnectOptions, CDPEventListener, ConnectionState } from './types.js';

export interface SyntheticCdpTransportOptions {
  targetUrl: string;

  targetOrigin: string;

  title: string;

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
  private currentUrl: string;
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
  private runtimeEnabled = false;
  private nextExecutionContextId = 1;

  constructor(opts: SyntheticCdpTransportOptions) {
    this.currentUrl = opts.targetUrl;
    this.targetOrigin = opts.targetOrigin;
    this.title = opts.title;
    this.syntheticIds = opts.ids ?? DEFAULT_SYNTHETIC_IDS;
  }

  get state(): ConnectionState {
    return this._state;
  }

  protected getCurrentUrl(): string {
    return this.currentUrl;
  }

  protected onCloseTarget(): void {}

  abstract connect(options?: CDPConnectOptions): Promise<void>;
  abstract disconnect(): void;

  async send(
    method: string,
    params?: CDPPayload,
    sessionId?: string,
    timeout = DEFAULT_TIMEOUT
  ): Promise<CDPPayload> {
    if (this._state !== 'connected') throw new Error('Transport is not connected');

    const synthetic = this.handleSynthetic(method, params);
    if (synthetic !== null) return synthetic;

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

  once(event: string, timeout = DEFAULT_TIMEOUT): Promise<CDPPayload> {
    return waitForEvent<CDPPayload>(
      (handler) => {
        this.on(event, handler);
        return () => this.off(event, handler);
      },
      timeout,
      `Timed out waiting for event: ${event}`
    );
  }

  protected abstract forward(
    method: string,
    params?: CDPPayload,
    sessionId?: string,
    timeout?: number
  ): Promise<CDPPayload>;

  protected emit(method: string, params: CDPPayload): void {
    const set = this.listeners.get(method);
    if (!set) return;
    for (const l of set) {
      try {
        l(params);
      } catch {}
    }
  }

  private handleSynthetic(method: string, _params?: CDPPayload): Promise<CDPPayload> | null {
    switch (method) {
      case 'Target.getTargets':
        return Promise.resolve({
          targetInfos: [
            {
              targetId: this.syntheticIds.target,
              type: 'page',
              title: this.title,
              url: this.getCurrentUrl(),
              attached: true,
            },
          ],
        });
      case 'Target.attachToTarget':
        this.runtimeEnabled = false;
        return Promise.resolve({ sessionId: this.syntheticIds.session });
      case 'Target.detachFromTarget':
        this.runtimeEnabled = false;
        return Promise.resolve({ success: true });
      case 'Target.closeTarget':
        this.runtimeEnabled = false;
        this.onCloseTarget();
        return Promise.resolve({ success: true });
      case 'Page.enable':
      case 'DOM.enable':
      case 'Page.bringToFront':
        return Promise.resolve({});
      case 'Runtime.enable':
        if (!this.runtimeEnabled) {
          this.runtimeEnabled = true;
          this.emitMainWorldContextCreated();
        }
        return Promise.resolve({});
      case 'Runtime.disable':
        this.runtimeEnabled = false;
        return Promise.resolve({});
      case 'Page.getFrameTree':
        return Promise.resolve({
          frameTree: {
            frame: {
              id: this.syntheticIds.frame,
              loaderId: this.syntheticIds.loader,
              url: this.getCurrentUrl(),
              securityOrigin: this.targetOrigin,
              mimeType: 'text/html',
            },
            childFrames: [],
          },
        });
      case 'Page.createIsolatedWorld':
        return Promise.resolve({ executionContextId: 1 });
      default:
        return null;
    }
  }

  private synthesizeNavigationLifecycle(navResult: CDPPayload, navigatedUrl?: string): void {
    const frameId = (navResult.frameId as string) ?? this.syntheticIds.frame;
    const url = navigatedUrl ?? this.getCurrentUrl();

    if (navigatedUrl) this.currentUrl = navigatedUrl;
    if (this.runtimeEnabled) {
      this.emit('Runtime.executionContextsCleared', { sessionId: this.syntheticIds.session });
    }
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
    if (this.runtimeEnabled) this.emitMainWorldContextCreated();
    this.emit('Page.loadEventFired', {
      timestamp: Date.now() / 1000,
      sessionId: this.syntheticIds.session,
    });
  }

  private emitMainWorldContextCreated(): void {
    this.emit('Runtime.executionContextCreated', {
      context: {
        id: this.nextExecutionContextId++,
        origin: this.targetOrigin,
        name: '',
        auxData: {
          isDefault: true,
          type: 'default',
          frameId: this.syntheticIds.frame,
        },
      },
      sessionId: this.syntheticIds.session,
    });
  }
}
