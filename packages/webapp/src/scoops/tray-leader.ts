import type { LeaderToWorkerControlMessage, WorkerToLeaderControlMessage } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import {
  getLeaderStatusWithFallback,
  getLeaderTrayRuntimeStatus,
  LEADER_STATUS_STORAGE_KEY,
  type LeaderTrayRuntimeStatus,
  type LeaderTraySession,
  setLeaderTrayRuntimeStatus,
  subscribeToLeaderTrayRuntimeStatus,
} from '../base/tray-leader-status.js';
import { createTrayFetch, TrayProxyFetchError } from '../shell/tray-fetch.js';
import * as db from './db.js';
import {
  buildTrayWorkerUrl,
  DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
  TRAY_WORKER_STORAGE_KEY,
} from './tray-runtime-config.js';

export type TrayKind = 'desktop' | 'hosted';

const log = createLogger('tray-leader');
const LEADER_TRAY_STATE_KEY = 'leader-tray-session';
const LEADER_TRAY_PING_INTERVAL_MS = 30_000;
const LEADER_TRAY_CONNECT_TIMEOUT_MS = 10_000;
const LEADER_TRAY_RECONNECT_BASE_DELAY_MS = 1_000;
const LEADER_TRAY_RECONNECT_MAX_DELAY_MS = 30_000;
const LEADER_TRAY_RECONNECT_BACKOFF_MULTIPLIER = 2;
const LEADER_TRAY_RECONNECT_MAX_ATTEMPTS = 20;
const LEADER_TRAY_RECONNECT_SLOW_DELAY_MS = 60_000;
const NOTIFY_SUPERSEDED_TIMEOUT_MS = 10_000;

interface CreateTrayResponse {
  trayId: string;

  coneId?: string;
  createdAt: string;
  capabilities: {
    join: { url: string };
    controller: { url: string };

    webhook: { url: string; rebindToken?: string };
  };
}

interface ControllerAttachResponse {
  trayId: string;
  controllerId: string;
  role: 'leader' | 'follower';
  leaderKey?: string;
  websocket?: { url: string } | null;
}

export {
  createTrayFetch,
  getLeaderStatusWithFallback,
  getLeaderTrayRuntimeStatus,
  LEADER_STATUS_STORAGE_KEY,
  type LeaderTrayRuntimeStatus,
  type LeaderTraySession,
  setLeaderTrayRuntimeStatus,
  subscribeToLeaderTrayRuntimeStatus,
  TrayProxyFetchError,
};

export interface LeaderTraySessionStore {
  load(): Promise<LeaderTraySession | null>;
  save(session: LeaderTraySession): Promise<void>;
  clear(): Promise<void>;
}

export interface LeaderTrayWebSocket {
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown }) => void
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface LeaderTrayReconnectOptions {
  baseDelayMs?: number;

  backoffMultiplier?: number;

  maxDelayMs?: number;

  maxAttempts?: number;

  slowDelayMs?: number;

  sleep?: (ms: number) => Promise<void>;
}

export interface LeaderTrayManagerOptions {
  workerBaseUrl: string;
  runtime: string;
  store?: LeaderTraySessionStore;

  identityStore?: LeaderWebhookIdentityStore;

  replacementStore?: LeaderTraySessionStore;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => LeaderTrayWebSocket;
  onControlMessage?: (message: WorkerToLeaderControlMessage) => void;
  pingIntervalMs?: number;
  connectTimeoutMs?: number;

  reconnect?: LeaderTrayReconnectOptions | false;

  onReconnecting?: (attempt: number, lastError: string) => void;

  onReconnected?: (session: LeaderTraySession) => void;

  onReconnectGaveUp?: (lastError: string, attempts: number) => void;

  onLeaderReady?: (session: LeaderTraySession) => void;

  kind?: TrayKind;
}

export class IndexedDbLeaderTraySessionStore implements LeaderTraySessionStore {
  constructor(private readonly key = LEADER_TRAY_STATE_KEY) {}

  async load(): Promise<LeaderTraySession | null> {
    return parseLeaderTraySession(await db.getState(this.key));
  }

  async save(session: LeaderTraySession): Promise<void> {
    await db.setState(this.key, JSON.stringify(session));
  }

  async clear(): Promise<void> {
    await db.setState(this.key, '');
  }
}

export interface ConeIdentity {
  coneId: string;
  coneSecret: string;
  rebindSecret: string;

  established?: boolean;

  pendingRotation?: LeaderTraySession & { secret: string; rebindSecret: string };

  pendingCreateAttemptId?: string;

  pendingCreateTrayId?: string;
}

export interface LeaderWebhookIdentityStore {
  load(): Promise<ConeIdentity | null>;
  save(identity: ConeIdentity): Promise<void>;
  compareAndSwap(expected: ConeIdentity | null, next: ConeIdentity): Promise<boolean>;
}

export class IndexedDbLeaderWebhookIdentityStore implements LeaderWebhookIdentityStore {
  private readonly key: string;
  private readonly snapshots = new WeakMap<ConeIdentity, string>();

  constructor(workerBaseUrl: string) {
    this.key = `leader-webhook-identity:${workerBaseUrl.replace(/\/+$/, '')}`;
  }

  async load(): Promise<ConeIdentity | null> {
    const raw = await db.getState(this.key);
    if (!raw) return null;
    let parsed: Partial<ConeIdentity>;
    try {
      parsed = JSON.parse(raw) as Partial<ConeIdentity>;
    } catch {
      throw new Error('Stored webhook management identity is invalid');
    }
    if (
      !parsed ||
      typeof parsed.coneId !== 'string' ||
      !parsed.coneId ||
      typeof parsed.coneSecret !== 'string' ||
      !parsed.coneSecret ||
      typeof parsed.rebindSecret !== 'string' ||
      !parsed.rebindSecret
    ) {
      throw new Error('Stored webhook management identity is invalid');
    }
    const pendingSession = parsed.pendingRotation
      ? parseLeaderTraySession(JSON.stringify(parsed.pendingRotation))
      : null;
    const intent = parsed.pendingRotation;
    if (
      intent &&
      (!pendingSession ||
        typeof intent.secret !== 'string' ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(intent.secret) ||
        typeof intent.rebindSecret !== 'string' ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(intent.rebindSecret) ||
        intent.secret === parsed.coneSecret ||
        intent.rebindSecret === parsed.rebindSecret ||
        intent.secret === intent.rebindSecret)
    ) {
      throw new Error('Stored webhook rotation intent is invalid');
    }
    const pendingRotation =
      intent && pendingSession
        ? { ...pendingSession, secret: intent.secret, rebindSecret: intent.rebindSecret }
        : null;
    if (
      (parsed.pendingCreateAttemptId !== undefined &&
        (typeof parsed.pendingCreateAttemptId !== 'string' ||
          !/^[A-Za-z0-9_-]{32,128}$/.test(parsed.pendingCreateAttemptId))) ||
      (parsed.pendingCreateTrayId !== undefined &&
        (!parsed.pendingCreateAttemptId ||
          typeof parsed.pendingCreateTrayId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.pendingCreateTrayId)))
    ) {
      throw new Error('Stored tray creation intent is invalid');
    }
    const identity: ConeIdentity = {
      coneId: parsed.coneId,
      coneSecret: parsed.coneSecret,
      rebindSecret: parsed.rebindSecret,
      established: parsed.established !== false,
      ...(pendingRotation ? { pendingRotation } : {}),
      ...(parsed.pendingCreateAttemptId
        ? { pendingCreateAttemptId: parsed.pendingCreateAttemptId }
        : {}),
      ...(parsed.pendingCreateTrayId ? { pendingCreateTrayId: parsed.pendingCreateTrayId } : {}),
    };
    this.snapshots.set(identity, raw);
    return identity;
  }

  async save(identity: ConeIdentity): Promise<void> {
    const raw = JSON.stringify(identity);
    await db.setState(this.key, raw);
    this.snapshots.set(identity, raw);
  }

  async compareAndSwap(expected: ConeIdentity | null, next: ConeIdentity): Promise<boolean> {
    const snapshot = expected === null ? null : this.snapshots.get(expected);
    if (snapshot === undefined) throw new Error('Webhook identity must be loaded before updating');
    const raw = JSON.stringify(next);
    const replaced = await db.compareAndSetState(this.key, snapshot, raw);
    if (replaced) this.snapshots.set(next, raw);
    return replaced;
  }
}

export async function assertNoStableWebhookHome(storage: Pick<Storage, 'getItem'>): Promise<void> {
  const session = await new IndexedDbLeaderTraySessionStore().load();
  const workerBaseUrl =
    storage.getItem(TRAY_WORKER_STORAGE_KEY) ??
    session?.workerBaseUrl ??
    DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL;
  const identity = await new IndexedDbLeaderWebhookIdentityStore(workerBaseUrl).load();
  if ((identity && identity.established !== false) || (session && coneIdentityOf(session))) {
    throw new Error('webhook delete: stable identity exists but leader is disconnected');
  }
}

export function parseConeWebhookIdentity(
  webhookUrl: string,
  rebindToken: string | undefined
): ConeIdentity | null {
  if (!rebindToken) return null;
  let deliveryToken: string;
  try {
    const segments = new URL(webhookUrl).pathname.split('/').filter(Boolean);
    if (segments.at(-2) !== 'wh') return null;
    deliveryToken = decodeURIComponent(segments.at(-1) ?? '');
  } catch {
    return null;
  }
  const dot = deliveryToken.indexOf('.');
  const rebindDot = rebindToken.indexOf('.');
  if (dot <= 0 || rebindDot <= 0) return null;
  const coneId = deliveryToken.slice(0, dot);
  const coneSecret = deliveryToken.slice(dot + 1);
  const rebindConeId = rebindToken.slice(0, rebindDot);
  const rebindSecret = rebindToken.slice(rebindDot + 1);

  if (
    ![coneId, coneSecret, rebindSecret].every((part) => /^[A-Za-z0-9_-]+$/.test(part)) ||
    rebindConeId !== coneId
  )
    return null;
  return { coneId, coneSecret, rebindSecret };
}

function coneIdentityOf(session: LeaderTraySession): ConeIdentity | null {
  const legacy = session as LeaderTraySession & Partial<ConeIdentity>;
  if (legacy.coneId && legacy.coneSecret && legacy.rebindSecret) {
    return {
      coneId: legacy.coneId,
      coneSecret: legacy.coneSecret,
      rebindSecret: legacy.rebindSecret,
      established: true,
    };
  }
  return null;
}

export function parseLeaderTraySession(raw: string | null): LeaderTraySession | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<LeaderTraySession & ConeIdentity>;
    if (
      typeof parsed.workerBaseUrl !== 'string' ||
      typeof parsed.trayId !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.controllerId !== 'string' ||
      typeof parsed.controllerUrl !== 'string' ||
      typeof parsed.joinUrl !== 'string' ||
      typeof parsed.webhookUrl !== 'string' ||
      typeof parsed.runtime !== 'string'
    ) {
      return null;
    }

    return {
      workerBaseUrl: parsed.workerBaseUrl,
      trayId: parsed.trayId,
      createdAt: parsed.createdAt,
      controllerId: parsed.controllerId,
      controllerUrl: parsed.controllerUrl,
      joinUrl: parsed.joinUrl,
      webhookUrl: parsed.webhookUrl,
      leaderKey: typeof parsed.leaderKey === 'string' ? parsed.leaderKey : undefined,
      leaderWebSocketUrl:
        typeof parsed.leaderWebSocketUrl === 'string' ? parsed.leaderWebSocketUrl : null,
      runtime: parsed.runtime,
      ...(typeof parsed.coneId === 'string' ? { coneId: parsed.coneId } : {}),

      ...(typeof parsed.coneId === 'string' &&
      typeof parsed.coneSecret === 'string' &&
      typeof parsed.rebindSecret === 'string'
        ? {
            coneId: parsed.coneId,
            coneSecret: parsed.coneSecret,
            rebindSecret: parsed.rebindSecret,
          }
        : {}),
    };
  } catch {
    return null;
  }
}

export class LeaderTrayManager {
  private readonly store: LeaderTraySessionStore;
  private readonly identityStore: LeaderWebhookIdentityStore;
  private readonly replacementStore: LeaderTraySessionStore;
  private identity: ConeIdentity | null = null;
  private rotation: Promise<{ webhookUrl: string }> | null = null;
  private starting: Promise<LeaderTraySession> | null = null;
  private resetting: Promise<LeaderTraySession> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: (url: string) => LeaderTrayWebSocket;
  private readonly pingIntervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectEnabled: boolean;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectBackoffMultiplier: number;
  private readonly reconnectMaxAttempts: number;
  private readonly reconnectSlowDelayMs: number;
  private readonly reconnectSleep: (ms: number) => Promise<void>;
  private socket: LeaderTrayWebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private currentSession: LeaderTraySession | null = null;
  private stopped = false;
  private reconnecting = false;
  private reconnectGeneration = 0;
  constructor(private readonly options: LeaderTrayManagerOptions) {
    this.store = options.store ?? new IndexedDbLeaderTraySessionStore();
    this.identityStore =
      options.identityStore ?? new IndexedDbLeaderWebhookIdentityStore(options.workerBaseUrl);
    this.replacementStore =
      options.replacementStore ??
      new IndexedDbLeaderTraySessionStore(
        `leader-tray-replacement:${options.workerBaseUrl.replace(/\/+$/, '')}`
      );
    this.fetchImpl = options.fetchImpl ?? createTrayFetch();
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.pingIntervalMs = options.pingIntervalMs ?? LEADER_TRAY_PING_INTERVAL_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? LEADER_TRAY_CONNECT_TIMEOUT_MS;
    const reconnect = options.reconnect;
    this.reconnectEnabled = reconnect !== false;
    const cfg: LeaderTrayReconnectOptions = reconnect === false || !reconnect ? {} : reconnect;
    this.reconnectBaseDelayMs = cfg.baseDelayMs ?? LEADER_TRAY_RECONNECT_BASE_DELAY_MS;
    this.reconnectMaxDelayMs = cfg.maxDelayMs ?? LEADER_TRAY_RECONNECT_MAX_DELAY_MS;
    this.reconnectBackoffMultiplier =
      cfg.backoffMultiplier ?? LEADER_TRAY_RECONNECT_BACKOFF_MULTIPLIER;
    this.reconnectMaxAttempts = cfg.maxAttempts ?? LEADER_TRAY_RECONNECT_MAX_ATTEMPTS;
    this.reconnectSlowDelayMs = cfg.slowDelayMs ?? LEADER_TRAY_RECONNECT_SLOW_DELAY_MS;
    this.reconnectSleep =
      cfg.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async start(): Promise<LeaderTraySession> {
    if (this.starting !== null) return this.starting;
    const operation = this.startOnce();
    this.starting = operation;
    try {
      return await operation;
    } finally {
      this.starting = null;
    }
  }

  private async startOnce(): Promise<LeaderTraySession> {
    this.stopped = false;
    if (this.currentSession && this.socket) {
      setLeaderTrayRuntimeStatus({ state: 'leader', session: this.currentSession, error: null });
      return this.currentSession;
    }

    setLeaderTrayRuntimeStatus({ state: 'connecting', session: null, error: null });
    this.currentSession = null;

    try {
      const session = await this.connectOnce();
      log.info('Leader joined tray', {
        trayId: session.trayId,
        controllerId: session.controllerId,
        runtime: session.runtime,
      });
      try {
        this.options.onLeaderReady?.(session);
      } catch (error) {
        log.warn('onLeaderReady callback threw', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return session;
    } catch (error) {
      setLeaderTrayRuntimeStatus({
        state: 'error',
        session: this.currentSession,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  stop(): void {
    this.stopped = true;
    this.reconnecting = false;
    this.reconnectGeneration++;
    this.tearDownSocket();

    this.currentSession = null;
    setLeaderTrayRuntimeStatus({ state: 'inactive', session: null, error: null });
  }

  private tearDownSocket(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {}
    }
  }

  private async connectOnce(): Promise<LeaderTraySession> {
    if (this.rotation !== null) await this.rotation;
    this.identity = await this.identityStore.load();

    if (this.identity?.pendingRotation) {
      try {
        await this.rotateWebhookOnce();
      } catch (error) {
        if (!isDefinitiveRotationRefusal(error)) throw error;
        if (this.identity?.pendingRotation) {
          throw new Error('Webhook rotation changed in another tab; retry before reconnecting');
        }
      }
    }
    const storedSession = await this.store.load();
    const reusableSession =
      storedSession?.workerBaseUrl.replace(/\/+$/, '') ===
      this.options.workerBaseUrl.replace(/\/+$/, '')
        ? storedSession
        : null;

    const legacy = reusableSession && coneIdentityOf(reusableSession);
    if (!this.identity && legacy) await this.saveIdentity(legacy);

    const safeSession = reusableSession && this.publicSession(reusableSession);
    if (safeSession && legacy) await this.store.save(safeSession);
    await this.finishPendingCreate(safeSession);

    const pendingSource = await this.replacementStore.load();
    const session = pendingSource
      ? await this.claimReplacement(pendingSource, safeSession)
      : await this.attachWithRecovery(safeSession);
    this.currentSession = session;
    const socket = await this.openLeaderSocket(session.leaderWebSocketUrl!);
    this.socket = socket;
    this.startPingLoop(socket);
    setLeaderTrayRuntimeStatus({ state: 'leader', session, error: null });
    return session;
  }

  private async handleUnexpectedDisconnect(reason: string): Promise<void> {
    if (this.stopped) return;
    if (!this.reconnectEnabled) {
      log.warn('Leader WebSocket dropped and auto-reconnect is disabled', { reason });
      this.tearDownSocket();
      this.currentSession = null;
      setLeaderTrayRuntimeStatus({
        state: 'error',
        session: null,
        error: `Leader WebSocket dropped: ${reason}`,
      });
      return;
    }
    if (this.reconnecting) return;
    this.reconnecting = true;
    const generation = ++this.reconnectGeneration;

    log.warn('Leader WebSocket dropped — starting reconnect loop', { reason });
    this.tearDownSocket();

    let attempt = 0;
    let delay = this.reconnectBaseDelayMs;
    let lastError = reason;
    const isCurrent = () => !this.stopped && generation === this.reconnectGeneration;

    while (isCurrent()) {
      attempt++;
      const gaveUp = attempt > this.reconnectMaxAttempts;
      if (!gaveUp) {
        setLeaderTrayRuntimeStatus({
          state: 'reconnecting',
          session: this.currentSession,
          error: null,
          reconnectAttempts: attempt,
        });
        this.options.onReconnecting?.(attempt, lastError);
      }

      log.info('Leader reconnect attempt', { attempt, delay });
      await this.reconnectSleep(gaveUp ? this.reconnectSlowDelayMs : delay);
      if (!isCurrent()) break;

      const outcome = await this.tryReconnect(attempt, isCurrent);
      if (outcome.done) return;
      lastError = outcome.error;

      if (attempt === this.reconnectMaxAttempts) this.reportReconnectGaveUp(attempt, lastError);
      delay = Math.min(delay * this.reconnectBackoffMultiplier, this.reconnectMaxDelayMs);
    }
  }

  private async tryReconnect(
    attempt: number,
    isCurrent: () => boolean
  ): Promise<{ done: true } | { done: false; error: string }> {
    try {
      const session = await this.connectOnce();
      if (!isCurrent()) {
        this.tearDownSocket();
        return { done: true };
      }
      this.reconnecting = false;
      log.info('Leader reconnect successful', { attempt, trayId: session.trayId });
      this.options.onReconnected?.(session);
      try {
        this.options.onLeaderReady?.(session);
      } catch (error) {
        log.warn('onLeaderReady callback threw', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { done: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Leader reconnect attempt failed', { attempt, error: message });
      this.tearDownSocket();
      return { done: false, error: message };
    }
  }

  private reportReconnectGaveUp(attempts: number, lastError: string): void {
    this.currentSession = null;
    setLeaderTrayRuntimeStatus({
      state: 'error',
      session: null,
      error: `Leader reconnect failed after ${attempts} attempts: ${lastError}`,
      reconnectAttempts: attempts,
    });
    log.warn('Leader reconnect gave up; retrying slowly', {
      attempts,
      lastError,
      slowDelayMs: this.reconnectSlowDelayMs,
    });
    this.options.onReconnectGaveUp?.(lastError, attempts);
  }

  async clearSession(): Promise<void> {
    if (this.rotation !== null) await this.rotation;
    if (await this.replacementStore.load()) {
      throw new Error('Tray replacement is pending; retry reset before clearing the session');
    }
    await this.finishPendingCreate(await this.store.load());
    await this.store.clear();
  }

  async reset(): Promise<LeaderTraySession> {
    if (this.resetting !== null) return this.resetting;
    const operation = this.resetOnce();
    this.resetting = operation;
    try {
      return await operation;
    } finally {
      this.resetting = null;
    }
  }

  private async resetOnce(): Promise<LeaderTraySession> {
    if (this.starting !== null) await this.starting;
    if (this.rotation !== null) await this.rotation;
    const pending = await this.replacementStore.load();
    if (!pending && this.currentSession) {
      await this.replacementStore.save(this.currentSession);
    }
    this.stop();
    return this.start();
  }

  private async claimReplacement(
    source: LeaderTraySession,
    target: LeaderTraySession | null,
    recoverExpiredOwner = true
  ): Promise<LeaderTraySession> {
    let next = target && target.trayId !== source.trayId ? target : await this.createTraySession();
    try {
      await this.transferPreviousSession(source, next);
    } catch (error) {
      if (!(error instanceof LeaderTrayHttpError) || error.code !== 'PREVIEW_TARGET_UNAVAILABLE') {
        throw error;
      }
      await this.finishPendingCreate(await this.store.load());
      await this.store.clear();
      next = await this.createTraySession();
      await this.transferPreviousSession(source, next);
    }
    let claimed: LeaderTraySession;
    try {
      claimed = await this.claimLeaderSession(next);
    } catch (error) {
      if (error instanceof LeaderTrayHttpError && [403, 404, 410].includes(error.status)) {
        await this.replacementStore.save(next);
        await this.finishPendingCreate(await this.store.load());
        await this.store.clear();
        if (recoverExpiredOwner) return this.claimReplacement(next, null, false);
      }
      throw error;
    }

    await this.replacementStore.clear();
    void this.notifyTraySuperseded(source, claimed.joinUrl, claimed.webhookUrl);
    return claimed;
  }

  async transferPreviousSession(
    source: LeaderTraySession,
    target: LeaderTraySession
  ): Promise<void> {
    if (source.trayId === target.trayId) return;

    if (this.identity?.established === false) return;
    const controllerToken = new URL(source.controllerUrl).pathname.split('/').pop();
    const targetControllerToken = new URL(target.controllerUrl).pathname.split('/').pop();
    if (!controllerToken || !targetControllerToken) {
      throw new Error('Preview transfer requires controller credentials');
    }
    const result = await this.fetchJson<{ transferred: boolean }>(
      buildTrayWorkerUrl(source.workerBaseUrl, `api/tray/${source.trayId}/preview-transfer`),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({ targetTrayId: target.trayId, targetControllerToken }),
      }
    );
    if (result.transferred !== true) throw new Error('Hub did not confirm preview transfer');
  }

  private async saveIdentity(identity: ConeIdentity): Promise<void> {
    await this.identityStore.save(identity);
    this.identity = identity;
  }

  private publicSession(session: LeaderTraySession): LeaderTraySession {
    const {
      coneSecret: _secret,
      rebindSecret: _rebind,
      ...safe
    } = session as LeaderTraySession & Partial<ConeIdentity>;
    if (this.identity?.established && safe.coneId === this.identity.coneId) {
      safe.webhookUrl = buildTrayWorkerUrl(
        this.options.workerBaseUrl,
        `wh/${this.identity.coneId}.${this.identity.coneSecret}`
      );
    }
    return safe;
  }

  getCurrentSession(): LeaderTraySession | null {
    return this.currentSession;
  }

  async rotateWebhook(): Promise<{ webhookUrl: string }> {
    if (this.resetting !== null || this.starting !== null || this.reconnecting) {
      throw new Error('webhook rotate: tray transition in progress; retry when ready');
    }
    if (this.rotation !== null) return this.rotation;
    const operation = this.rotateWebhookOnce();
    this.rotation = operation;
    try {
      return await operation;
    } finally {
      this.rotation = null;
    }
  }

  private async rotateWebhookOnce(): Promise<{ webhookUrl: string }> {
    this.identity = await this.identityStore.load();
    const session = this.identity?.pendingRotation ?? this.currentSession;
    if (!session) {
      throw new Error('webhook rotate: no active tray session');
    }
    let currentIdentity = this.identity;
    if (!currentIdentity || currentIdentity.established === false) {
      throw new Error(
        'webhook rotate: this tray has no stable webhook identity to rotate (legacy hub)'
      );
    }
    if (
      session.workerBaseUrl.replace(/\/+$/, '') !== this.options.workerBaseUrl.replace(/\/+$/, '')
    ) {
      throw new Error('webhook rotate: pending identity belongs to a different hub');
    }
    const controllerToken = new URL(session.controllerUrl).pathname.split('/').pop();
    if (!controllerToken) {
      throw new Error('webhook rotate: could not derive the controller token');
    }
    if (!currentIdentity.pendingRotation) {
      const intent = {
        ...currentIdentity,
        pendingRotation: {
          ...session,
          secret: crypto.randomUUID().replace(/-/g, ''),
          rebindSecret: crypto.randomUUID().replace(/-/g, ''),
        },
      };
      if (!(await this.identityStore.compareAndSwap(currentIdentity, intent))) {
        throw new Error('webhook rotate: identity changed in another tab; retry');
      }
      this.identity = currentIdentity = intent;
    }
    const rotateUrl = buildTrayWorkerUrl(
      session.workerBaseUrl,
      `api/tray/${session.trayId}/webhook/rotate`
    );
    const rotated = await this.fetchJson<{
      coneId: string;
      webhook: { url: string; rebindToken: string };
    }>(rotateUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${controllerToken}`,
      },
      body: JSON.stringify({
        oldConeId: currentIdentity.coneId,
        oldSecret: currentIdentity.coneSecret,
        oldRebindSecret: currentIdentity.rebindSecret,
        secret: currentIdentity.pendingRotation!.secret,
        rebindSecret: currentIdentity.pendingRotation!.rebindSecret,
      }),
    }).catch(async (error: unknown) => {
      if (isDefinitiveRotationRefusal(error)) {
        const { pendingRotation: _pending, ...retained } = currentIdentity;
        await this.identityStore.compareAndSwap(currentIdentity, retained);
        this.identity = await this.identityStore.load();
      }
      throw error;
    });

    const identity = parseConeWebhookIdentity(rotated.webhook.url, rotated.webhook.rebindToken);
    if (!identity) {
      throw new Error('webhook rotate: hub returned an unparseable webhook capability');
    }
    if (
      identity.coneId !== currentIdentity.coneId ||
      identity.coneSecret !== currentIdentity.pendingRotation!.secret ||
      identity.rebindSecret !== currentIdentity.pendingRotation!.rebindSecret
    ) {
      throw new Error('webhook rotate: hub changed the management identity');
    }
    const { pendingRotation: _pending, ...retained } = currentIdentity;
    const completed = { ...retained, ...identity, established: true };
    if (!(await this.identityStore.compareAndSwap(currentIdentity, completed))) {
      this.identity = await this.identityStore.load();
      throw new Error('webhook rotate: identity changed in another tab; retry');
    }
    this.identity = completed;

    const publicSession = parseLeaderTraySession(JSON.stringify(session))!;
    const next: LeaderTraySession = {
      ...publicSession,
      webhookUrl: rotated.webhook.url,
      coneId: identity.coneId,
    };
    if ((await this.store.load())?.trayId === session.trayId) await this.store.save(next);
    if (this.currentSession === session) {
      this.currentSession = next;
      setLeaderTrayRuntimeStatus({ state: 'leader', session: next, error: null });
    }
    return { webhookUrl: rotated.webhook.url };
  }

  async revokeWebhook(webhookId: string): Promise<void> {
    if (!webhookId) throw new Error('webhook delete: missing webhook id');
    if (this.resetting !== null || this.starting !== null || this.reconnecting) {
      throw new Error('webhook delete: tray transition in progress; retry when ready');
    }
    const session = this.currentSession;
    const identity = this.identity ?? (await this.identityStore.load());
    if (!identity || identity.established === false) return;
    if (!session)
      throw new Error('webhook delete: stable identity exists but leader is disconnected');
    const controllerToken = new URL(session.controllerUrl).pathname.split('/').pop();
    if (!controllerToken) throw new Error('webhook delete: missing controller credentials');
    await this.fetchJson(
      buildTrayWorkerUrl(
        session.workerBaseUrl,
        `webhooks/${encodeURIComponent(identity.coneId)}/${encodeURIComponent(webhookId)}/revoke`
      ),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rebindSecret: identity.rebindSecret,
          trayId: session.trayId,
          controllerToken,
        }),
      }
    );
  }

  supersedePreviousSession(
    oldSession: LeaderTraySession,
    next: { joinUrl: string; webhookUrl: string }
  ): void {
    if (oldSession.trayId === '' || next.joinUrl === oldSession.joinUrl) return;
    void this.notifyTraySuperseded(oldSession, next.joinUrl, next.webhookUrl);
  }

  carryConeIdentityFrom(oldSession: LeaderTraySession): void {
    void oldSession;
  }

  sendControlMessage(message: LeaderToWorkerControlMessage): void {
    if (!this.socket) {
      throw new Error('Tray leader WebSocket is not connected');
    }
    this.socket.send(JSON.stringify(message));
  }

  private async attachWithRecovery(session: LeaderTraySession | null): Promise<LeaderTraySession> {
    try {
      return await this.claimLeaderSession(session);
    } catch (error) {
      if (!session || !shouldRecreateTray(error)) {
        throw error;
      }

      log.warn('Stored tray session is stale, creating a fresh tray', {
        trayId: session.trayId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.replacementStore.save(session);
      await this.finishPendingCreate(await this.store.load());
      await this.store.clear();
      return this.claimReplacement(session, null);
    }
  }

  private async notifyTraySuperseded(
    oldSession: LeaderTraySession,
    newJoinUrl: string,
    newWebhookUrl?: string
  ): Promise<void> {
    try {
      const controllerToken = new URL(oldSession.controllerUrl).pathname.split('/').pop();
      if (!controllerToken) return;
      const supersedeUrl = buildTrayWorkerUrl(
        oldSession.workerBaseUrl,
        `api/tray/${oldSession.trayId}/supersede`
      );
      const response = await this.fetchImpl(supersedeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({
          joinUrl: newJoinUrl,
          ...(newWebhookUrl ? { webhookUrl: newWebhookUrl } : {}),
        }),
        signal: AbortSignal.timeout(NOTIFY_SUPERSEDED_TIMEOUT_MS),
      });
      if (!response.ok) {
        log.warn('Old tray rejected supersession (best-effort)', {
          oldTrayId: oldSession.trayId,
          status: response.status,
        });
      }
    } catch {
      log.warn('Failed to notify old tray of supersession (best-effort)', {
        oldTrayId: oldSession.trayId,
      });
    }
  }

  private async claimLeaderSession(session: LeaderTraySession | null): Promise<LeaderTraySession> {
    const activeSession = session ?? (await this.createTraySession());
    const attach = await this.fetchJson<ControllerAttachResponse>(activeSession.controllerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        controllerId: activeSession.controllerId,
        leaderKey: activeSession.leaderKey,
        runtime: this.options.runtime,
      }),
    });

    if (attach.role !== 'leader' || !attach.leaderKey || !attach.websocket?.url) {
      throw new Error(
        `Tray attach did not return leader access for controller ${attach.controllerId}`
      );
    }

    const claimedSession: LeaderTraySession = {
      ...activeSession,
      trayId: attach.trayId,
      controllerId: attach.controllerId,
      leaderKey: attach.leaderKey,
      leaderWebSocketUrl: attach.websocket.url,
      runtime: this.options.runtime,
    };

    await this.store.save(claimedSession);
    return claimedSession;
  }

  private async finishPendingCreate(session: LeaderTraySession | null): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.identityStore.load();
      if (
        !session ||
        !current?.pendingCreateTrayId ||
        current.pendingCreateTrayId !== session.trayId
      )
        return;
      const next = { ...current };
      delete next.pendingCreateAttemptId;
      delete next.pendingCreateTrayId;
      if (await this.identityStore.compareAndSwap(current, next)) {
        this.identity = next;
        return;
      }
    }
    throw new Error('Webhook identity changed while acknowledging tray creation');
  }

  private async prepareCreateIdentity(): Promise<ConeIdentity> {
    await this.finishPendingCreate(await this.store.load());
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.identityStore.load();
      if (current?.pendingRotation) {
        throw new Error('Webhook rotation must finish before tray creation');
      }
      if (current?.pendingCreateAttemptId) return current;
      const next: ConeIdentity = {
        ...(current ?? {
          coneId: crypto.randomUUID(),
          coneSecret: crypto.randomUUID().replace(/-/g, ''),
          rebindSecret: crypto.randomUUID().replace(/-/g, ''),
          established: false,
        }),
        pendingCreateAttemptId: crypto.randomUUID(),
      };
      if (await this.identityStore.compareAndSwap(current, next)) return next;
    }
    throw new Error('Webhook identity changed while preparing tray creation');
  }

  private async createTraySession(): Promise<LeaderTraySession> {
    const carry = await this.prepareCreateIdentity();
    this.identity = carry;
    const body = JSON.stringify({
      ...(this.options.kind ? { kind: this.options.kind } : {}),
      coneId: carry.coneId,
      coneSecret: carry.coneSecret,
      rebindSecret: carry.rebindSecret,
      createAttemptId: carry.pendingCreateAttemptId,
    });
    const created = await this.fetchJson<CreateTrayResponse>(
      buildTrayWorkerUrl(this.options.workerBaseUrl, 'tray'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }
    );

    const coneIdentity = parseConeWebhookIdentity(
      created.capabilities.webhook.url,
      created.capabilities.webhook.rebindToken
    );
    if (coneIdentity) {
      if (
        coneIdentity.coneId !== carry.coneId ||
        coneIdentity.coneSecret !== carry.coneSecret ||
        coneIdentity.rebindSecret !== carry.rebindSecret
      ) {
        throw new Error('Hub returned a different webhook management identity');
      }
    } else if (
      carry.established ||
      created.capabilities.webhook.rebindToken ||
      new URL(created.capabilities.webhook.url).pathname.includes('/wh/')
    ) {
      throw new Error('Hub did not confirm the stable webhook binding');
    }

    const session: LeaderTraySession = {
      workerBaseUrl: this.options.workerBaseUrl,
      trayId: created.trayId,
      createdAt: created.createdAt,
      controllerId: crypto.randomUUID(),
      controllerUrl: created.capabilities.controller.url,
      joinUrl: created.capabilities.join.url,
      webhookUrl: created.capabilities.webhook.url,
      runtime: this.options.runtime,
      ...(coneIdentity ? { coneId: coneIdentity.coneId } : {}),
    };

    const acknowledged: ConeIdentity = {
      ...carry,
      established: coneIdentity ? true : carry.established,
      pendingCreateTrayId: session.trayId,
    };
    if (!(await this.identityStore.compareAndSwap(carry, acknowledged))) {
      throw new Error('Webhook identity changed during tray creation');
    }
    this.identity = acknowledged;

    await this.store.save(session);
    await this.finishPendingCreate(session);
    return session;
  }

  private async openLeaderSocket(url: string): Promise<LeaderTrayWebSocket> {
    return await new Promise((resolve, reject) => {
      const socket = this.webSocketFactory(url);
      let settled = false;
      const timeout = setTimeout(() => {
        fail(
          `Tray leader WebSocket timed out after ${this.connectTimeoutMs}ms waiting for leader.connected`
        );
        try {
          socket.close(1000, 'leader.connected timeout');
        } catch {}
      }, this.connectTimeoutMs);

      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(reason));
      };

      socket.addEventListener('message', (event) => {
        const payload = parseSocketMessage(event.data);
        if (!payload) return;

        if (payload.type === 'leader.connected') {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve(socket);
          }
          return;
        }

        if (payload.type === 'pong') {
          log.debug('Tray leader heartbeat acknowledged', { trayId: this.currentSession?.trayId });
          return;
        }

        this.options.onControlMessage?.(payload);
      });
      socket.addEventListener('close', () =>
        fail('Tray leader WebSocket closed before leader.connected')
      );
      socket.addEventListener('error', () =>
        fail('Tray leader WebSocket failed before leader.connected')
      );
    });
  }

  private startPingLoop(socket: LeaderTrayWebSocket): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }

    const onSocketDown = (reason: string) => {
      if (this.stopped || this.socket !== socket) return;
      this.handleUnexpectedDisconnect(reason).catch((error) => {
        log.warn('Leader reconnect loop crashed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    const sendPing = () => {
      try {
        socket.send(JSON.stringify({ type: 'ping' }));
      } catch (error) {
        onSocketDown(
          `Leader ping send failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };

    sendPing();
    this.pingTimer = setInterval(sendPing, this.pingIntervalMs);
    socket.addEventListener('close', () => onSocketDown('Leader WebSocket closed'));
    socket.addEventListener('error', () => onSocketDown('Leader WebSocket errored'));
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(20_000),
    }).catch((error: unknown) => {
      if (error instanceof TrayProxyFetchError) {
        throw new TrayProxyFetchError('Tray proxy transport unavailable');
      }
      throw new Error('Tray request failed (transport unavailable)');
    });
    if (!response.ok) {
      throw await LeaderTrayHttpError.fromResponse(response);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error('Hub returned invalid JSON');
    }
  }
}

class LeaderTrayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string
  ) {
    super(message);
    this.name = 'LeaderTrayHttpError';
  }

  static async fromResponse(response: Response): Promise<LeaderTrayHttpError> {
    try {
      const payload = (await response.json()) as { error?: string; code?: string };
      return new LeaderTrayHttpError(
        response.status,
        payload.code ?? null,
        `Tray request failed (${response.status})`
      );
    } catch {
      return new LeaderTrayHttpError(
        response.status,
        null,
        `Tray request failed (${response.status})`
      );
    }
  }
}

function isDefinitiveRotationRefusal(error: unknown): boolean {
  return (
    error instanceof LeaderTrayHttpError &&
    [400, 401, 403, 404, 405, 410, 422].includes(error.status)
  );
}

function shouldRecreateTray(error: unknown): boolean {
  if (error instanceof TrayProxyFetchError) return true;
  if (error instanceof LeaderTrayHttpError) {
    return (
      error.status === 403 || error.status === 404 || error.status === 410 || error.status >= 500
    );
  }
  return false;
}

function parseSocketMessage(data: unknown): WorkerToLeaderControlMessage | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as WorkerToLeaderControlMessage;
  } catch {
    return null;
  }
}
