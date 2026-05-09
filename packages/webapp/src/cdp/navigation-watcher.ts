/**
 * NavigationWatcher — observes main-frame document responses across all tabs
 * and emits an event when a recognised SLICC handoff `Link` rel is present.
 *
 * Used in CLI / Electron floats where the webapp owns a WebSocket CDPTransport
 * to the controlled Chrome. The extension float does not use this watcher
 * (see chrome.webRequest observer in the service worker instead), because
 * CDP-level observation requires attaching chrome.debugger to every tab.
 *
 * The handoff protocol is RFC 8288 (Web Linking):
 *
 *   Link: <https://github.com/o/r>; rel="https://www.sliccy.ai/rel/upskill"
 *   Link: <>; rel="https://www.sliccy.ai/rel/handoff";
 *         title*=UTF-8''Continue%20the%20signup%20flow
 *
 * The verb is the rel; the page-level target is the link href; the
 * free-form prose instruction (handoff verb only) rides in the `title`
 * parameter.
 */

import type { CDPTransport } from './transport.js';
import { createLogger } from '../core/logger.js';
import type { ParsedLink } from '../net/link-header.js';
import {
  extractHandoffFromCdpHeaders,
  type HandoffMatch,
  type HandoffVerb,
} from '../net/handoff-link.js';

const log = createLogger('navigation-watcher');

export interface NavigationEvent {
  /** URL of the main-frame document whose response advertised the handoff. */
  url: string;
  /** Verb identified by the link's rel (`handoff` | `upskill`). */
  verb: HandoffVerb;
  /** Resolved absolute URL of the link target. */
  target: string;
  /** Free-form instruction prose, when the link carried a `title` parameter. */
  instruction?: string;
  /** All parsed `Link` headers from the response, kept for downstream discovery. */
  links: ParsedLink[];
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
 * Find a SLICC handoff link in a CDP `Network.Response.headers` bag.
 * Header names are case-insensitive per RFC 7230. Returns the verb match
 * (or null) along with the full parsed link list so callers can hand the
 * latter to `discoverLinks` if they want to.
 */
export function extractHandoffFromHeaders(
  headers: Record<string, unknown> | undefined,
  baseUrl?: string
): { match: HandoffMatch | null; links: ParsedLink[] } {
  return extractHandoffFromCdpHeaders(headers, baseUrl);
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
  private readonly onTargetCreated = (params: Record<string, unknown>) => {
    void this.handleTargetCreated(params);
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
    const url =
      typeof response.url === 'string' && response.url.length > 0 ? response.url : state.url;
    if (!url) return;
    const { match, links } = extractHandoffFromHeaders(response.headers, url);
    if (!match) return;
    this.onEvent({
      url,
      verb: match.verb,
      target: match.target,
      instruction: match.instruction,
      links,
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

    // Register listeners before enabling discovery so events fired as a
    // side effect are captured.
    this.transport.on('Target.attachedToTarget', this.onAttachedToTarget);
    this.transport.on('Target.detachedFromTarget', this.onDetachedFromTarget);
    this.transport.on('Target.targetInfoChanged', this.onTargetInfoChanged);
    this.transport.on('Target.targetCreated', this.onTargetCreated);
    this.transport.on('Page.frameNavigated', this.onFrameNavigated);
    this.transport.on('Network.responseReceived', this.onResponseReceived);

    try {
      // Use target discovery + manual attach instead of setAutoAttach.
      // Auto-attach causes Chrome to pause the opener tab's JS when a
      // window.open() popup is created, showing "debugger paused in another
      // tab" and freezing OAuth flows. Manual attach via targetCreated lets
      // us skip popup targets (those with openerId) entirely.
      await this.transport.send('Target.setDiscoverTargets', { discover: true });
    } catch (err) {
      log.error('Failed to enable target discovery', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Tear down listeners so a later start() can retry cleanly.
      this.transport.off('Target.attachedToTarget', this.onAttachedToTarget);
      this.transport.off('Target.detachedFromTarget', this.onDetachedFromTarget);
      this.transport.off('Target.targetInfoChanged', this.onTargetInfoChanged);
      this.transport.off('Target.targetCreated', this.onTargetCreated);
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
    this.transport.off('Target.targetCreated', this.onTargetCreated);
    this.transport.off('Page.frameNavigated', this.onFrameNavigated);
    this.transport.off('Network.responseReceived', this.onResponseReceived);
    this.sessions.clear();

    try {
      await this.transport.send('Target.setDiscoverTargets', { discover: false });
    } catch (err) {
      log.debug('Failed to disable target discovery on stop', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handle a newly discovered target. Manually attach to non-popup page
   * targets. Popup targets (those with openerId) are skipped — attaching
   * to them causes Chrome to pause the opener tab.
   */
  private async handleTargetCreated(params: Record<string, unknown>): Promise<void> {
    const info = params['targetInfo'] as
      | { targetId?: string; type?: string; attached?: boolean; openerId?: string }
      | undefined;
    if (!info || info.type !== 'page' || typeof info.targetId !== 'string') return;
    if (info.attached) return; // already attached
    if (info.openerId) {
      log.debug('Skipping popup target to avoid debugger pause', {
        targetId: info.targetId,
        openerId: info.openerId,
      });
      return;
    }

    try {
      await this.transport.send('Target.attachToTarget', {
        targetId: info.targetId,
        flatten: true,
      });
    } catch (err) {
      log.debug('Failed to attach to discovered target', {
        targetId: info.targetId,
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
