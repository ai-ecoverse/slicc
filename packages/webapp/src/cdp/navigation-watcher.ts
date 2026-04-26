/**
 * NavigationWatcher — observes main-frame document responses across all tabs
 * and emits an event when an `x-slicc` response header is present.
 *
 * Used in CLI / Electron floats where the webapp owns a WebSocket CDPTransport
 * to the controlled Chrome. The extension float does not use this watcher
 * (see chrome.webRequest observer in the service worker instead), because
 * CDP-level observation requires attaching chrome.debugger to every tab.
 */

import type { CDPTransport } from './transport.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('navigation-watcher');

export interface NavigationEvent {
  /** URL of the main-frame document whose response carried the x-slicc header. */
  url: string;
  /** The raw x-slicc header value. */
  sliccHeader: string;
  /** Page title at the time of the response, if available. */
  title?: string;
  /** CDP target id of the tab that received the response. */
  targetId: string;
}

export type NavigationEventHandler = (event: NavigationEvent) => void;

interface SessionState {
  targetId: string;
  rootFrameId: string | null;
  /** Last-seen title, populated by Page.frameNavigated / Target.targetInfoChanged. */
  title?: string;
  /** URL at which the page currently lives (for title lookup fallback). */
  url?: string;
}

/**
 * Decode an x-slicc header value. Producers (including sliccy.ai's
 * /handoff?msg= endpoint) percent-encode the value so non-Latin1 inputs
 * survive `Headers.set`. If decoding fails (malformed percent sequence),
 * fall back to the raw value — a percent-encoded string is a superset of
 * ASCII, so decoding is idempotent on already-safe values.
 */
export function decodeSliccHeader(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Find the x-slicc header value in a CDP Network.Response.headers bag.
 * Header names are case-insensitive per RFC 7230. Value is returned decoded.
 */
export function extractSliccHeader(headers: Record<string, unknown> | undefined): string | null {
  if (!headers) return null;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'x-slicc' && typeof value === 'string' && value.length > 0) {
      return decodeSliccHeader(value);
    }
  }
  return null;
}

export class NavigationWatcher {
  private readonly transport: CDPTransport;
  private readonly onEvent: NavigationEventHandler;
  private readonly sessions = new Map<string, SessionState>();
  private started = false;

  private readonly onAttachedToTarget = (params: Record<string, unknown>) => {
    void this.handleAttachedToTarget(params);
  };
  private readonly onDetachedFromTarget = (params: Record<string, unknown>) => {
    const sessionId = params['sessionId'] as string | undefined;
    if (sessionId) this.sessions.delete(sessionId);
  };
  private readonly onTargetInfoChanged = (params: Record<string, unknown>) => {
    const info = params['targetInfo'] as
      | { targetId?: string; title?: string; url?: string }
      | undefined;
    if (!info?.targetId) return;
    for (const state of this.sessions.values()) {
      if (state.targetId === info.targetId) {
        if (typeof info.title === 'string') state.title = info.title;
        if (typeof info.url === 'string') state.url = info.url;
      }
    }
  };
  private readonly onFrameNavigated = (params: Record<string, unknown>) => {
    const sessionId = params['sessionId'] as string | undefined;
    if (!sessionId) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const frame = params['frame'] as { id?: string; parentId?: string; url?: string } | undefined;
    if (!frame?.id) return;
    // Remember the root frame id for this session (a frame with no parent).
    if (!frame.parentId) {
      state.rootFrameId = frame.id;
      if (typeof frame.url === 'string') state.url = frame.url;
    }
  };
  private readonly onResponseReceived = (params: Record<string, unknown>) => {
    const sessionId = params['sessionId'] as string | undefined;
    if (!sessionId) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (params['type'] !== 'Document') return;
    const frameId = params['frameId'] as string | undefined;
    if (!frameId || frameId !== state.rootFrameId) return;
    const response = params['response'] as
      | { url?: string; headers?: Record<string, unknown> }
      | undefined;
    if (!response) return;
    const sliccHeader = extractSliccHeader(response.headers);
    if (!sliccHeader) return;
    const url =
      typeof response.url === 'string' && response.url.length > 0 ? response.url : state.url;
    if (!url) return;
    this.onEvent({
      url,
      sliccHeader,
      title: state.title,
      targetId: state.targetId,
    });
  };

  constructor(transport: CDPTransport, onEvent: NavigationEventHandler) {
    this.transport = transport;
    this.onEvent = onEvent;
  }

  /**
   * Begin observing. Idempotent on success; retriable after a transient
   * failure enabling target discovery.
   */
  async start(): Promise<void> {
    if (this.started) return;

    // Register listeners first so any events that fire as a side effect of
    // setAutoAttach are captured.
    this.transport.on('Target.attachedToTarget', this.onAttachedToTarget);
    this.transport.on('Target.detachedFromTarget', this.onDetachedFromTarget);
    this.transport.on('Target.targetInfoChanged', this.onTargetInfoChanged);
    this.transport.on('Page.frameNavigated', this.onFrameNavigated);
    this.transport.on('Network.responseReceived', this.onResponseReceived);

    try {
      await this.transport.send('Target.setDiscoverTargets', { discover: true });
      await this.transport.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    } catch (err) {
      log.error('Failed to enable target discovery', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Tear down listeners so a later start() can retry cleanly.
      this.transport.off('Target.attachedToTarget', this.onAttachedToTarget);
      this.transport.off('Target.detachedFromTarget', this.onDetachedFromTarget);
      this.transport.off('Target.targetInfoChanged', this.onTargetInfoChanged);
      this.transport.off('Page.frameNavigated', this.onFrameNavigated);
      this.transport.off('Network.responseReceived', this.onResponseReceived);
      return;
    }

    this.started = true;

    // Pick up pages that were already open before we started.
    try {
      const result = await this.transport.send('Target.getTargets');
      const infos = (result['targetInfos'] as Array<Record<string, unknown>> | undefined) ?? [];
      for (const info of infos) {
        if (info['type'] !== 'page') continue;
        const attached = info['attached'] === true;
        const targetId = info['targetId'];
        if (attached || typeof targetId !== 'string') continue;
        try {
          await this.transport.send('Target.attachToTarget', { targetId, flatten: true });
        } catch (err) {
          log.debug('Failed to attach to preexisting target', {
            targetId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.debug('Failed to enumerate preexisting targets', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Stop observing and release all listeners.
   *
   * Best-effort: also disables `Target.setAutoAttach` and
   * `Target.setDiscoverTargets` on the browser so CDP stops spawning
   * sessions and discovery traffic after stop. Errors on those commands
   * are swallowed — teardown should never throw.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.transport.off('Target.attachedToTarget', this.onAttachedToTarget);
    this.transport.off('Target.detachedFromTarget', this.onDetachedFromTarget);
    this.transport.off('Target.targetInfoChanged', this.onTargetInfoChanged);
    this.transport.off('Page.frameNavigated', this.onFrameNavigated);
    this.transport.off('Network.responseReceived', this.onResponseReceived);
    this.sessions.clear();

    try {
      await this.transport.send('Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    } catch (err) {
      log.debug('Failed to disable auto-attach on stop', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await this.transport.send('Target.setDiscoverTargets', { discover: false });
    } catch (err) {
      log.debug('Failed to disable target discovery on stop', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleAttachedToTarget(params: Record<string, unknown>): Promise<void> {
    const sessionId = params['sessionId'] as string | undefined;
    const info = params['targetInfo'] as
      | { targetId?: string; type?: string; title?: string; url?: string }
      | undefined;
    if (!sessionId || !info || info.type !== 'page' || typeof info.targetId !== 'string') return;

    this.sessions.set(sessionId, {
      targetId: info.targetId,
      rootFrameId: null,
      title: info.title,
      url: info.url,
    });

    try {
      await this.transport.send('Page.enable', {}, sessionId);
      await this.transport.send('Network.enable', {}, sessionId);
      const tree = await this.transport.send('Page.getFrameTree', {}, sessionId);
      const frame = (tree['frameTree'] as { frame?: { id?: string } } | undefined)?.frame;
      if (frame?.id && typeof frame.id === 'string') {
        const state = this.sessions.get(sessionId);
        if (state) state.rootFrameId = frame.id;
      }
    } catch (err) {
      log.debug('Failed to enable Page/Network on attached target', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
