import type { LeaderToWorkerControlMessage, WorkerToLeaderControlMessage } from '@slicc/shared-ts';
import { createLogger } from '../core/logger.js';
import { isProxyError, readProxyErrorMessage } from '../core/proxy-error.js';
import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';
import * as db from './db.js';
import { buildTrayWorkerUrl } from './tray-runtime-config.js';

/**
 * Mirrors TrayKind in packages/cloudflare-worker/src/shared.ts.
 * Keep these in sync — TrayRecord.kind is the protocol field.
 */
export type TrayKind = 'desktop' | 'hosted';

const log = createLogger('tray-leader');
const LEADER_TRAY_STATE_KEY = 'leader-tray-session';
const LEADER_TRAY_PING_INTERVAL_MS = 30_000;
const LEADER_TRAY_CONNECT_TIMEOUT_MS = 10_000;
const LEADER_TRAY_RECONNECT_BASE_DELAY_MS = 1_000;
const LEADER_TRAY_RECONNECT_MAX_DELAY_MS = 30_000;
const LEADER_TRAY_RECONNECT_BACKOFF_MULTIPLIER = 2;
const LEADER_TRAY_RECONNECT_MAX_ATTEMPTS = 20;

interface CreateTrayResponse {
  trayId: string;
  createdAt: string;
  capabilities: {
    join: { url: string };
    controller: { url: string };
    webhook: { url: string };
  };
}

interface ControllerAttachResponse {
  trayId: string;
  controllerId: string;
  role: 'leader' | 'follower';
  leaderKey?: string;
  websocket?: { url: string } | null;
}

export interface LeaderTraySession {
  workerBaseUrl: string;
  trayId: string;
  createdAt: string;
  controllerId: string;
  controllerUrl: string;
  joinUrl: string;
  webhookUrl: string;
  leaderKey?: string;
  leaderWebSocketUrl?: string | null;
  runtime: string;
}

export interface LeaderTrayRuntimeStatus {
  state: 'inactive' | 'connecting' | 'leader' | 'reconnecting' | 'error';
  session: LeaderTraySession | null;
  error: string | null;
  reconnectAttempts?: number;
}

let leaderTrayRuntimeStatus: LeaderTrayRuntimeStatus = {
  state: 'inactive',
  session: null,
  error: null,
};

export function getLeaderTrayRuntimeStatus(): LeaderTrayRuntimeStatus {
  return {
    ...leaderTrayRuntimeStatus,
    session: leaderTrayRuntimeStatus.session ? { ...leaderTrayRuntimeStatus.session } : null,
  };
}

/**
 * Key for the page→worker `localStorage` shim mirroring the leader tray
 * status. `main.ts` writes this on every `subscribeToLeaderTrayRuntimeStatus`
 * tick; `installPageStorageSync` forwards page-side writes into the kernel
 * worker's Map-backed `localStorage` shim so worker readers see the same
 * value.
 */
export const LEADER_STATUS_STORAGE_KEY = 'slicc.leaderTrayStatus';

/**
 * Leader tray status with a `localStorage` fallback for the standalone
 * kernel-worker thread: when the worker's own module global is `inactive`
 * (because the page is the only side that actually runs `LeaderTrayManager`),
 * read the shim value that `main.ts` keeps current via
 * `subscribeToLeaderTrayRuntimeStatus`. Extension mode keeps the module
 * global as the source of truth because the offscreen runs the manager.
 *
 * Shared by `host-command.ts` and the `/licks-ws` `tray_status` reply so
 * `host`, `host reset/leave`, and the node-server's `/api/tray-status`
 * agree on what the leader status is.
 */
export function getLeaderStatusWithFallback(): LeaderTrayRuntimeStatus {
  const moduleStatus = getLeaderTrayRuntimeStatus();
  if (moduleStatus.state !== 'inactive') return moduleStatus;
  try {
    const stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      LEADER_STATUS_STORAGE_KEY
    );
    if (stored) {
      const parsed = JSON.parse(stored) as LeaderTrayRuntimeStatus;
      if (parsed?.state && parsed.state !== 'inactive') return parsed;
    }
  } catch {
    // ignore parse errors
  }
  return moduleStatus;
}

type LeaderTrayRuntimeStatusListener = (status: LeaderTrayRuntimeStatus) => void;
const leaderTrayRuntimeStatusListeners = new Set<LeaderTrayRuntimeStatusListener>();

/**
 * Subscribe to leader tray status changes. Called synchronously after
 * each update with the new (deep-copied) status. Returns an unsubscribe
 * function. The extension offscreen runtime uses this to mirror status
 * into the side-panel context, where the avatar popover lives.
 */
export function subscribeToLeaderTrayRuntimeStatus(
  listener: LeaderTrayRuntimeStatusListener
): () => void {
  leaderTrayRuntimeStatusListeners.add(listener);
  return () => {
    leaderTrayRuntimeStatusListeners.delete(listener);
  };
}

/**
 * Replace the leader tray status singleton and notify subscribers.
 * Exported so the extension panel can mirror updates pushed from the
 * offscreen document; the local manager calls this internally too.
 *
 * Each listener receives a fresh deep-copied snapshot so a listener
 * that mutates its argument can't change what later listeners observe.
 * Iterating a copy of the listener set means an unsubscribe / subscribe
 * during dispatch doesn't perturb the in-flight delivery either.
 */
export function setLeaderTrayRuntimeStatus(status: LeaderTrayRuntimeStatus): void {
  leaderTrayRuntimeStatus = {
    ...status,
    session: status.session ? { ...status.session } : null,
  };
  if (leaderTrayRuntimeStatusListeners.size === 0) return;
  for (const listener of [...leaderTrayRuntimeStatusListeners]) {
    try {
      listener(getLeaderTrayRuntimeStatus());
    } catch {
      // Listener errors must not break the manager's state machine.
    }
  }
}

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
  /** Base delay in ms before the first reconnect attempt. Default: 1000. */
  baseDelayMs?: number;
  /** Multiplier applied to the delay after each failed attempt. Default: 2. */
  backoffMultiplier?: number;
  /** Maximum delay between reconnect attempts in ms. Default: 30000. */
  maxDelayMs?: number;
  /** Maximum number of reconnect attempts before giving up. Default: 20. */
  maxAttempts?: number;
  /** Sleep implementation for testing. Default: setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
}

export interface LeaderTrayManagerOptions {
  workerBaseUrl: string;
  runtime: string;
  store?: LeaderTraySessionStore;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => LeaderTrayWebSocket;
  onControlMessage?: (message: WorkerToLeaderControlMessage) => void;
  pingIntervalMs?: number;
  connectTimeoutMs?: number;
  /** Reconnect options. If omitted, auto-reconnect is enabled with defaults. Pass `false` to disable. */
  reconnect?: LeaderTrayReconnectOptions | false;
  /** Called when the leader WebSocket dies and a reconnect attempt is starting. */
  onReconnecting?: (attempt: number, lastError: string) => void;
  /** Called when reconnect succeeds with a (possibly identical) session. */
  onReconnected?: (session: LeaderTraySession) => void;
  /** Called when reconnection fails permanently (max attempts exhausted). */
  onReconnectGaveUp?: (lastError: string, attempts: number) => void;
  /**
   * Called after the leader successfully connects to the tray, both on initial
   * start() AND on every successful reconnect. Does NOT fire when start() is
   * called on an already-active session (no transition from disconnected to connected).
   */
  onLeaderReady?: (session: LeaderTraySession) => void;
  /** Persisted on the tray; controls reclaim TTL on the worker. */
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

export function parseLeaderTraySession(raw: string | null): LeaderTraySession | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<LeaderTraySession>;
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
    };
  } catch {
    return null;
  }
}

export class LeaderTrayManager {
  private readonly store: LeaderTraySessionStore;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: (url: string) => LeaderTrayWebSocket;
  private readonly pingIntervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectEnabled: boolean;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectBackoffMultiplier: number;
  private readonly reconnectMaxAttempts: number;
  private readonly reconnectSleep: (ms: number) => Promise<void>;
  private socket: LeaderTrayWebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private currentSession: LeaderTraySession | null = null;
  private stopped = false;
  private reconnecting = false;
  private reconnectGeneration = 0;

  constructor(private readonly options: LeaderTrayManagerOptions) {
    this.store = options.store ?? new IndexedDbLeaderTraySessionStore();
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
    this.reconnectSleep =
      cfg.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async start(): Promise<LeaderTraySession> {
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

    // Clear `this.socket` BEFORE calling close(): some socket implementations
    // (and our test fakes) emit 'close' synchronously from `close()`, which
    // would re-enter `handleUnexpectedDisconnect` via the ping-loop close
    // listener. The listener guards on `this.socket !== socket`, so once we
    // null out `this.socket` here, the synchronous re-entry is a no-op.
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Ignore teardown failures.
      }
    }
  }

  /**
   * Run a single attach + WebSocket open cycle. On success, sets `socket`,
   * `currentSession`, and runtime status, and starts the ping loop. The
   * caller is responsible for surfacing errors.
   */
  private async connectOnce(): Promise<LeaderTraySession> {
    const storedSession = await this.store.load();
    const reusableSession =
      storedSession?.workerBaseUrl === this.options.workerBaseUrl ? storedSession : null;

    const session = await this.attachWithRecovery(reusableSession);
    this.currentSession = session;
    const socket = await this.openLeaderSocket(session.leaderWebSocketUrl!);
    this.socket = socket;
    this.startPingLoop(socket);
    setLeaderTrayRuntimeStatus({ state: 'leader', session, error: null });
    return session;
  }

  /**
   * Handle an unexpected socket close/error after a successful start.
   * Tears the existing socket down, then runs a backoff loop to re-attach
   * and reopen the leader WebSocket. Stays a no-op once `stop()` has been
   * called or when reconnect is disabled.
   */
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

    while (
      !this.stopped &&
      generation === this.reconnectGeneration &&
      attempt < this.reconnectMaxAttempts
    ) {
      attempt++;
      setLeaderTrayRuntimeStatus({
        state: 'reconnecting',
        session: this.currentSession,
        error: null,
        reconnectAttempts: attempt,
      });
      this.options.onReconnecting?.(attempt, lastError);

      log.info('Leader reconnect attempt', { attempt, delay });
      await this.reconnectSleep(delay);
      if (this.stopped || generation !== this.reconnectGeneration) break;

      try {
        const session = await this.connectOnce();
        if (this.stopped || generation !== this.reconnectGeneration) {
          this.tearDownSocket();
          break;
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
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        log.warn('Leader reconnect attempt failed', { attempt, error: lastError });
        this.tearDownSocket();
      }

      delay = Math.min(delay * this.reconnectBackoffMultiplier, this.reconnectMaxDelayMs);
    }

    if (!this.stopped && generation === this.reconnectGeneration) {
      this.reconnecting = false;
      this.currentSession = null;
      setLeaderTrayRuntimeStatus({
        state: 'error',
        session: null,
        error: `Leader reconnect failed after ${attempt} attempts: ${lastError}`,
        reconnectAttempts: attempt,
      });
      log.warn('Leader reconnect gave up', { attempts: attempt, lastError });
      this.options.onReconnectGaveUp?.(lastError, attempt);
    }
  }

  async clearSession(): Promise<void> {
    await this.store.clear();
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
      await this.store.clear();
      const fresh = await this.claimLeaderSession(null);
      // Best-effort: point any follower still holding the old join link at the
      // new tray. Failure here never fails the reconnect — a crashed leader
      // (no chance to run this) just falls back to the existing TRAY_EXPIRED
      // path once the old tray's reclaim TTL elapses.
      await this.notifyTraySuperseded(session, fresh.joinUrl);
      return fresh;
    }
  }

  /**
   * Tell the OLD tray's Durable Object that it has been superseded by `newJoinUrl`,
   * so a follower still holding the old `/join/:token` link gets redirected
   * instead of dead-ending on FOLLOWER_JOIN_NOT_READY / TRAY_EXPIRED forever.
   * Bearer = the old session's controllerToken (extracted from `controllerUrl`).
   */
  private async notifyTraySuperseded(
    oldSession: LeaderTraySession,
    newJoinUrl: string
  ): Promise<void> {
    try {
      const controllerToken = oldSession.controllerUrl.split('/').pop();
      if (!controllerToken) return;
      const supersedeUrl = buildTrayWorkerUrl(
        oldSession.workerBaseUrl,
        `api/tray/${oldSession.trayId}/supersede`
      );
      await this.fetchImpl(supersedeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({ joinUrl: newJoinUrl }),
      });
    } catch (error) {
      log.warn('Failed to notify old tray of supersession (best-effort)', {
        oldTrayId: oldSession.trayId,
        error: error instanceof Error ? error.message : String(error),
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

  private async createTraySession(): Promise<LeaderTraySession> {
    const body = this.options.kind ? JSON.stringify({ kind: this.options.kind }) : undefined;
    const created = await this.fetchJson<CreateTrayResponse>(
      buildTrayWorkerUrl(this.options.workerBaseUrl, 'tray'),
      {
        method: 'POST',
        ...(body ? { headers: { 'content-type': 'application/json' } } : {}),
        ...(body ? { body } : {}),
      }
    );

    return {
      workerBaseUrl: this.options.workerBaseUrl,
      trayId: created.trayId,
      createdAt: created.createdAt,
      controllerId: crypto.randomUUID(),
      controllerUrl: created.capabilities.controller.url,
      joinUrl: created.capabilities.join.url,
      webhookUrl: created.capabilities.webhook.url,
      runtime: this.options.runtime,
    };
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
        } catch {
          // Ignore best-effort socket teardown.
        }
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
      // Only trigger if this is still our active socket and we haven't been stopped.
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
    const response = await this.fetchImpl(url, init);
    if (!response.ok) {
      throw await LeaderTrayHttpError.fromResponse(response);
    }
    return (await response.json()) as T;
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
        payload.error ?? `Tray request failed (${response.status})`
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

/**
 * Thrown by {@link createTrayFetch} when the node-server `/api/fetch-proxy`
 * itself failed to reach the tray worker (a tagged proxy/transport error, not a
 * real upstream HTTP status). Typed so `shouldRecreateTray` can recognise it
 * and mint a fresh tray instead of leaving the leader inactive — a dead stored
 * tray surfaces here as "Proxy fetch failed", not as a LeaderTrayHttpError.
 */
export class TrayProxyFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrayProxyFetchError';
  }
}

function shouldRecreateTray(error: unknown): boolean {
  // A stored tray session is just a cache. If reusing it fails because the tray
  // is gone (403/404/410), the worker is failing (5xx), or the proxy transport
  // itself failed (worker unreachable → node-server returns a tagged proxy
  // error), discard it and mint a fresh tray rather than leaving the leader
  // inactive. `attachWithRecovery` only reaches here with a stored session and
  // retries with session=null (which is NOT recreate-eligible), so this can't
  // loop. Without the 5xx / transport cases, a boot whose stored tray had
  // expired would 502 and give up (the original "host won't lead" symptom).
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

export function createTrayFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  if (isExtension) {
    // Wrap so calling `this.fetchImpl(...)` doesn't rebind `this` to the
    // LeaderTrayManager instance and trigger "Illegal invocation" against
    // the global fetch.
    return (url, init) => fetchImpl(url, init);
  }

  return async (url, init = {}) => {
    const targetUrl = typeof url === 'string' ? url : url.toString();

    // Skip the proxy for same-origin requests (e.g. when served from the worker)
    try {
      const target = new URL(targetUrl);
      if (target.origin === window.location.origin) {
        return fetchImpl(targetUrl, { ...init, cache: 'no-store' as RequestCache });
      }
    } catch {
      // If URL parsing fails, fall through to proxy
    }

    const headers = new Headers(init.headers);
    headers.set('X-Target-URL', targetUrl);
    // Thin-bridge mode (UI hosted, /api on the local node-server) requires
    // the per-process bridge token on cross-origin /api/* calls; same-origin
    // / loopback returns an empty record so the legacy path is unchanged.
    for (const [k, v] of Object.entries(apiHeaders())) headers.set(k, v);

    const response = await fetchImpl(resolveApiUrl('/api/fetch-proxy'), {
      ...init,
      headers,
      cache: 'no-store',
    });
    // Only treat as proxy infrastructure failure when the proxy tagged it.
    // Upstream 4xx/5xx (e.g. tray-worker auth/quotas) must flow through.
    if (isProxyError(response)) {
      throw new TrayProxyFetchError(await readProxyErrorMessage(response));
    }
    return response;
  };
}
