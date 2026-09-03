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
const NOTIFY_SUPERSEDED_TIMEOUT_MS = 10_000;

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

/**
 * The status registry moved to `base/tray-leader-status.ts` so `shell/` can
 * read it without importing UP the layer stack (#2537). Re-exported here
 * under the established names — this module stays the address existing
 * callers use, and the manager below still drives the very same singleton.
 */
/**
 * `createTrayFetch` and `TrayProxyFetchError` moved to `shell/tray-fetch.ts`
 * (#2276): the realm check they need is a topology decision, which belongs
 * in the transport layer — this module no longer reads the float at all.
 * Re-exported under the established names so this stays the address
 * existing callers (and `shouldRecreateTray` below) use.
 */
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
      // Best-effort, fire-and-forget: point any follower still holding the old
      // join link at the new tray. Never awaited — notifyTraySuperseded already
      // catches every error internally and bounds the request with its own
      // timeout, so a hung/unreachable old tray can never stall the leader's
      // reconnect. A crashed leader (no chance to run this at all) falls back
      // to the existing TRAY_EXPIRED path once the old tray's reclaim TTL elapses.
      void this.notifyTraySuperseded(session, fresh.joinUrl, fresh.webhookUrl);
      return fresh;
    }
  }

  /**
   * Tell the OLD tray's Durable Object that it has been superseded by `newJoinUrl`,
   * so a follower still holding the old `/join/:token` link gets redirected
   * instead of dead-ending on FOLLOWER_JOIN_NOT_READY / TRAY_EXPIRED forever.
   * Bearer = the old session's controllerToken (extracted from `controllerUrl`).
   * Best-effort: fire-and-forget from the caller, and every failure (including
   * a request that never settles) is caught here so it can never surface.
   *
   * `newWebhookUrl` does the same for the webhook surface, and cannot be derived
   * from the join URL — one carries the join token, the other the webhook token.
   * Without it, a callback an external service saved hours ago POSTs into a dead
   * endpoint and the event is lost silently (#1957).
   */
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
      await this.fetchImpl(supersedeUrl, {
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
