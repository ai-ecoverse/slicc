import type { TrayTargetEntry } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { VirtualFS } from '../fs/index.js';
import { CDPClient } from './cdp-client.js';
import {
  CdpBridgeRejectedError,
  type CdpConnectFailureClassifier,
  CdpReconnectBackoffError,
  nextCdpReconnectDelayMs,
} from './cdp-reconnect-policy.js';
import { throwIfAborted } from './command-abort.js';
import { FrameContextRegistry } from './frame-context-registry.js';
import { HarRecorder } from './har-recorder.js';
import { MAX_TAB_SESSIONS, SessionCache, type TabSession } from './session-cache.js';
import type {
  CdpPayload,
  ExecutionWorld,
  TabHost,
  TabPage,
  ViewportOverride,
} from './tab-handle.js';
import { TabHandle } from './tab-handle.js';
import { TabLockManager, type TabLockStats } from './tab-lock-manager.js';
import type { CDPTransport } from './transport.js';
import type {
  CDPConnectOptions,
  CDPEventListener,
  ConnectionState,
  OpenWindowOptions,
  PageInfo,
  TargetInfo,
  WindowBounds,
  WindowBoundsInfo,
  WindowBoundsInput,
  WindowState,
} from './types.js';
import { ViewportOverrideStore } from './viewport-override-store.js';

export type { TabLockStats } from './tab-lock-manager.js';

export interface TrayTargetProvider {
  getTargets(): TrayTargetEntry[];
  createRemoteTransport?(runtimeId: string, localTargetId: string): CDPTransport;
  removeRemoteTransport?(runtimeId: string, localTargetId: string): void;

  openRemoteTab?(runtimeId: string, url: string): Promise<string>;
}

const FALLBACK_CDP_URL = 'ws://localhost:5710/cdp';
const log = createLogger('browser-api');

const STALE_SESSION_ERRORS = [
  'Session with given id not found',
  'Target closed',
  'No session with given id',
  'No tab attached for sessionId',
] as const;

class SessionResetError extends Error {}

function isStaleSessionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return STALE_SESSION_ERRORS.some((needle) => message.includes(needle));
}

export interface WithTabOptions {
  signal?: AbortSignal | undefined;
}

export type SessionChangeCallback = (
  sessionId: string,
  transport: CDPTransport,
  targetId: string
) => void;

export function getDefaultCdpUrl(
  locationLike: Pick<Location, 'protocol' | 'host'> | null = typeof window !== 'undefined'
    ? window.location
    : null
): string {
  if (!locationLike?.host) return FALLBACK_CDP_URL;
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${locationLike.host}/cdp`;
}

class AccountedTransport implements CDPTransport {
  onStateChange?: CDPTransport['onStateChange'];

  constructor(
    private readonly inner: CDPTransport,
    private readonly onApplied: (sessionId: string) => void
  ) {
    if (inner.onStateChange) this.onStateChange = (listener) => inner.onStateChange!(listener);
  }

  get state(): ConnectionState {
    return this.inner.state;
  }

  get superseded(): boolean | undefined {
    return this.inner.superseded;
  }

  get isExtensionBridge(): boolean | undefined {
    return this.inner.isExtensionBridge;
  }

  connect(options?: CDPConnectOptions): Promise<void> {
    return this.inner.connect(options);
  }

  disconnect(): void {
    this.inner.disconnect();
  }

  async send(
    method: string,
    params?: CdpPayload,
    sessionId?: string,
    timeout?: number
  ): Promise<CdpPayload> {
    const result =
      timeout === undefined
        ? await this.inner.send(method, params, sessionId)
        : await this.inner.send(method, params, sessionId, timeout);
    if (sessionId) this.onApplied(sessionId);
    return result;
  }

  on(event: string, listener: CDPEventListener): void {
    this.inner.on(event, listener);
  }

  off(event: string, listener: CDPEventListener): void {
    this.inner.off(event, listener);
  }

  once(event: string, timeout?: number): Promise<CdpPayload> {
    return this.inner.once(event, timeout);
  }
}

export class BrowserAPI implements TabHost {
  private client: CDPTransport;
  private localClient: CDPTransport;
  private sessionId: string | null = null;
  private attachedTargetId: string | null = null;
  private trayTargetProvider: TrayTargetProvider | null = null;
  private remoteTargetInfo: { runtimeId: string; localTargetId: string } | null = null;

  private readonly frames = new FrameContextRegistry();

  private readonly sessions = new SessionCache(MAX_TAB_SESSIONS, (targetId, entry) => {
    log.debug('Evicting least-recently-used CDP session', { targetId });
    void this.detachSession(targetId, entry);
  });

  private _listenedTransports = new Set<CDPTransport>();

  private _sessionReplacedSubs = new Map<string, Set<SessionChangeCallback>>();

  private readonly locks = new TabLockManager();

  private readonly viewports = new ViewportOverrideStore();
  private _onSessionChange?: SessionChangeCallback | undefined;

  private _lastConnectOptions: Partial<CDPConnectOptions> | null = null;

  private supersededHandler: (() => void) | null = null;
  private supersededNotified = false;

  private _reconnectAttempt = 0;
  private _reconnectNotBefore = 0;

  private _bridgeRejection: string | null = null;
  private bridgeRejectedHandler: (() => void) | null = null;
  private bridgeRejectedNotified = false;

  private classifyConnectFailure: CdpConnectFailureClassifier = async () => 'transient';
  private readonly handleJavaScriptDialogOpening = (params: CdpPayload): void => {
    void this.dismissJavaScriptDialog(params);
  };
  private async dismissJavaScriptDialog(params: CdpPayload): Promise<void> {
    const sessionId =
      typeof params['sessionId'] === 'string' ? (params['sessionId'] as string) : this.sessionId;
    if (!sessionId) return;

    try {
      await this.transportForSession(sessionId).send(
        'Page.handleJavaScriptDialog',
        { accept: false },
        sessionId,
        5000
      );
      log.warn('Auto-dismissed unexpected JavaScript dialog', {
        sessionId,
        type: params['type'],
        message: params['message'],
        url: params['url'],
      });
    } catch (error) {
      log.warn('Failed to auto-dismiss JavaScript dialog', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private readonly handleExecutionContextCreated = (params: CdpPayload): void => {
    const sessionId = this.eventSessionId(params);
    if (!sessionId) return;
    const context = params['context'] as
      | { id?: number; auxData?: { frameId?: string; isDefault?: boolean } }
      | undefined;
    const frameId = context?.auxData?.frameId;
    if (context?.auxData?.isDefault === true && frameId && typeof context.id === 'number') {
      this.frames.for(sessionId, 'main').set(frameId, context.id);
    }
  };
  private readonly handleExecutionContextDestroyed = (params: CdpPayload): void => {
    const sessionId = this.eventSessionId(params);
    if (!sessionId) return;
    const contextId = params['executionContextId'];
    if (typeof contextId !== 'number') return;
    const cache = this.frames.peek(sessionId, 'main');
    if (!cache) return;
    for (const [frameId, cachedId] of cache) if (cachedId === contextId) cache.delete(frameId);
  };
  private readonly handleExecutionContextsCleared = (params: CdpPayload): void => {
    const sessionId = this.eventSessionId(params);
    if (!sessionId) return;
    this.frames.peek(sessionId, 'main')?.clear();
  };

  private eventSessionId(params: CdpPayload): string | null {
    const id = params['sessionId'];
    return typeof id === 'string' ? id : this.sessionId;
  }

  private readonly handleDetachedFromTarget = (params: CdpPayload): void => {
    const sessionId = params['sessionId'];
    if (typeof sessionId !== 'string') return;
    const hit = this.sessions.findBySessionId(sessionId);
    if (hit) this.forgetSession(hit[0], hit[1]);
  };

  private readonly handleTargetDestroyed = (params: CdpPayload): void => {
    const targetId = params['targetId'];
    if (typeof targetId !== 'string') return;

    const hit = this.sessions.findByTargetOrLocalId(targetId)[0];
    if (hit) this.forgetSession(hit[0], hit[1]);
  };

  constructor(client?: CDPTransport) {
    this.client = client ?? new CDPClient();
    this.localClient = this.client;
    this.addTransportListeners(this.client);
  }

  getTransport(): CDPTransport {
    return this.accountedTransportFor(this.client);
  }

  getUnderlyingTransport(): CDPTransport {
    return this.client;
  }

  private readonly _accountedTransports = new WeakMap<CDPTransport, AccountedTransport>();

  private accountedTransportFor(transport: CDPTransport): CDPTransport {
    if (transport instanceof AccountedTransport) return transport;
    let facade = this._accountedTransports.get(transport);
    if (!facade) {
      facade = new AccountedTransport(transport, (sessionId) => this.noteApplied(sessionId));
      this._accountedTransports.set(transport, facade);
    }
    return facade;
  }

  private noteApplied(sessionId: string): void {
    this.sessions.noteApplied(sessionId);
  }

  createHarRecorder(fs: VirtualFS, transport: CDPTransport): HarRecorder {
    return new HarRecorder(transport, fs);
  }

  setSessionChangeCallback(cb: SessionChangeCallback | undefined): void {
    this._onSessionChange = cb;
  }

  onSessionReplaced(targetId: string, cb: SessionChangeCallback): () => void {
    let subs = this._sessionReplacedSubs.get(targetId);
    if (!subs) {
      subs = new Set();
      this._sessionReplacedSubs.set(targetId, subs);
    }
    subs.add(cb);
    return () => {
      const current = this._sessionReplacedSubs.get(targetId);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) this._sessionReplacedSubs.delete(targetId);
    };
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getAttachedTargetId(): string | null {
    return this.attachedTargetId;
  }

  async withTab<T>(
    targetId: string,
    fn: (tab: TabPage) => Promise<T>,
    opts?: WithTabOptions
  ): Promise<T> {
    const signal = opts?.signal;
    return this.locks.holdTabLock(targetId, signal, async (counters) => {
      const unpin = this.sessions.pin(targetId);
      try {
        counters.acquisitions += 1;
        return await this.runOnTab(targetId, fn, signal);
      } finally {
        unpin();
      }
    });
  }

  private async runOnTab<T>(
    targetId: string,
    fn: (tab: TabPage) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    try {
      return await this.attemptOnTab(targetId, fn, signal);
    } catch (err) {
      if (err instanceof SessionResetError || !isStaleSessionError(err)) throw err;
      log.warn('Stale CDP session — re-attaching and retrying once', {
        targetId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.invalidateSession(targetId);
      return await this.attemptOnTab(targetId, fn, signal);
    }
  }

  private async attemptOnTab<T>(
    targetId: string,
    fn: (tab: TabPage) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const tab = await this.attachHandle(targetId, this.locks.reentrantOwner(targetId), signal);

    throwIfAborted(signal, `about to run a command on tab ${targetId}`);
    const sessionId = tab.sessionId;
    const before = this.sessions.appliedCount(sessionId);
    try {
      return await fn(tab);
    } catch (err) {
      if (!isStaleSessionError(err)) throw err;
      const applied = this.sessions.appliedCount(sessionId) - before;
      if (applied === 0) throw err;
      this.invalidateSession(targetId);
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('CDP session reset mid-command — not replaying', { targetId, applied, reason });
      throw new SessionResetError(
        `The CDP session for tab ${targetId} was reset mid-command, after ${applied} ` +
          'command(s) had already been applied, so the outcome is unknown. The tab has been ' +
          `re-armed: check the page state before repeating this command. (underlying error: ${reason})`
      );
    }
  }

  private async attachHandle(
    targetId: string,
    owner: symbol | undefined,
    signal?: AbortSignal
  ): Promise<TabHandle> {
    const sessionId = await this.attachToPageOwned(targetId, owner, signal);
    const entry = this.sessions.get(targetId);
    return new TabHandle(
      this,
      targetId,
      sessionId,
      this.accountedTransportFor(entry?.transport ?? this.client),
      signal
    );
  }

  private handleFor(targetId: string, entry: TabSession): TabHandle {
    return new TabHandle(
      this,
      targetId,
      entry.sessionId,
      this.accountedTransportFor(entry.transport)
    );
  }

  getTabLockStats(targetId?: string): TabLockStats {
    return this.locks.getStats(targetId);
  }

  async runGlobal<T>(targetId: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.runGlobal(targetId, fn);
  }

  viewportOverride(targetId: string): ViewportOverride | undefined {
    return this.viewports.get(targetId);
  }

  recordViewportOverride(targetId: string, vp: ViewportOverride): void {
    this.viewports.set(targetId, vp);
  }

  frameContexts(sessionId: string, world: ExecutionWorld): Map<string, number> {
    return this.frames.for(sessionId, world);
  }

  private dropFrameContexts(sessionId: string): void {
    this.frames.drop(sessionId);
  }

  private async reapplyViewportOverride(targetId: string, entry: TabSession): Promise<void> {
    const vp = this.viewports.get(targetId);
    if (!vp) return;
    try {
      await this.handleFor(targetId, entry).applyViewportOverride(vp);
    } catch (err) {
      log.warn('Failed to re-apply viewport override on re-attach', {
        targetId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  setTrayTargetProvider(provider: TrayTargetProvider | null): void {
    this.trayTargetProvider = provider;
  }

  async listAllTargets(): Promise<PageInfo[]> {
    const local = await this.listPages();
    if (!this.trayTargetProvider) return local;

    const shouldDeduplicateLeaderTargets = !this.remoteTargetInfo;
    const localIds = new Set(local.map((p) => p.targetId));
    const remoteEntries = this.trayTargetProvider.getTargets();
    const remote: PageInfo[] = remoteEntries
      .filter(
        (t) =>
          !shouldDeduplicateLeaderTargets ||
          !(t.runtimeId === 'leader' && localIds.has(t.localTargetId))
      )
      .map((t) => ({
        targetId: t.targetId,
        title: t.title,
        url: t.url,
        kind: t.kind,
        capabilities: t.capabilities,
      }));

    return [...local, ...remote];
  }

  async connect(options?: Partial<CDPConnectOptions>): Promise<void> {
    if (this._bridgeRejection) {
      this.notifyBridgeRejected();
      throw new CdpBridgeRejectedError(this._bridgeRejection);
    }

    this._lastConnectOptions = options ? { ...options } : {};
    try {
      await this.client.connect({
        url: options?.url ?? getDefaultCdpUrl(),
        timeout: options?.timeout,
        ...(options?.protocols !== undefined ? { protocols: options.protocols } : {}),
      });
    } catch (err) {
      await this.noteReconnectFailure(options);
      if (this._bridgeRejection) throw new CdpBridgeRejectedError(this._bridgeRejection);
      throw err;
    }
    this.noteReconnectSuccess();
  }

  async reconnectIfNeeded(): Promise<void> {
    await this.ensureConnected();

    if (this.client !== this.localClient) await this.ensureLocalConnected();
  }

  primeConnectOptions(options?: Partial<CDPConnectOptions>): void {
    this._lastConnectOptions = options ? { ...options } : {};
  }

  setCdpSupersededHandler(handler: (() => void) | null): void {
    this.supersededHandler = handler;
  }

  setCdpBridgeRejectedHandler(handler: (() => void) | null): void {
    this.bridgeRejectedHandler = handler;
  }

  setCdpConnectFailureClassifier(classifier: CdpConnectFailureClassifier): void {
    this.classifyConnectFailure = classifier;
  }

  private throwIfReconnectPaused(): void {
    if (this._bridgeRejection) {
      this.notifyBridgeRejected();
      throw new CdpBridgeRejectedError(this._bridgeRejection);
    }
    if (Date.now() < this._reconnectNotBefore) throw new CdpReconnectBackoffError();
  }

  private noteReconnectSuccess(): void {
    this._reconnectAttempt = 0;
    this._reconnectNotBefore = 0;

    this.supersededNotified = false;
  }

  private async noteReconnectFailure(options?: Partial<CDPConnectOptions>): Promise<void> {
    const kind = await this.classifyConnectFailure({
      url: options?.url ?? '',
      ...(options?.protocols !== undefined ? { protocols: options.protocols } : {}),
    });
    if (kind === 'terminal') {
      this._bridgeRejection = new CdpBridgeRejectedError().message;
      this.notifyBridgeRejected();
      return;
    }
    const delay = nextCdpReconnectDelayMs(this._reconnectAttempt);
    this._reconnectAttempt += 1;
    this._reconnectNotBefore = Date.now() + delay;
  }

  private notifyBridgeRejected(): void {
    if (this.bridgeRejectedNotified) return;
    this.bridgeRejectedNotified = true;
    try {
      this.bridgeRejectedHandler?.();
    } catch {}
  }

  private notifySuperseded(): void {
    if (this.supersededNotified) return;
    this.supersededNotified = true;
    try {
      this.supersededHandler?.();
    } catch {}
  }

  async createPage(url?: string): Promise<string> {
    await this.ensureConnected();
    await this.ensureLocalConnected();
    const result = await this.localClient.send('Target.createTarget', {
      url: url ?? 'about:blank',
      background: true,
    });
    return result['targetId'] as string;
  }

  async openWindow(url: string, opts: OpenWindowOptions = {}): Promise<string> {
    await this.ensureConnected();
    await this.ensureLocalConnected();
    assertWindowGeometryCompatible(opts);
    const focus = opts.focus !== false;
    const params: CreateTargetWindowParams = {
      url: url || 'about:blank',

      newWindow: true,
      background: !focus,
    };

    if (opts.decorated === false) params.decorated = false;
    const state = opts.state;
    if (state && state !== 'normal') {
      params.windowState = state;
    } else {
      if (opts.width !== undefined) params.width = opts.width;
      if (opts.height !== undefined) params.height = opts.height;
      if (opts.left !== undefined) params.left = opts.left;
      if (opts.top !== undefined) params.top = opts.top;
      if (state) params.windowState = state;
    }
    const result = await this.localClient.send(
      'Target.createTarget',
      params as unknown as CdpPayload
    );
    const targetId = result['targetId'];
    if (typeof targetId !== 'string' || !targetId) {
      throw new Error('Target.createTarget did not return a usable targetId');
    }
    return targetId;
  }

  async getWindowBounds(targetId: string): Promise<WindowBoundsInfo> {
    await this.ensureConnected();
    const transport = await this.transportForWindowOps(targetId);
    const forTarget = await transport.send('Browser.getWindowForTarget', {
      targetId: localTargetIdOf(targetId),
    });
    const bounds = normalizeWindowBounds(forTarget['bounds']);
    const dpr = await this.readDevicePixelRatio(targetId);
    return { ...bounds, dpr };
  }

  async setWindowBounds(targetId: string, bounds: WindowBoundsInput): Promise<WindowBoundsInfo> {
    await this.ensureConnected();
    assertWindowGeometryCompatible(bounds);
    const transport = await this.transportForWindowOps(targetId);
    const localTargetId = localTargetIdOf(targetId);
    const forTarget = await transport.send('Browser.getWindowForTarget', {
      targetId: localTargetId,
    });
    const windowId = forTarget['windowId'];
    if (typeof windowId !== 'number') {
      throw new Error('Browser.getWindowForTarget did not return a windowId');
    }
    const current = normalizeWindowBounds(forTarget['bounds']);
    const state = bounds.state;
    const applyingGeometry =
      bounds.left !== undefined ||
      bounds.top !== undefined ||
      bounds.width !== undefined ||
      bounds.height !== undefined;

    if (applyingGeometry && current.state !== 'normal') {
      await transport.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal' } as unknown as CdpPayload,
      });
    }
    const cdpBounds: CdpBoundsPatch = {};
    if (state && state !== 'normal') {
      cdpBounds.windowState = state;
    } else {
      if (bounds.left !== undefined) cdpBounds.left = bounds.left;
      if (bounds.top !== undefined) cdpBounds.top = bounds.top;
      if (bounds.width !== undefined) cdpBounds.width = bounds.width;
      if (bounds.height !== undefined) cdpBounds.height = bounds.height;
      if (state) cdpBounds.windowState = state;
    }
    await transport.send('Browser.setWindowBounds', {
      windowId,
      bounds: cdpBounds as unknown as CdpPayload,
    });

    const achieved = await transport.send('Browser.getWindowBounds', { windowId });
    const normalized = normalizeWindowBounds(achieved['bounds']);
    const dpr = await this.readDevicePixelRatio(targetId);
    return { ...normalized, dpr };
  }

  private async readDevicePixelRatio(targetId: string): Promise<number> {
    try {
      const value = await this.withTab(targetId, (page) =>
        page.evaluate('window.devicePixelRatio', { awaitPromise: false, returnByValue: true })
      );
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
    } catch {
      return 1;
    }
  }

  private async transportForWindowOps(targetId: string): Promise<CDPTransport> {
    if (this.trayTargetProvider?.createRemoteTransport && targetId.includes(':')) {
      const colonIdx = targetId.indexOf(':');
      const runtimeId = targetId.substring(0, colonIdx);
      const localTargetId = targetId.substring(colonIdx + 1);
      return this.trayTargetProvider.createRemoteTransport(runtimeId, localTargetId);
    }
    await this.ensureLocalConnected();
    return this.localClient;
  }

  async createRemotePage(runtimeId: string, url?: string): Promise<string> {
    if (!this.trayTargetProvider?.openRemoteTab) {
      throw new Error('Remote tab opening not available (no tray target provider)');
    }
    return this.trayTargetProvider.openRemoteTab(runtimeId, url ?? 'about:blank');
  }

  async closePage(targetId: string): Promise<void> {
    await this.ensureConnected();
    this.viewports.delete(targetId);

    await this.dropSession(targetId);

    if (this.trayTargetProvider?.createRemoteTransport && targetId.includes(':')) {
      const colonIdx = targetId.indexOf(':');
      const runtimeId = targetId.substring(0, colonIdx);
      const localTargetId = targetId.substring(colonIdx + 1);

      {
        const remoteTransport = this.trayTargetProvider.createRemoteTransport(
          runtimeId,
          localTargetId
        );
        try {
          await remoteTransport.send('Target.closeTarget', { targetId: localTargetId });
        } finally {
          if (this.trayTargetProvider.removeRemoteTransport) {
            this.trayTargetProvider.removeRemoteTransport(runtimeId, localTargetId);
          }
        }
        return;
      }
    }

    await this.localClient.send('Target.closeTarget', { targetId });
  }

  disconnect(): void {
    this.clearSessions();
    this.client.disconnect();
  }

  async listPages(): Promise<PageInfo[]> {
    await this.ensureConnected();
    await this.ensureLocalConnected();
    const result = await this.localClient.send('Target.getTargets');
    const targets = (result['targetInfos'] as TargetInfo[]) ?? [];
    return targets
      .filter((t) => t.type === 'page')
      .map((t) => ({
        targetId: t.targetId,
        title: t.title,
        url: t.url,
        ...(t.active ? { active: true } : {}),
      }));
  }

  async attachToPage(targetId: string): Promise<string> {
    return this.attachToPageOwned(targetId, this.locks.reentrantOwner(targetId));
  }

  private async attachToPageOwned(
    targetId: string,
    owner: symbol | undefined,
    signal?: AbortSignal
  ): Promise<string> {
    const release = await this.locks.acquireBridgeLock({
      owner,
      targetId,
      counters: this.locks.countersFor(targetId),
    });
    try {
      await this.ensureConnected();

      const existing = this.sessions.get(targetId);
      if (existing) {
        this.activateSession(targetId, existing);
        return existing.sessionId;
      }

      const isRemote = !!this.trayTargetProvider?.createRemoteTransport && targetId.includes(':');
      return await (isRemote
        ? this.attachRemoteTarget(targetId, signal)
        : this.attachLocalTarget(targetId, signal));
    } finally {
      release();
    }
  }

  async selectTab(targetId: string): Promise<void> {
    await this.withTab(targetId, async () => undefined);
  }

  async bringTabToFront(targetId: string): Promise<void> {
    await this.withTab(targetId, (tab) => tab.bringToFront());
  }

  private async attachRemoteTarget(targetId: string, signal?: AbortSignal): Promise<string> {
    const colonIdx = targetId.indexOf(':');
    const runtimeId = targetId.substring(0, colonIdx);
    const localTargetId = targetId.substring(colonIdx + 1);

    const remoteTransport = this.trayTargetProvider?.createRemoteTransport?.(
      runtimeId,
      localTargetId
    );
    if (!remoteTransport) throw new Error(`No remote transport for target ${targetId}`);

    throwIfAborted(signal, `about to attach to tray tab ${targetId}`);
    const result = await remoteTransport.send('Target.attachToTarget', {
      targetId: localTargetId,
      flatten: true,
    });
    const entry: TabSession = {
      sessionId: result['sessionId'] as string,
      transport: remoteTransport,
      remote: { runtimeId, localTargetId },
    };
    this.rememberSession(targetId, entry);
    this.activateSession(targetId, entry);
    throwIfAborted(signal, `about to enable Page on tray tab ${targetId}`);
    await remoteTransport.send('Page.enable', {}, entry.sessionId);
    throwIfAborted(signal, `about to restore the viewport of tray tab ${targetId}`);
    await this.reapplyViewportOverride(targetId, entry);
    this.notifySessionChange(targetId, entry);
    return entry.sessionId;
  }

  private async attachLocalTarget(targetId: string, signal?: AbortSignal): Promise<string> {
    this.useLocalTransport();
    await this.ensureLocalConnected();

    throwIfAborted(signal, `about to attach to tab ${targetId}`);
    const result = await this.localClient.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const entry: TabSession = {
      sessionId: result['sessionId'] as string,
      transport: this.localClient,
    };
    this.rememberSession(targetId, entry);
    this.activateSession(targetId, entry);

    throwIfAborted(signal, `about to enable Page on tab ${targetId}`);
    await this.localClient.send('Page.enable', {}, entry.sessionId);
    throwIfAborted(signal, `about to restore the viewport of tab ${targetId}`);
    await this.reapplyViewportOverride(targetId, entry);
    this.notifySessionChange(targetId, entry);
    return entry.sessionId;
  }

  async detach(): Promise<void> {
    const targetId = this.attachedTargetId;
    if (!targetId) return;
    await this.dropSession(targetId);
    this.useLocalTransport();
  }

  async wakeCapture(tab: TabHandle, params: CdpPayload): Promise<CdpPayload> {
    const release = await this.locks.acquireBridgeLock({
      owner: this.locks.reentrantOwner(tab.targetId),
      targetId: tab.targetId,
    });
    try {
      return await this.wakeCaptureLocked(tab, params, this.locks.liveOwner());
    } finally {
      release();
    }
  }

  private async wakeCaptureLocked(
    tab: TabHandle,
    params: CdpPayload,
    owner: symbol | undefined
  ): Promise<CdpPayload> {
    const captured = tab.targetId;
    const previousFront = await this.findFocusedLocalPage(captured, owner).catch(() => null);

    const active = await this.attachHandle(captured, owner);
    try {
      await active.send('Page.bringToFront');
      return await active.send('Page.captureScreenshot', params);
    } finally {
      if (previousFront) {
        try {
          const donor = await this.attachHandle(previousFront, owner);
          await donor.send('Page.bringToFront');

          await this.attachToPageOwned(captured, owner);
        } catch {}
      }
    }
  }

  private async findFocusedLocalPage(
    excludeTargetId: string | null,
    owner: symbol | undefined
  ): Promise<string | null> {
    const pages = await this.listPages();
    for (const page of pages) {
      if (!page.targetId || page.targetId === excludeTargetId) continue;
      if (page.targetId.includes(':')) continue;
      try {
        const probe = await this.attachHandle(page.targetId, owner);
        const focused = await probe.evaluate('document.hasFocus()');
        if (focused === true) return page.targetId;
      } catch {}
    }
    return null;
  }

  private async ensureLocalConnected(): Promise<void> {
    if (this.localClient.superseded === true) {
      this.notifySuperseded();
      return;
    }
    if (this.localClient.state === 'disconnected') {
      this.throwIfReconnectPaused();
      const opts = this._lastConnectOptions;
      try {
        await this.localClient.connect({
          url: opts?.url ?? getDefaultCdpUrl(),
          ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
          ...(opts?.protocols !== undefined ? { protocols: opts.protocols } : {}),
        });
      } catch (err) {
        await this.noteReconnectFailure(opts ?? undefined);
        if (this._bridgeRejection) throw new CdpBridgeRejectedError(this._bridgeRejection);
        throw err;
      }
      this.noteReconnectSuccess();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.superseded === true) {
      this.notifySuperseded();
      return;
    }
    if (this.client.state === 'disconnected') {
      this.throwIfReconnectPaused();
      const dropped = this.client;

      if (this.remoteTargetInfo && this.trayTargetProvider?.removeRemoteTransport) {
        this.trayTargetProvider.removeRemoteTransport(
          this.remoteTargetInfo.runtimeId,
          this.remoteTargetInfo.localTargetId
        );
        this.setClient(this.localClient);
        this.remoteTargetInfo = null;
      }

      this.clearSessionsForTransport(dropped);
      if (this.client.state === 'disconnected') {
        await this.connect(this._lastConnectOptions ?? undefined);
      }
    }
  }

  private transportForSession(sessionId: string): CDPTransport {
    return this.sessions.findBySessionId(sessionId)?.[1].transport ?? this.client;
  }

  private addTransportListeners(transport: CDPTransport): void {
    if (this._listenedTransports.has(transport)) return;
    this._listenedTransports.add(transport);
    transport.on('Page.javascriptDialogOpening', this.handleJavaScriptDialogOpening);
    transport.on('Runtime.executionContextCreated', this.handleExecutionContextCreated);
    transport.on('Runtime.executionContextDestroyed', this.handleExecutionContextDestroyed);
    transport.on('Runtime.executionContextsCleared', this.handleExecutionContextsCleared);
    transport.on('Target.detachedFromTarget', this.handleDetachedFromTarget);
    transport.on('Target.targetDestroyed', this.handleTargetDestroyed);
  }

  private releaseLifecycleTransport(transport: CDPTransport): void {
    if (transport === this.localClient) return;
    if (!this._listenedTransports.has(transport)) return;
    if (this.sessions.anyOnTransport(transport)) return;
    this._listenedTransports.delete(transport);
    transport.off('Page.javascriptDialogOpening', this.handleJavaScriptDialogOpening);
    transport.off('Runtime.executionContextCreated', this.handleExecutionContextCreated);
    transport.off('Runtime.executionContextDestroyed', this.handleExecutionContextDestroyed);
    transport.off('Runtime.executionContextsCleared', this.handleExecutionContextsCleared);
    transport.off('Target.detachedFromTarget', this.handleDetachedFromTarget);
    transport.off('Target.targetDestroyed', this.handleTargetDestroyed);
  }

  private setClient(client: CDPTransport): void {
    this.addTransportListeners(client);
    this.client = client;
  }

  private useLocalTransport(): void {
    const remote = this.remoteTargetInfo;
    this.remoteTargetInfo = null;
    this.setClient(this.localClient);
    if (!remote) return;
    if (!this.sessions.anyMatchingRemote(remote.runtimeId, remote.localTargetId)) {
      this.trayTargetProvider?.removeRemoteTransport?.(remote.runtimeId, remote.localTargetId);
    }
  }

  private rememberSession(targetId: string, entry: TabSession): void {
    this.addTransportListeners(entry.transport);
    this.sessions.remember(targetId, entry);
  }

  private activateSession(targetId: string, entry: TabSession): void {
    if (entry.remote) {
      this.setClient(entry.transport);
      this.remoteTargetInfo = { ...entry.remote };
    } else if (this.client !== entry.transport) {
      this.useLocalTransport();
    }
    this.sessionId = entry.sessionId;
    this.attachedTargetId = targetId;
    this.sessions.touch(targetId, entry);
  }

  private notifySessionChange(targetId: string, entry: TabSession): void {
    const transport = this.accountedTransportFor(entry.transport);
    this._onSessionChange?.(entry.sessionId, transport, targetId);
    const subs = this._sessionReplacedSubs.get(targetId);
    if (!subs) return;
    for (const cb of [...subs]) {
      try {
        cb(entry.sessionId, transport, targetId);
      } catch (err) {
        log.warn('session-replaced subscriber threw', {
          targetId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private forgetSession(targetId: string, entry: TabSession): void {
    this.unregisterSession(targetId);
    this.disposeSessionTransport(entry);
  }

  private unregisterSession(targetId: string): void {
    const entry = this.sessions.get(targetId);
    if (entry) this.dropFrameContexts(entry.sessionId);
    this.sessions.delete(targetId);
    if (this.attachedTargetId === targetId) {
      this.sessionId = null;
      this.attachedTargetId = null;
    }
  }

  private disposeSessionTransport(entry: TabSession): void {
    this.releaseLifecycleTransport(entry.transport);
    if (entry.remote) {
      if (!this.sessions.anyMatchingRemote(entry.remote.runtimeId, entry.remote.localTargetId)) {
        this.trayTargetProvider?.removeRemoteTransport?.(
          entry.remote.runtimeId,
          entry.remote.localTargetId
        );
      }
    }
  }

  private async detachSession(targetId: string, entry: TabSession): Promise<void> {
    this.unregisterSession(targetId);
    try {
      await entry.transport.send('Target.detachFromTarget', { sessionId: entry.sessionId });
    } catch {
    } finally {
      this.disposeSessionTransport(entry);
    }
  }

  private async dropSession(targetId: string): Promise<void> {
    const entry = this.sessions.get(targetId);
    if (!entry) {
      if (this.attachedTargetId === targetId) {
        this.sessionId = null;
        this.attachedTargetId = null;
      }
      return;
    }
    await this.detachSession(targetId, entry);
  }

  private invalidateSession(targetId: string): void {
    const entry = this.sessions.get(targetId);
    if (entry) this.forgetSession(targetId, entry);
  }

  private clearSessionsForTransport(transport: CDPTransport): void {
    for (const [targetId, entry] of this.sessions.snapshot()) {
      if (entry.transport === transport) this.forgetSession(targetId, entry);
    }
  }

  private clearSessions(): void {
    for (const [targetId, entry] of this.sessions.snapshot()) this.forgetSession(targetId, entry);
    this.sessions.clear();
    this.sessionId = null;
    this.attachedTargetId = null;
  }
}

const WINDOW_STATES: ReadonlySet<string> = new Set([
  'normal',
  'minimized',
  'maximized',
  'fullscreen',
]);

interface CreateTargetWindowParams {
  url: string;
  newWindow: true;
  background: boolean;

  decorated?: false;
  windowState?: WindowState;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
}

interface CdpBoundsPatch {
  windowState?: WindowState;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

interface RawWindowBoundsFields {
  left?: unknown;
  top?: unknown;
  width?: unknown;
  height?: unknown;
  windowState?: unknown;
  state?: unknown;
}

function localTargetIdOf(targetId: string): string {
  const colon = targetId.indexOf(':');
  return colon >= 0 ? targetId.substring(colon + 1) : targetId;
}

function assertWindowGeometryCompatible(opts: {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  state?: WindowState;
}): void {
  const state = opts.state;
  if (!state || state === 'normal') return;
  if (!WINDOW_STATES.has(state)) {
    throw new Error(
      `window state must be one of ${[...WINDOW_STATES].join('|')} (got ${JSON.stringify(state)})`
    );
  }
  const hasGeometry =
    opts.left !== undefined ||
    opts.top !== undefined ||
    opts.width !== undefined ||
    opts.height !== undefined;
  if (hasGeometry) {
    throw new Error(
      `window state '${state}' cannot be combined with left/top/width/height (chrome.windows + CDP both reject the mix)`
    );
  }
}

function isRawWindowBoundsFields(value: unknown): value is RawWindowBoundsFields {
  return value !== null && typeof value === 'object';
}

function normalizeWindowBounds(raw: unknown): WindowBounds {
  const obj: RawWindowBoundsFields = isRawWindowBoundsFields(raw) ? raw : {};
  const stateRaw = obj.windowState ?? obj.state;
  const state: WindowState =
    typeof stateRaw === 'string' && WINDOW_STATES.has(stateRaw)
      ? (stateRaw as WindowState)
      : 'normal';
  return {
    left: numOr(obj.left, 0),
    top: numOr(obj.top, 0),
    width: numOr(obj.width, 0),
    height: numOr(obj.height, 0),
    state,
  };
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
