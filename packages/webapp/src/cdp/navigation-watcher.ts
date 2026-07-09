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

import type { DiscoveryKind } from '@slicc/shared-ts';
import { createLogger } from '../core/logger.js';
import { extractCatalog } from '../net/discovery-link.js';
import {
  extractHandoffFromCdpHeaders,
  type HandoffMatch,
  type HandoffVerb,
} from '../net/handoff-link.js';
import type { ParsedLink } from '../net/link-header.js';
import { type ProbeFetch, probeWellKnown } from '../net/well-known-probe.js';
import type { CDPTransport } from './transport.js';

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
  /**
   * Optional branch carried by the upskill rel's `branch` Link param
   * (upskill verb only — handoff ignores it at the extractor).
   */
  branch?: string;
  /**
   * Optional sub-path carried by the upskill rel's `path` Link param
   * (upskill verb only). Canonical directory form — `/SKILL.md` stripped.
   */
  path?: string;
  /** All parsed `Link` headers from the response, kept for downstream discovery. */
  links: ParsedLink[];
  /** Page title at the time of the response, if available. */
  title?: string;
  /** CDP target id of the tab that received the response. */
  targetId: string;
}

export type NavigationEventHandler = (event: NavigationEvent) => void;

/**
 * An Agentic Resource Discovery (ARD) artifact advertised by an origin — either
 * a `rel="ai-catalog"` `Link` header on a main-frame response, or a well-known
 * artifact (`/.well-known/ai-catalog.json` / `/llms.txt`) that answered a
 * background probe. Emitted to {@link NavigationWatcherOptions.onDiscovery}.
 */
export interface DiscoveryEvent {
  /** Origin the artifact was found on (scheme + host + port). */
  origin: string;
  /** Which artifact was advertised. */
  kind: DiscoveryKind;
  /** Absolute URL of the artifact. */
  url: string;
  /** CDP target id of the tab whose navigation triggered the discovery. */
  targetId: string;
}

export type DiscoveryEventHandler = (event: DiscoveryEvent) => void;

/**
 * Optional discovery wiring for the watcher. When both `onDiscovery` and (for
 * the well-known vector) `probeFetch` are supplied, each main-frame document
 * response also runs ARD discovery: a `rel="ai-catalog"` `Link` header emits
 * immediately, and the origin's well-known locations are probed once per origin
 * per session in the background. `isDiscoveryEnabled` gates both vectors and
 * defaults to always-on.
 */
export interface NavigationWatcherOptions {
  /** Emit an ARD discovery artifact (header match or well-known probe hit). */
  onDiscovery?: DiscoveryEventHandler;
  /**
   * Injected fetch for background well-known probes. When omitted, only the
   * header vector runs (no probing). Routed through the proxied fetch by the
   * caller so the probe inherits CORS bypass in CLI/Electron.
   */
  probeFetch?: ProbeFetch;
  /**
   * Gate for discovery, consulted per response so a settings toggle can
   * enable/disable it live. Defaults to always-enabled.
   */
  isDiscoveryEnabled?: () => boolean;
  /** Per-request well-known probe timeout in ms (forwarded to `probeWellKnown`). */
  probeTimeoutMs?: number;
}

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

  private readonly onDiscovery?: DiscoveryEventHandler;
  private readonly probeFetch?: ProbeFetch;
  private readonly isDiscoveryEnabled: () => boolean;
  private readonly probeTimeoutMs?: number;
  /**
   * Origins whose well-known locations have already been probed this session.
   * A site can advertise on every navigation, so we probe each origin at most
   * once (marked synchronously before the async probe to close the rapid-
   * navigation race). LickManager applies a second artifact-identity dedup on
   * top for the header vector.
   */
  private readonly probedOrigins = new Set<string>();

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
    if (match) {
      const event: NavigationEvent = {
        url,
        verb: match.verb,
        target: match.target,
        links,
        targetId: state.targetId,
      };
      if (match.instruction != null) event.instruction = match.instruction;
      if (match.branch != null) event.branch = match.branch;
      if (match.path != null) event.path = match.path;
      if (state.title != null) event.title = state.title;
      this.onEvent(event);
    }
    // ARD discovery runs independently of the handoff/upskill match so an
    // origin advertising a catalog (or hosting well-known artifacts) is
    // surfaced even when the response carries no SLICC rel.
    this.maybeRunDiscovery(url, links, state.targetId);
  };

  constructor(
    transport: CDPTransport,
    onEvent: NavigationEventHandler,
    options: NavigationWatcherOptions = {}
  ) {
    this.transport = transport;
    this.onEvent = onEvent;
    this.onDiscovery = options.onDiscovery;
    this.probeFetch = options.probeFetch;
    this.isDiscoveryEnabled = options.isDiscoveryEnabled ?? (() => true);
    this.probeTimeoutMs = options.probeTimeoutMs;
  }

  /**
   * Run ARD discovery for a main-frame response: emit any `rel="ai-catalog"`
   * `Link` immediately, then kick off a once-per-origin background probe of the
   * well-known locations. No-op when discovery is disabled or unwired.
   */
  private maybeRunDiscovery(url: string, links: ParsedLink[], targetId: string): void {
    if (!this.onDiscovery || !this.isDiscoveryEnabled()) return;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }

    // Vector 1: header-advertised catalog. LickManager dedups repeats by
    // artifact identity, so no per-origin throttle is needed here.
    const catalog = extractCatalog(links);
    if (catalog) {
      this.onDiscovery({ origin, kind: catalog.kind, url: catalog.url, targetId });
    }

    // Vector 2: well-known probe, at most once per origin per session.
    if (this.probeFetch && !this.probedOrigins.has(origin)) {
      this.probedOrigins.add(origin);
      void this.runWellKnownProbe(origin, targetId);
    }
  }

  private async runWellKnownProbe(origin: string, targetId: string): Promise<void> {
    if (!this.probeFetch || !this.onDiscovery) return;
    try {
      const matches = await probeWellKnown(origin, this.probeFetch, {
        timeoutMs: this.probeTimeoutMs,
      });
      for (const m of matches) {
        this.onDiscovery({ origin, kind: m.kind, url: m.url, targetId });
      }
    } catch (err) {
      // probeWellKnown swallows its own network failures; this guards the
      // unexpected (e.g. a throwing onDiscovery handler) so a probe never
      // rejects the fire-and-forget caller.
      log.debug('Well-known discovery probe failed', {
        origin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
      // Auto-attach with `waitForDebuggerOnStart` causes Chrome to pause
      // both the new target's JS and surface a "debugger paused in
      // another tab" banner on the opener, which freezes OAuth flows
      // mid-redirect. Manual `Target.attachToTarget` (without enabling
      // the `Debugger` domain — we only enable `Page` and `Network`)
      // does NOT pause anything, so we can safely attach to every
      // page target regardless of whether it has an `openerId`.
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
   * Handle a newly discovered target. Manually attach to every page
   * target — including those with an `openerId` (i.e. tabs opened via
   * `target="_blank"` link clicks or `window.open()`). The pause-the-
   * opener pathology that prompted the earlier blanket skip was
   * specific to `Target.setAutoAttach`; manual attach without
   * enabling the `Debugger` domain is side-effect-free.
   *
   * Skipping every `openerId`-bearing target meant that any new tab
   * spawned from a link click would never have `Page`/`Network`
   * enabled on it, so its main-frame `Link` headers (and therefore
   * the resulting `navigate` lick) were silently dropped.
   */
  private async handleTargetCreated(params: Record<string, unknown>): Promise<void> {
    const info = params['targetInfo'] as
      | { targetId?: string; type?: string; attached?: boolean; openerId?: string }
      | undefined;
    if (info?.type !== 'page' || typeof info.targetId !== 'string') return;
    if (info.attached) return; // already attached

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
