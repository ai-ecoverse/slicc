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
  url: string;

  verb: HandoffVerb;

  target: string;

  instruction?: string;

  branch?: string;

  path?: string;

  links: ParsedLink[];

  title?: string;

  targetId: string;
}

export type NavigationEventHandler = (event: NavigationEvent) => void;

export interface DiscoveryEvent {
  origin: string;

  kind: DiscoveryKind;

  url: string;

  targetId: string;
}

export type DiscoveryEventHandler = (event: DiscoveryEvent) => void;

export interface NavigationWatcherOptions {
  onDiscovery?: DiscoveryEventHandler;

  probeFetch?: ProbeFetch;

  isDiscoveryEnabled?: () => boolean;

  probeTimeoutMs?: number;

  isOwnTab?: (targetInfo: NavigationTargetInfo) => boolean;
}

interface SessionState {
  targetId: string;
  rootFrameId: string | null;

  networkEnabled: boolean;

  title?: string;

  url?: string;
}

function parseHttpUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function normalizePathname(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

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

  private unsubscribeState: (() => void) | null = null;

  private rearming = false;

  private rearmQueued = false;

  private readonly onDiscovery?: DiscoveryEventHandler;
  private readonly probeFetch?: ProbeFetch;
  private readonly isDiscoveryEnabled: () => boolean;
  private readonly probeTimeoutMs?: number;

  private readonly isOwnTab: (targetInfo: NavigationTargetInfo) => boolean;

  private readonly probedOrigins = new Set<string>();

  private readonly pendingAttachTargetIds = new Set<string>();

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

    this.reconcileTargetNetwork(info);
  };
  private readonly onTargetCreated: CDPEventListener = (raw) => {
    void this.handleTargetCreated(raw as TargetCreatedParams);
  };

  private readonly onFrameRequestedNavigation: CDPEventListener = (raw) => {
    const p = raw as { sessionId?: string; frameId?: string; url?: string };
    this.maybeArmNetwork(p.sessionId, p.frameId, p.url);
  };

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

    this.maybeRunDiscovery(url, links, state.targetId);
  };

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

  private maybeRunDiscovery(url: string, links: ParsedLink[], targetId: string): void {
    if (!this.onDiscovery || !this.isDiscoveryEnabled()) return;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }

    const catalog = extractCatalog(links);
    if (catalog) {
      this.onDiscovery({ origin, kind: catalog.kind, url: catalog.url, targetId });
    }

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
      log.debug('Well-known discovery probe failed', {
        origin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async start(): Promise<void> {
    if (this.started) return;

    this.registerListeners();

    if (!(await this.enableDiscovery())) {
      this.unregisterListeners();
      return;
    }

    this.started = true;
    this.subscribeTransportState();
    await this.enumeratePreexistingTargets();
  }

  private registerListeners(): void {
    for (const [event, listener] of this.eventBindings) {
      this.transport.off(event, listener);
      this.transport.on(event, listener);
    }
  }

  private unregisterListeners(): void {
    for (const [event, listener] of this.eventBindings) this.transport.off(event, listener);
  }

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

  private subscribeTransportState(): void {
    if (this.unsubscribeState) return;
    this.unsubscribeState =
      this.transport.onStateChange?.((state) => {
        if (state === 'disconnected') {
          this.clearConnectionScopedState();
          return;
        }
        if (state === 'connected') {
          if (this.rearming) this.rearmQueued = true;
          else void this.rearmAfterReconnect();
        }
      }) ?? null;
  }

  private clearConnectionScopedState(): void {
    this.sessions.clear();
    this.pendingAttachTargetIds.clear();
    this.ownSessionIds.clear();
  }

  private async rearmAfterReconnect(): Promise<void> {
    if (!this.started || this.rearming) return;
    this.rearming = true;
    try {
      this.clearConnectionScopedState();
      this.registerListeners();
      if (!(await this.enableDiscovery())) return;
      await this.enumeratePreexistingTargets();
    } finally {
      this.rearming = false;
      if (this.rearmQueued) {
        this.rearmQueued = false;
        void this.rearmAfterReconnect();
      }
    }
  }

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

  private async handleTargetCreated(params: TargetCreatedParams): Promise<void> {
    const info = params.targetInfo;
    if (info?.type !== 'page' || typeof info.targetId !== 'string') return;
    if (info.attached) return;

    await this.requestAttach(info.targetId, 'Failed to attach to discovered target');
  }

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

  private reconcileTargetNetwork(targetInfo: NavigationTargetInfo): void {
    const own = this.isOwnTabSafe(targetInfo);
    for (const [sessionId, state] of this.sessions) {
      if (state.targetId !== targetInfo.targetId) continue;
      if (!this.ownSessionIds.has(sessionId)) continue;
      if (state.networkEnabled === !own) continue;
      void this.setSessionNetwork(sessionId, state, !own);
    }
  }

  private async setSessionNetwork(
    sessionId: string,
    state: SessionState,
    enable: boolean
  ): Promise<void> {
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
