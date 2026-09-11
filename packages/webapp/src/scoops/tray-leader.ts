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
  /** Stable cone identity echoed back by the worker (#2812); absent on old hubs. */
  coneId?: string;
  createdAt: string;
  capabilities: {
    join: { url: string };
    controller: { url: string };
    /**
     * The webhook base URL. Stable cone-scoped (`/wh/<coneId>.<secret>`) when
     * the home bind succeeded, else the legacy tray-scoped `/webhook/...`.
     * `rebindToken` is present only on the stable shape.
     */
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

/**
 * Two things moved out of this module and are re-exported under their
 * established names, so this stays the address existing callers use:
 *
 * - The status registry moved to `base/tray-leader-status.ts` so `shell/`
 *   can read it without importing UP the layer stack (#2537); the manager
 *   below still drives the very same singleton.
 * - `createTrayFetch` and `TrayProxyFetchError` moved to
 *   `shell/tray-fetch.ts` (#2276): the realm check they need is a topology
 *   decision, which belongs in the transport layer — this module no longer
 *   reads the float at all. `shouldRecreateTray` below still imports
 *   `TrayProxyFetchError` directly, since it needs the class.
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
  /** Private management credentials, never mirrored into runtime status or the VFS. */
  identityStore?: LeaderWebhookIdentityStore;
  /** Durable source tray for an unfinished replacement; the target lives in store. */
  replacementStore?: LeaderTraySessionStore;
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

/** A leader-session lineage, shared by its WorkUnits; not a per-agent cone identity. */
export interface ConeIdentity {
  coneId: string;
  coneSecret: string;
  rebindSecret: string;
  /** False until a stable capability is acknowledged; permits old-hub bootstrap. */
  established?: boolean;
  /** Durable intent: replay deterministic rotation before any subsequent rebind. */
  pendingRotation?: LeaderTraySession;
}

export interface LeaderWebhookIdentityStore {
  load(): Promise<ConeIdentity | null>;
  save(identity: ConeIdentity): Promise<void>;
}

/**
 * Management-only IndexedDB state, outside the agent-visible VFS and session
 * status mirrors. This is not a boundary against arbitrary same-origin code.
 * Deliberately has no clear operation: resetting a tray is not revocation.
 */
export class IndexedDbLeaderWebhookIdentityStore implements LeaderWebhookIdentityStore {
  private readonly key: string;

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
    const pendingRotation = parsed.pendingRotation
      ? parseLeaderTraySession(JSON.stringify(parsed.pendingRotation))
      : null;
    if (parsed.pendingRotation && !pendingRotation) {
      throw new Error('Stored webhook rotation intent is invalid');
    }
    return {
      coneId: parsed.coneId,
      coneSecret: parsed.coneSecret,
      rebindSecret: parsed.rebindSecret,
      established: parsed.established !== false,
      ...(pendingRotation ? { pendingRotation } : {}),
    };
  }

  async save(identity: ConeIdentity): Promise<void> {
    await db.setState(this.key, JSON.stringify(identity));
  }
}

/** A trusted no-leader deletion guard; never returns management credentials. */
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

/**
 * Recover the cone identity from a create response's stable webhook capability.
 * The URL is `…/wh/<coneId>.<coneSecret>` and the rebind token is
 * `<coneId>.<rebindSecret>`; returns null for the legacy tray-scoped shape
 * (no rebind token) or anything that does not parse, so a caller falls back to
 * the rove-fragile `webhookUrl`.
 */
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
  // The rebind token must name the same cone — a mismatch is a malformed reply.
  if (!coneId || !coneSecret || !rebindSecret || rebindConeId !== coneId) return null;
  return { coneId, coneSecret, rebindSecret };
}

/** The carriable cone identity of a session, or null if it has none. */
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
      // Stable cone identity (#2812). All three travel together — a partial set
      // could not authenticate a rebind, so treat any missing field as absent.
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
    if (this.rotation !== null) await this.rotation;
    const storedSession = await this.store.load();
    const reusableSession =
      storedSession?.workerBaseUrl.replace(/\/+$/, '') ===
      this.options.workerBaseUrl.replace(/\/+$/, '')
        ? storedSession
        : null;

    this.identity = await this.identityStore.load();
    // The server may have rotated even when its response was lost. Replay the
    // durable old-credential request before attach/rebind can reject that secret.
    if (this.identity?.pendingRotation) await this.rotateWebhookOnce();
    const legacy = reusableSession && coneIdentityOf(reusableSession);
    if (!this.identity && legacy) await this.saveIdentity(legacy);
    // Persist migration before discarding any old copy of the management token.
    const safeSession = reusableSession && this.publicSession(reusableSession);
    if (safeSession && legacy) await this.store.save(safeSession);

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
    if (this.rotation !== null) await this.rotation;
    if (await this.replacementStore.load()) {
      throw new Error('Tray replacement is pending; retry reset before clearing the session');
    }
    await this.store.clear();
  }

  /** Resume the same durable source/target pair after any failed reset or reload. */
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
    target: LeaderTraySession | null
  ): Promise<LeaderTraySession> {
    const next =
      target && target.trayId !== source.trayId ? target : await this.createTraySession();
    await this.transferPreviousSession(source, next);
    const claimed = await this.claimLeaderSession(next);
    // Only clear after transfer and target attach are durable. Lost responses retry
    // the same pair; never mint a third tray while the source is frozen.
    await this.replacementStore.clear();
    void this.notifyTraySuperseded(source, claimed.joinUrl, claimed.webhookUrl);
    return claimed;
  }

  async transferPreviousSession(
    source: LeaderTraySession,
    target: LeaderTraySession
  ): Promise<void> {
    if (source.trayId === target.trayId) return;
    // Old hubs have no stable-home/preview-transfer protocol. Keep their legacy
    // supersession path rather than pretending they support scope-safe transfer.
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

  /** The session the manager is currently leading, or null. */
  getCurrentSession(): LeaderTraySession | null {
    return this.currentSession;
  }

  /**
   * Rotate the cone's stable webhook capability (#2812): revoke the current
   * webhook URL and issue a fresh one on the
   * same tray. Used when the delivery secret may have leaked — the long-lived
   * secret the stable address trades for is why this exists.
   *
   * Updates private management persistence before publishing the new delivery
   * URL. The identity belongs to this leader-session lineage, not an individual
   * WorkUnit. Legacy hubs have no stable capability to rotate.
   */
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
    const session = this.identity?.pendingRotation ?? this.currentSession;
    if (!session) {
      throw new Error('webhook rotate: no active tray session');
    }
    const currentIdentity = this.identity;
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
      await this.saveIdentity({ ...currentIdentity, pendingRotation: session });
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
      }),
    });

    const identity = parseConeWebhookIdentity(rotated.webhook.url, rotated.webhook.rebindToken);
    if (!identity) {
      throw new Error('webhook rotate: hub returned an unparseable webhook capability');
    }
    if (
      identity.coneId !== currentIdentity.coneId ||
      identity.rebindSecret !== currentIdentity.rebindSecret
    ) {
      throw new Error('webhook rotate: hub changed the management identity');
    }
    await this.saveIdentity({ ...identity, established: true });
    const next: LeaderTraySession = {
      ...session,
      webhookUrl: rotated.webhook.url,
      coneId: identity.coneId,
    };
    await this.store.save(next);
    if (this.currentSession === session) {
      this.currentSession = next;
      setLeaderTrayRuntimeStatus({ state: 'leader', session: next, error: null });
    }
    return { webhookUrl: rotated.webhook.url };
  }

  /** Revoke one registration without exposing management credentials to callers. */
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

  /**
   * Point followers and cached webhook URLs of an abandoned tray at their
   * replacement. Public counterpart to the recovery path's internal call, for
   * a caller that abandons a tray deliberately rather than on a stale-session
   * error — `host reset` (`pageLeaderTray.reset()`).
   *
   * Without it, a reset re-mints the tray and leaves the old one with no
   * forwarding address: followers dead-end on TRAY_EXPIRED and an external
   * service's cached webhook URL POSTs into a tray that 410s, losing the event
   * silently — the #1957 failure mode, reachable through the reset button as
   * surely as through a crash. Best-effort and fire-and-forget, exactly like
   * the recovery-path call: never awaited by the caller, every failure caught
   * here, bounded by its own timeout.
   */
  supersedePreviousSession(
    oldSession: LeaderTraySession,
    next: { joinUrl: string; webhookUrl: string }
  ): void {
    // Superseding a tray with itself would make it redirect to its own join
    // URL forever — guard the degenerate case a mis-sequenced caller could hit.
    if (oldSession.trayId === '' || next.joinUrl === oldSession.joinUrl) return;
    void this.notifyTraySuperseded(oldSession, next.joinUrl, next.webhookUrl);
  }

  /**
   * Compatibility shim for older callers. Management identity is independent
   * of the session cache now and must never be recovered from public status.
   */
  carryConeIdentityFrom(oldSession: LeaderTraySession): void {
    // Compatibility with older reset callers. Identity is durable independently.
    // Legacy migration happens in connectOnce before the first session is exposed.
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
      await this.store.clear();
      return this.claimReplacement(session, null);
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

  private async createTraySession(): Promise<LeaderTraySession> {
    // Persist before the request: even a lost first-create response must retry
    // the same home rather than orphaning a freshly generated capability.
    if (!this.identity) {
      await this.saveIdentity({
        coneId: crypto.randomUUID(),
        coneSecret: crypto.randomUUID().replace(/-/g, ''),
        rebindSecret: crypto.randomUUID().replace(/-/g, ''),
        established: false,
      });
    }
    const carry = this.identity!;
    const bodyObject: {
      kind?: TrayKind;
      coneId?: string;
      coneSecret?: string;
      rebindSecret?: string;
    } = {};
    if (this.options.kind) bodyObject.kind = this.options.kind;
    if (carry) {
      bodyObject.coneId = carry.coneId;
      bodyObject.coneSecret = carry.coneSecret;
      bodyObject.rebindSecret = carry.rebindSecret;
    }
    const hasBody = Object.keys(bodyObject).length > 0;
    const body = hasBody ? JSON.stringify(bodyObject) : undefined;
    const created = await this.fetchJson<CreateTrayResponse>(
      buildTrayWorkerUrl(this.options.workerBaseUrl, 'tray'),
      {
        method: 'POST',
        ...(body ? { headers: { 'content-type': 'application/json' } } : {}),
        ...(body ? { body } : {}),
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
      await this.saveIdentity({ ...coneIdentity, established: true });
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
    // An attach failure must retry this exact tray, not create another one.
    await this.store.save(session);
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
