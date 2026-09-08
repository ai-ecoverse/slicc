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
import { createLogger } from '../base/logger.js';
import { extractCatalog } from '../net/discovery-link.js';
import {
  type CdpHeaderBag,
  extractHandoffFromCdpHeaders,
  type HandoffMatch,
  type HandoffVerb,
} from '../net/handoff-link.js';
import type { ParsedLink } from '../net/link-header.js';
import { type ProbeFetch, probeWellKnown } from '../net/well-known-probe.js';
import type { CDPTransport } from './transport.js';
import type { CDPEventListener } from './types.js';

const log = createLogger('navigation-watcher');

/** Fields read off `Target.attachedToTarget` / `Target.targetCreated` CDP events. */
interface NavigationTargetInfo {
  targetId?: string;
  type?: string;
  title?: string;
  url?: string;
  attached?: boolean;
  openerId?: string;
}

interface TargetAttachedToTargetParams {
  sessionId?: string;
  targetInfo?: NavigationTargetInfo;
}

interface TargetDetachedFromTargetParams {
  sessionId?: string;
}

interface TargetInfoChangedParams {
  targetInfo?: NavigationTargetInfo;
}

interface TargetCreatedParams {
  targetInfo?: NavigationTargetInfo;
}

interface PageFrameNavigatedParams {
  sessionId?: string;
  frame?: { id?: string; parentId?: string; url?: string };
}

interface NetworkResponseReceivedParams {
  sessionId?: string;
  type?: string;
  frameId?: string;
  response?: { url?: string; headers?: CdpHeaderBag };
}

interface TargetGetTargetsResult {
  targetInfos?: NavigationTargetInfo[];
}

interface PageGetFrameTreeResult {
  frameTree?: { frame?: { id?: string } };
}

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
  headers: CdpHeaderBag | undefined,
  baseUrl?: string
): { match: HandoffMatch | null; links: ParsedLink[] } {
  return extractHandoffFromCdpHeaders(headers, baseUrl);
}

export class NavigationWatcher {
  private readonly transport: CDPTransport;
  private readonly onEvent: NavigationEventHandler;
  private readonly sessions = new Map<string, SessionState>();
  private started = false;
  /** Unsubscribe for the transport state subscription, when the transport has one. */
  private unsubscribeState: (() => void) | null = null;
  /** Guards against overlapping re-arms if `connected` fires twice in a row. */
  private rearming = false;
  /** A 'connected' edge arrived while a re-arm was in flight; run once more after it settles. */
  private rearmQueued = false;

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
  /**
   * Target ids with an in-flight `Target.attachToTarget` of ours whose
   * `sessionId` is not known yet. Chrome emits `Target.attachedToTarget`
   * before it answers the command, so a pending target id is what identifies
   * that first event as ours.
   */
  /**
   * Targets with one of this watcher's `Target.attachToTarget` requests in
   * flight, each with the session ids `Target.attachedToTarget` reported for
   * that target meanwhile. Ownership is decided by the RESPONSE's session id,
   * never by "first event for the target": a `BrowserAPI` attach to the same
   * tab can land its event first, and claiming it would enable domains on a
   * foreign session while our own real session stays unarmed.
   */
  private readonly pendingAttaches = new Map<string, Set<string>>();
  /**
   * Targets whose attach was answered WITHOUT a session id (a transport shim
   * that does not echo one). Falls back to claiming the next
   * `Target.attachedToTarget` for the target, as before.
   */
  private readonly unidentifiedAttaches = new Set<string>();
  /** Session ids Chrome bound to this watcher's own attach requests. */
  private readonly ownSessionIds = new Set<string>();

  private readonly onAttachedToTarget: CDPEventListener = (raw) => {
    void this.handleAttachedToTarget(raw as TargetAttachedToTargetParams);
  };
  private readonly onDetachedFromTarget: CDPEventListener = (raw) => {
    const params = raw as TargetDetachedFromTargetParams;
    const sessionId = params.sessionId;
    if (!sessionId) return;
    this.sessions.delete(sessionId);
    this.ownSessionIds.delete(sessionId);
    // A session that went away cannot be the answer to an unanswered attach.
    for (const seen of this.pendingAttaches.values()) seen.delete(sessionId);
  };
  private readonly onTargetInfoChanged: CDPEventListener = (raw) => {
    const params = raw as TargetInfoChangedParams;
    const info = params.targetInfo;
    if (!info?.targetId) return;
    for (const state of this.sessions.values()) {
      if (state.targetId === info.targetId) {
        if (typeof info.title === 'string') state.title = info.title;
        if (typeof info.url === 'string') state.url = info.url;
      }
    }
  };
  private readonly onTargetCreated: CDPEventListener = (raw) => {
    void this.handleTargetCreated(raw as TargetCreatedParams);
  };
  private readonly onFrameNavigated: CDPEventListener = (raw) => {
    const params = raw as PageFrameNavigatedParams;
    const sessionId = params.sessionId;
    if (!sessionId) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const frame = params.frame;
    if (!frame?.id) return;
    // Remember the root frame id for this session (a frame with no parent).
    if (!frame.parentId) {
      state.rootFrameId = frame.id;
      if (typeof frame.url === 'string') state.url = frame.url;
    }
  };
  private readonly onResponseReceived: CDPEventListener = (raw) => {
    const params = raw as NetworkResponseReceivedParams;
    const sessionId = params.sessionId;
    if (!sessionId) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (params.type !== 'Document') return;
    const frameId = params.frameId;
    if (!frameId || frameId !== state.rootFrameId) return;
    const response = params.response;
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

  /**
   * The watcher's whole CDP event surface, as a table. Declared after the
   * handlers so the field initializers above have run; arming and disarming
   * are then one loop each instead of a wall of `on`/`off` calls repeated at
   * three sites.
   */
  private readonly eventBindings: ReadonlyArray<readonly [string, CDPEventListener]> = [
    ['Target.attachedToTarget', this.onAttachedToTarget],
    ['Target.detachedFromTarget', this.onDetachedFromTarget],
    ['Target.targetInfoChanged', this.onTargetInfoChanged],
    ['Target.targetCreated', this.onTargetCreated],
    ['Page.frameNavigated', this.onFrameNavigated],
    ['Network.responseReceived', this.onResponseReceived],
  ];

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
    this.registerListeners();

    if (!(await this.enableDiscovery())) {
      // Tear down listeners so a later start() can retry cleanly.
      this.unregisterListeners();
      return;
    }

    this.started = true;
    this.subscribeTransportState();
    await this.enumeratePreexistingTargets();
  }

  /** `off` before `on` so re-arming after a reset cannot double-register. */
  private registerListeners(): void {
    for (const [event, listener] of this.eventBindings) {
      this.transport.off(event, listener);
      this.transport.on(event, listener);
    }
  }

  private unregisterListeners(): void {
    for (const [event, listener] of this.eventBindings) this.transport.off(event, listener);
  }

  /**
   * Turn on target discovery for the current connection. Returns false when
   * the command failed, so the caller can decide whether to unwind (initial
   * start) or leave the watcher armed for the next reconnect.
   *
   * Use target discovery + manual attach instead of setAutoAttach. Auto-attach
   * with `waitForDebuggerOnStart` causes Chrome to pause both the new target's
   * JS and surface a "debugger paused in another tab" banner on the opener,
   * which freezes OAuth flows mid-redirect. Manual `Target.attachToTarget`
   * (without enabling the `Debugger` domain — we only enable `Page` and
   * `Network`) does NOT pause anything, so we can safely attach to every page
   * target regardless of whether it has an `openerId`.
   */
  private async enableDiscovery(): Promise<boolean> {
    try {
      await this.transport.send('Target.setDiscoverTargets', { discover: true });
      return true;
    } catch (err) {
      log.error('Failed to enable target discovery', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Pick up pages that were already open before we (re)armed. */
  private async enumeratePreexistingTargets(): Promise<void> {
    try {
      const result = (await this.transport.send('Target.getTargets')) as TargetGetTargetsResult;
      const infos = result.targetInfos ?? [];
      for (const info of infos) {
        if (info.type !== 'page') continue;
        const attached = info.attached === true;
        const targetId = info.targetId;
        if (attached || typeof targetId !== 'string') continue;
        await this.requestAttach(targetId, 'Failed to attach to preexisting target');
      }
    } catch (err) {
      log.debug('Failed to enumerate preexisting targets', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Follow the transport across an upstream reset (issue #2417).
   *
   * `Target.setDiscoverTargets`, the sessions this watcher attached, and the
   * `Page`/`Network` domains enabled on them are all CONNECTION-scoped: a
   * replacement Chrome socket has none of them, and re-registering JS event
   * listeners does not bring them back. Without this the watcher sits at
   * `started = true` holding sessions Chrome has already discarded, handoff /
   * ARD discovery stops after the first reset, and a leftover entry in
   * `pendingAttaches` can make a later foreign `BrowserAPI` session look
   * watcher-owned (which re-enables `Page`/`Network` on it and re-opens the
   * event-amplification leak).
   *
   * A transport with no `onStateChange` (cherry, synthetic, panel-RPC) keeps
   * today's behaviour: nothing tells the watcher, so nothing changes.
   */
  private subscribeTransportState(): void {
    if (this.unsubscribeState) return;
    this.unsubscribeState =
      this.transport.onStateChange?.((state) => {
        if (state === 'disconnected') {
          this.clearConnectionScopedState();
          return;
        }
        if (state === 'connected') {
          // A second drop+reconnect while the previous re-arm is still awaiting
          // its responses must not be discarded: that re-arm's commands were
          // rejected by the intervening reset, so a fresh one has to follow.
          if (this.rearming) this.rearmQueued = true;
          else void this.rearmAfterReconnect();
        }
      }) ?? null;
  }

  /** Drop everything that lived on the connection that just went away. */
  private clearConnectionScopedState(): void {
    this.sessions.clear();
    this.pendingAttaches.clear();
    this.unidentifiedAttaches.clear();
    this.ownSessionIds.clear();
  }

  /**
   * Clean internal restart on the replacement connection: re-arm the JS
   * listeners (a transport's `disconnect()` may have cleared them), re-enable
   * discovery, and re-enumerate the targets that are open right now.
   */
  private async rearmAfterReconnect(): Promise<void> {
    if (!this.started || this.rearming) return;
    this.rearming = true;
    try {
      // Belt and braces: a reset that arrived without a 'disconnected'
      // notification would otherwise leave stale ids behind.
      this.clearConnectionScopedState();
      this.registerListeners();
      if (!(await this.enableDiscovery())) return; // stay armed; the next reconnect retries
      await this.enumeratePreexistingTargets();
    } finally {
      this.rearming = false;
      if (this.rearmQueued) {
        this.rearmQueued = false;
        void this.rearmAfterReconnect();
      }
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
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.unregisterListeners();
    this.clearConnectionScopedState();

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
  private async handleTargetCreated(params: TargetCreatedParams): Promise<void> {
    const info = params.targetInfo;
    if (info?.type !== 'page' || typeof info.targetId !== 'string') return;
    if (info.attached) return; // already attached

    await this.requestAttach(info.targetId, 'Failed to attach to discovered target');
  }

  /**
   * Ask Chrome to attach this watcher to `targetId`, remembering that the
   * resulting session is ours so {@link handleAttachedToTarget} enables
   * `Page`/`Network` on it — and only on it.
   *
   * `Target.attachedToTarget` normally arrives before the command response, so
   * ownership is decided by the attach RESPONSE's session id (`pendingAttaches` buffers events seen meanwhile) and then,
   * once the response lands, by session id (`ownSessionIds`).
   *
   * NOTE: SLICC's own leader tab is attached like any other page target. There
   * is no cheap in-layer signal that identifies it: `resolveAppTabId`
   * (`shell/supplemental-commands/playwright/snapshot.ts`) sits above `cdp/` in
   * the layer stack and needs a `BrowserAPI` plus a panel-RPC round trip, and
   * matching `globalThis.location.origin` would be actively wrong — the handoff
   * pages this watcher exists to observe are served from the app origin itself
   * (`https://www.sliccy.ai/handoff?...`), so an origin test would suppress
   * exactly the licks we want. Deliberately left unfiltered.
   */
  private async requestAttach(targetId: string, failureMessage: string): Promise<void> {
    const seen = new Set<string>();
    this.pendingAttaches.set(targetId, seen);
    try {
      const result = (await this.transport.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      })) as { sessionId?: string } | undefined;
      const sessionId = result?.sessionId;
      if (this.pendingAttaches.get(targetId) !== seen) return; // reset meanwhile
      this.pendingAttaches.delete(targetId);
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        this.ownSessionIds.add(sessionId);
        // Its event may already have arrived while the response was pending;
        // arm it now. Any other session seen meanwhile was somebody else's.
        if (seen.has(sessionId)) await this.enableOwnSession(sessionId);
        return;
      }
      // No session id to correlate with: the first session reported for the
      // target is the best available guess (pre-existing behaviour).
      const first = seen.values().next().value;
      if (first) {
        this.ownSessionIds.add(first);
        await this.enableOwnSession(first);
      } else {
        this.unidentifiedAttaches.add(targetId);
      }
    } catch (err) {
      if (this.pendingAttaches.get(targetId) === seen) this.pendingAttaches.delete(targetId);
      log.debug(failureMessage, {
        targetId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Enable the domains this watcher needs on one of ITS sessions. */
  private async enableOwnSession(sessionId: string): Promise<void> {
    try {
      await this.transport.send('Page.enable', {}, sessionId);
      await this.transport.send('Network.enable', {}, sessionId);
      const tree = (await this.transport.send(
        'Page.getFrameTree',
        {},
        sessionId
      )) as PageGetFrameTreeResult;
      const frame = tree.frameTree?.frame;
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

  private async handleAttachedToTarget(params: TargetAttachedToTargetParams): Promise<void> {
    const sessionId = params.sessionId;
    const info = params.targetInfo;
    if (!sessionId || !info || info.type !== 'page' || typeof info.targetId !== 'string') return;

    this.sessions.set(sessionId, {
      targetId: info.targetId,
      rootFrameId: null,
      title: info.title,
      url: info.url,
    });

    // Enable the domains only on sessions this watcher asked for. `BrowserAPI`
    // keeps its own session per tab for `playwright-cli`; enabling
    // `Page`/`Network` on those too made Chrome fan every event out once more
    // per session (issue #2417). Foreign sessions stay in `this.sessions`, so
    // a navigate lick still rides on them when their owner has `Network`
    // enabled; we just stop adding to the amplification ourselves.
    if (this.ownSessionIds.has(sessionId)) {
      await this.enableOwnSession(sessionId);
      return;
    }
    // Our attach for this target is still unanswered: remember the session and
    // let the response decide whose it is.
    const seen = this.pendingAttaches.get(info.targetId);
    if (seen) {
      seen.add(sessionId);
      return;
    }
    // Answered without a session id: claim the first session reported since.
    if (this.unidentifiedAttaches.delete(info.targetId)) {
      this.ownSessionIds.add(sessionId);
      await this.enableOwnSession(sessionId);
    }
  }
}
