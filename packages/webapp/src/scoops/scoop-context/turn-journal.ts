/**
 * In-flight turn journal — what each work unit was doing when the page died.
 *
 * Owns: one small IndexedDB record per unit that exists ONLY while a turn is
 * running — written when the turn starts, updated as tool calls start and
 * end, deleted when the turn settles (success, error, abort, dispose). A
 * reload kills the kernel worker without running any of that cleanup, so a
 * record that survives into the next boot is proof the unit was cut off
 * mid-turn; `interrupted-work-recovery.ts` reads it and decides whether to
 * repeat the lost model request or hand the lost tool calls to the agent.
 *
 * Changes when what recovery needs to know about an interrupted turn changes.
 *
 * Its own database (not a store inside `slicc-work-units`) so it can never
 * force a schema bump on the canonical conversation store, and so a journal
 * write can never be serialized behind a large conversation write.
 *
 * Every write is best-effort and serialized per unit: a failed write degrades
 * recovery (the unit restarts idle, exactly as before the journal existed) and
 * never fails a turn.
 */

import { createLogger } from '../../core/index.js';
import type { TurnGuestGate } from '../../sudo/types.js';

const log = createLogger('turn-journal');

export const TURN_JOURNAL_DB_NAME = 'slicc-turn-journal';
const DB_VERSION = 1;
const STORE = 'inflight';

/** Longest tool-argument preview kept per in-flight call. */
export const TOOL_ARGS_PREVIEW_MAX = 400;

/** One tool call that had started and not yet reported a result. */
export interface InFlightToolCall {
  toolCallId: string;
  toolName: string;
  /** Truncated JSON of the call's arguments, for the recovery lick. */
  argsPreview: string;
  startedAt: number;
}

/** A unit's running turn, as last journaled. */
export interface InFlightTurn {
  /** Unit jid — the record key. */
  jid: string;
  /** Unit folder, for log correlation and lick targeting. */
  folder: string;
  startedAt: number;
  updatedAt: number;
  /**
   * How many times in a row this turn has already been resumed after a
   * reload. A normal turn starts at 0; each automatic resume carries the
   * count forward so recovery can stop replaying a turn that keeps dying.
   */
  resumeCount: number;
  /** Tool calls started but not yet finished, oldest first. */
  tools: InFlightToolCall[];
  /**
   * The guest gates the turn ran under (biscotto seats). A resumed turn is
   * gated exactly like the one it replaces — a reload must never un-gate a
   * guest's turn.
   */
  guestGates: TurnGuestGate[];
}

export class TurnJournal {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly dbName: string;
  /** Live copy of each unit's record; the source every write serializes. */
  private readonly live = new Map<string, InFlightTurn>();
  /** Tail of the write chain per unit, so writes land in call order. */
  private readonly chains = new Map<string, Promise<void>>();

  /** `dbName` is injectable so tests get one database per suite. */
  constructor(options: { dbName?: string } = {}) {
    this.dbName = options.dbName ?? TURN_JOURNAL_DB_NAME;
  }

  /** A turn is starting. Replaces any earlier record for the unit. */
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

  /** A prompt queued into the running turn widened its guest gates. */
  setGuestGates(jid: string, guestGates: TurnGuestGate[]): void {
    const turn = this.live.get(jid);
    if (!turn) return;
    turn.guestGates = [...guestGates];
    turn.updatedAt = Date.now();
    void this.write(jid, turn);
  }

  /**
   * A tool call started inside the unit's running turn. Resolves once the
   * record naming it has landed, so the caller can hold the tool until then.
   */
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

  /**
   * A tool call's result is durably in the conversation — only then may the
   * journal let go of it, or a reload in between would find a call with no
   * result and no journal entry, and misreport a finished call as lost.
   */
  toolEnded(jid: string, toolCallId: string): void {
    const turn = this.live.get(jid);
    if (!turn) return;
    const before = turn.tools.length;
    turn.tools = turn.tools.filter((t) => t.toolCallId !== toolCallId);
    if (turn.tools.length === before) return;
    turn.updatedAt = Date.now();
    void this.write(jid, turn);
  }

  /** The unit's turn settled, one way or another: nothing to recover. */
  end(jid: string): void {
    // Only a turn begun in THIS page life is ours to clear; a record left
    // over from before the reload belongs to recovery, which clears it.
    if (!this.live.delete(jid)) return;
    void this.write(jid, null);
  }

  /** Whether a turn begun in THIS page life currently owns the unit's record. */
  isLive(jid: string): boolean {
    return this.live.has(jid);
  }

  /** Forget a record left over from before the reload. */
  async clear(jid: string): Promise<void> {
    this.live.delete(jid);
    await this.write(jid, null);
  }

  /** Every record on disk — the turns a previous page life left running. */
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

  /** Resolves once every queued write has landed (tests, shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  /** Resolves once every write queued for the unit so far has landed. */
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
        // Let a later call retry instead of caching the failure forever.
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

/** Truncated JSON of a tool call's arguments. Never throws. */
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
