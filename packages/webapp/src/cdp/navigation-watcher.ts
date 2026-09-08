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

/**
 * Fields read off `Target.attachedToTarget` / `Target.targetCreated` CDP events.
 * Every field is optional: this is what Chrome put on the wire, not a promise
 * about what it sent. Also the argument
 * {@link NavigationWatcherOptions.isOwnTab} is called with.
 */
export interface NavigationTargetInfo {
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
  /**
   * Recognise SLICC's own app tab (the leader tab hosting this webapp).
   *
   * The watcher still attaches to it and enables `Page`, but leaves `Network`
   * OFF for as long as the predicate holds. `Network` is the expensive domain
   * on that tab: Chrome reports the tab's own `/cdp` WebSocket back as
   * `Network.webSocketFrame*` events, which is what overflows swift-server's
   * 1,000-message inbound pump (issue #2417). `Page` on a tab that does not
   * navigate costs nothing, and it is what lets the watcher arm `Network` at
   * the START of a navigation away from the app URL — early enough to still
   * see that navigation's document response, which is the one thing a
   * detach-and-reattach-later scheme cannot recover.
   *
   * Why this is a caller-supplied predicate rather than a check in here: the
   * leader tab has no cheap in-layer signal. `resolveAppTabId`
   * (`shell/supplemental-commands/playwright/snapshot.ts`) sits above `cdp/` in
   * the layer stack and needs a `BrowserAPI` plus a panel-RPC round trip, and a
   * bare origin test would be actively WRONG — the handoff pages this watcher
   * exists to observe are served from the app origin itself
   * (`https://www.sliccy.ai/handoff?...`). {@link createOwnTabMatcher} builds
   * the predicate both callers use; each supplies its own way of learning the
   * app page's URL (`location.href` in the page realm; in the kernel worker,
   * `KernelWorkerInitMsg.appPageUrl`, which the page sends at spawn — the
   * worker's own `self.location.href` is the worker SCRIPT url).
   *
   * Consulted on attach, on every navigation the tab starts, and on
   * `Target.targetInfoChanged` — so the transition works in BOTH directions: a
   * tab that leaves the app URL gets `Network` on, and one that navigates INTO
   * it gets `Network` off again before the new SLICC page opens its socket.
   *
   * Absent → `Network` is enabled on every page target, which is the
   * pre-#2417-follow-up behaviour.
   */
  isOwnTab?: (targetInfo: NavigationTargetInfo) => boolean;
}

interface SessionState {
  targetId: string;
  rootFrameId: string | null;
  /**
   * `Network` is enabled on this session. Only ever true for sessions the
   * watcher attached itself; an own-tab session sits at `false` until the tab
   * navigates away from the app URL.
   */
  networkEnabled: boolean;
  /** Last-seen title, populated by Page.frameNavigated / Target.targetInfoChanged. */
  title?: string;
  /** URL at which the page currently lives (for title lookup fallback). */
  url?: string;
}

/**
 * Parse `raw` as an http(s) URL. Anything else — `about:blank`, `chrome://`,
 * `devtools://`, a relative fragment — yields null, so an opaque origin can
 * never match another opaque origin.
 */
function parseHttpUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** `/`-preserving trailing-slash normalization, so `/handoff/` === `/handoff`. */
function normalizePathname(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

/**
 * Build an {@link NavigationWatcherOptions.isOwnTab} predicate that recognises
 * SLICC's own app tab from the URL of the page that hosts this webapp.
 *
 * The comparison is **origin + pathname**, deliberately ignoring query and
 * fragment:
 *
 *  - Query has to be ignored, because the leader tab carries float-specific
 *    search params (`?slicc=leader&ext=<id>`, `?ui=wc`, `?tray=<join>`) that
 *    differ per float and can change within a session.
 *  - Path must NOT be ignored, because the handoff / upskill pages this watcher
 *    exists to observe are served from the app's OWN origin at a different path
 *    (`https://www.sliccy.ai/handoff?handoff=...`). An origin-only test would
 *    suppress exactly the licks the watcher is for.
 *
 * `getAppPageUrl` is a getter rather than a value so a caller that does not
 * know the URL up front can start the watcher anyway: null means "don't know",
 * and nothing is skipped until it does.
 */
export function createOwnTabMatcher(
  getAppPageUrl: () => string | null | undefined
): (targetInfo: NavigationTargetInfo) => boolean {
  return (targetInfo: NavigationTargetInfo): boolean => {
    const app = parseHttpUrl(getAppPageUrl() ?? undefined);
    if (!app) return false;
    const target = parseHttpUrl(targetInfo.url);
    if (!target) return false;
    return (
      app.origin === target.origin &&
      normalizePathname(app.pathname) === normalizePathname(target.pathname)
    );
  };
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
  /** Tabs to keep `Network` off — SLICC's own app tab. Default: no tab is ours. */
  private readonly isOwnTab: (targetInfo: NavigationTargetInfo) => boolean;
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
  private readonly pendingAttachTargetIds = new Set<string>();
  /** Session ids Chrome bound to this watcher's own attach requests. */
  private readonly ownSessionIds = new Set<string>();

  private readonly onAttachedToTarget: CDPEventListener = (raw) => {
    void this.handleAttachedToTarget(raw as TargetAttachedToTargetParams);
  };
  private readonly onDetachedFromTarget: CDPEventListener = (raw) => {
    const params = raw as TargetDetachedFromTargetParams;
    const sessionId = params.sessionId;
    if (!sessionId) return;
    const state = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.ownSessionIds.delete(sessionId);
    // Release the target so a later `Target.targetCreated` for it can be
    // attached again rather than being mistaken for a foreign session.
    if (state) this.pendingAttachTargetIds.delete(state.targetId);
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
    // Backstop for both directions of the own-tab transition. `Page.frame*`
    // arms a departing tab earlier (in time for its document response); this
    // catches a tab that arrived at the app URL — a watched tab the user
    // navigated to SLICC, whose new page opens a `/cdp` socket we must not
    // start reporting on — and any departure the frame events missed.
    this.reconcileTargetNetwork(info);
  };
  private readonly onTargetCreated: CDPEventListener = (raw) => {
    void this.handleTargetCreated(raw as TargetCreatedParams);
  };
  /**
   * `Page.frameRequestedNavigation` — renderer-initiated navigation (link
   * click, `location.assign`), fired BEFORE the request goes out. The earliest
   * point at which an own tab can be armed for its own document response.
   */
  private readonly onFrameRequestedNavigation: CDPEventListener = (raw) => {
    const p = raw as { sessionId?: string; frameId?: string; url?: string };
    this.maybeArmNetwork(p.sessionId, p.frameId, p.url);
  };
  /**
   * `Page.frameStartedNavigating` — fired for browser-initiated navigations
   * too (address bar, bookmark), which `frameRequestedNavigation` never sees.
   * Still ahead of the response.
   */
  private readonly onFrameStartedNavigating: CDPEventListener = (raw) => {
    const p = raw as { sessionId?: string; frameId?: string; url?: string };
    this.maybeArmNetwork(p.sessionId, p.frameId, p.url);
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
    ['Page.frameRequestedNavigation', this.onFrameRequestedNavigation],
    ['Page.frameStartedNavigating', this.onFrameStartedNavigating],
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
    this.isOwnTab = options.isOwnTab ?? (() => false);
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
   * `pendingAttachTargetIds` can make a later foreign `BrowserAPI` session look
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
    this.pendingAttachTargetIds.clear();
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
   * Arm `Network` on one of our own sessions when the navigation it is about to
   * make leaves the app URL. Called from the two `Page.frame*` events that fire
   * BEFORE the document request, so the response that carries the handoff
   * `Link` header is still reported to us.
   *
   * Main frame only: a subframe navigating (a sprinkle iframe, a preview) says
   * nothing about what the tab is, and arming on one would switch `Network` on
   * for the app tab itself.
   */
  private maybeArmNetwork(
    sessionId: string | undefined,
    frameId: string | undefined,
    url: string | undefined
  ): void {
    if (!sessionId || !frameId) return;
    const state = this.sessions.get(sessionId);
    if (!state || state.networkEnabled || !this.ownSessionIds.has(sessionId)) return;
    if (state.rootFrameId !== frameId) return;
    if (this.isOwnTabSafe({ targetId: state.targetId, url })) return;
    void this.setSessionNetwork(sessionId, state, true);
  }

  /**
   * Re-decide `Network` for every own session on `targetInfo`'s target now that
   * its URL changed. Turns it OFF for a tab that became SLICC's own — the case
   * a one-way "skip at attach time" test misses, and the one that would put the
   * `/cdp` amplification straight back — and ON for a departure the frame
   * events did not cover.
   */
  private reconcileTargetNetwork(targetInfo: NavigationTargetInfo): void {
    const own = this.isOwnTabSafe(targetInfo);
    for (const [sessionId, state] of this.sessions) {
      if (state.targetId !== targetInfo.targetId) continue;
      if (!this.ownSessionIds.has(sessionId)) continue;
      if (state.networkEnabled === !own) continue;
      void this.setSessionNetwork(sessionId, state, !own);
    }
  }

  /** `Network.enable` / `Network.disable` on one session, flag kept in step. */
  private async setSessionNetwork(
    sessionId: string,
    state: SessionState,
    enable: boolean
  ): Promise<void> {
    // Set before awaiting: two navigation events for the same frame arrive
    // back to back, and the second must not send the command again.
    state.networkEnabled = enable;
    try {
      await this.transport.send(enable ? 'Network.enable' : 'Network.disable', {}, sessionId);
    } catch (err) {
      state.networkEnabled = !enable;
      log.debug(`Failed to ${enable ? 'enable' : 'disable'} Network on session`, {
        sessionId,
        targetId: state.targetId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** {@link NavigationWatcherOptions.isOwnTab}, with a throw read as `false`. */
  private isOwnTabSafe(targetInfo: NavigationTargetInfo): boolean {
    try {
      return this.isOwnTab(targetInfo);
    } catch (err) {
      log.debug('isOwnTab predicate threw; treating target as foreign', {
        targetId: targetInfo.targetId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Ask Chrome to attach this watcher to `targetId`, remembering that the
   * resulting session is ours so {@link handleAttachedToTarget} enables
   * `Page`/`Network` on it — and only on it.
   *
   * `Target.attachedToTarget` normally arrives before the command response, so
   * ownership is claimed first by target id (`pendingAttachTargetIds`) and then,
   * once the response lands, by session id (`ownSessionIds`).
   *
   * SLICC's own leader tab is attached like any other page target; what it does
   * NOT get is `Network` (see {@link NavigationWatcherOptions.isOwnTab}).
   * Enabling that domain on the app tab made Chrome report the `/cdp`
   * WebSocket's own traffic back as `Network.webSocketFrame*` events — the
   * proxies drop them by prefix, but swift-server's inbound pump still has to
   * receive them, and it kills the Chrome leg at 1,000 queued messages
   * (issue #2417).
   */
  private async requestAttach(targetId: string, failureMessage: string): Promise<void> {
    this.pendingAttachTargetIds.add(targetId);
    try {
      const result = (await this.transport.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      })) as { sessionId?: string } | undefined;
      const sessionId = result?.sessionId;
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        this.ownSessionIds.add(sessionId);
        this.pendingAttachTargetIds.delete(targetId);
      }
    } catch (err) {
      this.pendingAttachTargetIds.delete(targetId);
      log.debug(failureMessage, {
        targetId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Decide whether an attached session belongs to this watcher. A pending
   * target id is consumed on the first matching session so a second, foreign
   * attach to the same tab is not claimed as well.
   */
  private claimOwnSession(sessionId: string, targetId: string): boolean {
    if (this.ownSessionIds.has(sessionId)) return true;
    if (!this.pendingAttachTargetIds.has(targetId)) return false;
    this.pendingAttachTargetIds.delete(targetId);
    this.ownSessionIds.add(sessionId);
    return true;
  }

  private async handleAttachedToTarget(params: TargetAttachedToTargetParams): Promise<void> {
    const sessionId = params.sessionId;
    const info = params.targetInfo;
    if (!sessionId || !info || info.type !== 'page' || typeof info.targetId !== 'string') return;

    this.sessions.set(sessionId, {
      targetId: info.targetId,
      rootFrameId: null,
      networkEnabled: false,
      title: info.title,
      url: info.url,
    });

    // Enable the domains only on sessions this watcher asked for. `BrowserAPI`
    // mints a fresh session per tab switch for `playwright-cli` and never
    // detaches it; enabling `Page`/`Network` on those too made Chrome fan every
    // event out once more per leaked session (measured: +16 inbound events per
    // navigation per leaked session with the watcher versus +9 without —
    // issue #2417). Foreign sessions stay in `this.sessions`, so a navigate
    // lick still rides on them when their owner has `Network` enabled; we just
    // stop adding to the amplification ourselves.
    if (!this.claimOwnSession(sessionId, info.targetId)) return;

    const own = this.isOwnTabSafe(info);
    if (own) {
      log.debug('Attaching to the SLICC app tab with Network off', {
        targetId: info.targetId,
        url: info.url,
      });
    }
    try {
      await this.transport.send('Page.enable', {}, sessionId);
      if (!own) {
        const state = this.sessions.get(sessionId);
        if (state) await this.setSessionNetwork(sessionId, state, true);
      }
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
}
