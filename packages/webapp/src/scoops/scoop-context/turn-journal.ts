import { createLogger } from '../../core/index.js';
import type { TurnGuestGate } from '../../sudo/types.js';

const log = createLogger('turn-journal');

export const TURN_JOURNAL_DB_NAME = 'slicc-turn-journal';
const DB_VERSION = 1;
const STORE = 'inflight';

export const TOOL_ARGS_PREVIEW_MAX = 400;

export interface InFlightToolCall {
  toolCallId: string;
  toolName: string;

  argsPreview: string;
  startedAt: number;
}

export interface InFlightTurn {
  jid: string;

  folder: string;
  startedAt: number;
  updatedAt: number;

  resumeCount: number;

  tools: InFlightToolCall[];

  guestGates: TurnGuestGate[];
}

export class TurnJournal {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly dbName: string;

  private readonly live = new Map<string, InFlightTurn>();

  private readonly chains = new Map<string, Promise<void>>();

  constructor(options: { dbName?: string } = {}) {
    this.dbName = options.dbName ?? TURN_JOURNAL_DB_NAME;
  }

  begin(jid: string, folder: string, resumeCount = 0, guestGates: TurnGuestGate[] = []): void {
    const now = Date.now();
    const turn: InFlightTurn = {
      jid,
      folder,
      startedAt: now,
      updatedAt: now,
      resumeCount,
      tools: [],
      guestGates: [...guestGates],
    };
    this.live.set(jid, turn);
    void this.write(jid, turn);
  }

  setGuestGates(jid: string, guestGates: TurnGuestGate[]): void {
    const turn = this.live.get(jid);
    if (!turn) return;
    turn.guestGates = [...guestGates];
    turn.updatedAt = Date.now();
    void this.write(jid, turn);
  }

  toolStarted(jid: string, toolCallId: string, toolName: string, args: unknown): Promise<void> {
    const turn = this.live.get(jid);
    if (!turn) return Promise.resolve();
    if (turn.tools.some((t) => t.toolCallId === toolCallId)) return this.settled(jid);
    turn.tools.push({
      toolCallId,
      toolName,
      argsPreview: previewArgs(args),
      startedAt: Date.now(),
    });
    turn.updatedAt = Date.now();
    return this.write(jid, turn);
  }

  toolEnded(jid: string, toolCallId: string): void {
    const turn = this.live.get(jid);
    if (!turn) return;
    const before = turn.tools.length;
    turn.tools = turn.tools.filter((t) => t.toolCallId !== toolCallId);
    if (turn.tools.length === before) return;
    turn.updatedAt = Date.now();
    void this.write(jid, turn);
  }

  end(jid: string): void {
    if (!this.live.delete(jid)) return;
    void this.write(jid, null);
  }

  isLive(jid: string): boolean {
    return this.live.has(jid);
  }

  async clear(jid: string): Promise<void> {
    this.live.delete(jid);
    await this.write(jid, null);
  }

  async readAll(): Promise<InFlightTurn[]> {
    try {
      const db = await this.getDb();
      const rows = await request<InFlightTurn[]>(
        db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
      );
      return rows.filter(isInFlightTurn).map((row) => ({
        ...row,
        resumeCount: typeof row.resumeCount === 'number' ? row.resumeCount : 0,
        guestGates: Array.isArray(row.guestGates) ? row.guestGates : [],
      }));
    } catch (err) {
      log.warn('Turn journal read failed; nothing will be recovered', { error: errorText(err) });
      return [];
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  private settled(jid: string): Promise<void> {
    return this.chains.get(jid) ?? Promise.resolve();
  }

  private write(jid: string, turn: InFlightTurn | null): Promise<void> {
    const snapshot = turn ? structuredClone(turn) : null;
    const prev = this.chains.get(jid) ?? Promise.resolve();
    const next = prev
      .then(() => this.persist(jid, snapshot))
      .catch((err) => {
        log.warn('Turn journal write failed', { jid, error: errorText(err) });
      });
    this.chains.set(jid, next);
    void next.then(() => {
      if (this.chains.get(jid) === next) this.chains.delete(jid);
    });
    return next;
  }

  private async persist(jid: string, turn: InFlightTurn | null): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    if (turn) store.put(turn);
    else store.delete(jid);
    await transaction(tx);
  }

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDb(this.dbName).catch((err) => {
        this.dbPromise = null;
        throw err;
      });
    }
    return this.dbPromise;
  }
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'jid' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('turn journal open failed'));
    req.onblocked = () => reject(new Error('turn journal open blocked'));
  });
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('turn journal request failed'));
  });
}

function transaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('turn journal transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('turn journal transaction aborted'));
  });
}

export function previewArgs(args: unknown): string {
  let text: string;
  try {
    text = typeof args === 'string' ? args : (JSON.stringify(args) ?? '');
  } catch {
    text = String(args);
  }
  return text.length > TOOL_ARGS_PREVIEW_MAX
    ? `${text.slice(0, TOOL_ARGS_PREVIEW_MAX - 1)}…`
    : text;
}

function isInFlightTurn(value: unknown): value is InFlightTurn {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<InFlightTurn>;
  return typeof v.jid === 'string' && typeof v.folder === 'string' && Array.isArray(v.tools);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
