import { createLogger } from '../core/logger.js';
import type { LeaderToWorkerControlMessage, WorkerToLeaderControlMessage } from '../worker/tray-signaling.js';
import * as db from './db.js';
import { buildTrayWorkerUrl } from './tray-runtime-config.js';

const log = createLogger('tray-leader');
const LEADER_TRAY_STATE_KEY = 'leader-tray-session';
const LEADER_TRAY_PING_INTERVAL_MS = 30_000;
const LEADER_TRAY_CONNECT_TIMEOUT_MS = 10_000;

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
  state: 'inactive' | 'connecting' | 'leader' | 'error';
  session: LeaderTraySession | null;
  error: string | null;
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

function setLeaderTrayRuntimeStatus(status: LeaderTrayRuntimeStatus): void {
  leaderTrayRuntimeStatus = {
    ...status,
    session: status.session ? { ...status.session } : null,
  };
}

export interface LeaderTraySessionStore {
  load(): Promise<LeaderTraySession | null>;
  save(session: LeaderTraySession): Promise<void>;
  clear(): Promise<void>;
}

export interface LeaderTrayWebSocket {
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
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
      typeof parsed.workerBaseUrl !== 'string'
      || typeof parsed.trayId !== 'string'
      || typeof parsed.createdAt !== 'string'
      || typeof parsed.controllerId !== 'string'
      || typeof parsed.controllerUrl !== 'string'
      || typeof parsed.joinUrl !== 'string'
      || typeof parsed.webhookUrl !== 'string'
      || typeof parsed.runtime !== 'string'
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
      leaderWebSocketUrl: typeof parsed.leaderWebSocketUrl === 'string' ? parsed.leaderWebSocketUrl : null,
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
  private socket: LeaderTrayWebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private currentSession: LeaderTraySession | null = null;

  constructor(private readonly options: LeaderTrayManagerOptions) {
    this.store = options.store ?? new IndexedDbLeaderTraySessionStore();
    this.fetchImpl = options.fetchImpl ?? createLeaderTrayFetch();
    this.webSocketFactory = options.webSocketFactory ?? (url => new WebSocket(url));
    this.pingIntervalMs = options.pingIntervalMs ?? LEADER_TRAY_PING_INTERVAL_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? LEADER_TRAY_CONNECT_TIMEOUT_MS;
  }

  async start(): Promise<LeaderTraySession> {
    if (this.currentSession && this.socket) {
      setLeaderTrayRuntimeStatus({ state: 'leader', session: this.currentSession, error: null });
      return this.currentSession;
    }

    setLeaderTrayRuntimeStatus({ state: 'connecting', session: null, error: null });
    this.currentSession = null;

    try {
      const storedSession = await this.store.load();
      const reusableSession = storedSession?.workerBaseUrl === this.options.workerBaseUrl ? storedSession : null;

      const session = await this.attachWithRecovery(reusableSession);
      this.currentSession = session;
      const socket = await this.openLeaderSocket(session.leaderWebSocketUrl!);
      this.socket = socket;
      this.startPingLoop(socket);
      setLeaderTrayRuntimeStatus({ state: 'leader', session, error: null });

      log.info('Leader joined tray', { trayId: session.trayId, controllerId: session.controllerId, runtime: session.runtime });
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
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Ignore teardown failures.
      }
      this.socket = null;
    }

    this.currentSession = null;
    setLeaderTrayRuntimeStatus({ state: 'inactive', session: null, error: null });
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
      return this.claimLeaderSession(null);
    }
  }

  private async claimLeaderSession(session: LeaderTraySession | null): Promise<LeaderTraySession> {
    const activeSession = session ?? await this.createTraySession();
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
      throw new Error(`Tray attach did not return leader access for controller ${attach.controllerId}`);
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
    const created = await this.fetchJson<CreateTrayResponse>(buildTrayWorkerUrl(this.options.workerBaseUrl, 'tray'), {
      method: 'POST',
    });

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
        fail(`Tray leader WebSocket timed out after ${this.connectTimeoutMs}ms waiting for leader.connected`);
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
      socket.addEventListener('close', () => fail('Tray leader WebSocket closed before leader.connected'));
      socket.addEventListener('error', () => fail('Tray leader WebSocket failed before leader.connected'));
    });
  }

  private startPingLoop(socket: LeaderTrayWebSocket): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }

    const sendPing = () => {
      try {
        socket.send(JSON.stringify({ type: 'ping' }));
      } catch {
        this.stop();
      }
    };

    sendPing();
    this.pingTimer = setInterval(sendPing, this.pingIntervalMs);
    socket.addEventListener('close', () => this.stop());
    socket.addEventListener('error', () => this.stop());
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
    message: string,
  ) {
    super(message);
    this.name = 'LeaderTrayHttpError';
  }

  static async fromResponse(response: Response): Promise<LeaderTrayHttpError> {
    try {
      const payload = (await response.json()) as { error?: string; code?: string };
      return new LeaderTrayHttpError(response.status, payload.code ?? null, payload.error ?? `Tray request failed (${response.status})`);
    } catch {
      return new LeaderTrayHttpError(response.status, null, `Tray request failed (${response.status})`);
    }
  }
}

function shouldRecreateTray(error: unknown): boolean {
  return error instanceof LeaderTrayHttpError && [403, 404, 410].includes(error.status);
}

function parseSocketMessage(data: unknown): WorkerToLeaderControlMessage | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as WorkerToLeaderControlMessage;
  } catch {
    return null;
  }
}

function createLeaderTrayFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  if (isExtension) {
    return fetchImpl;
  }

  return async (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('X-Target-URL', typeof url === 'string' ? url : url.toString());

    const response = await fetchImpl('/api/fetch-proxy', {
      ...init,
      headers,
      cache: 'no-store',
    });
    if (response.status === 400 || response.status === 502) {
      let message = `Proxy error ${response.status}`;
      try {
        const payload = (await response.json()) as { error?: string };
        message = payload.error ?? message;
      } catch {
        // Ignore malformed proxy error bodies.
      }
      throw new Error(message);
    }
    return response;
  };
}
