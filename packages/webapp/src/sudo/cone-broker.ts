import { timedOutDecision } from './approval-timeout.js';
import type { SudoBroker, SudoDecision, SudoRequest } from './types.js';

export const CONE_SUDO_TIMEOUT_MS = 5 * 60 * 1000;

export interface PendingSudoRequest {
  id: string;
  scoopJid: string;
  request: SudoRequest;

  approverJid?: string;
}

export type SudoSettleReason = 'expired' | 'scoop-dropped' | 'shutdown';

export interface ConeApprovalRouter {
  enqueueSudoRequest(scoopJid: string, request: SudoRequest): Promise<SudoDecision>;
}

export function createConeApprovalBroker(scoopJid: string, router: ConeApprovalRouter): SudoBroker {
  return {
    requestApproval(request: SudoRequest): Promise<SudoDecision> {
      return router.enqueueSudoRequest(scoopJid, request);
    },
  };
}

export interface ConeRequestRegistryOptions {
  timeoutMs?: number;

  newId?: () => string;

  setTimer?: (cb: () => void, ms: number) => unknown;

  clearTimer?: (handle: unknown) => void;

  onAutoSettle?: (id: string, reason: SudoSettleReason, scoopJid: string) => void;
}

interface RegistryEntry {
  scoopJid: string;
  request: SudoRequest;
  resolve: (decision: SudoDecision) => void;
  timerHandle: unknown;

  approverJid?: string;
}

function defaultId(): string {
  return `lick-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class ConeRequestRegistry {
  private pending: Map<string, RegistryEntry> = new Map();
  private readonly timeoutMs: number;
  private readonly newId: () => string;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onAutoSettle: (id: string, reason: SudoSettleReason, scoopJid: string) => void;

  constructor(opts: ConeRequestRegistryOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? CONE_SUDO_TIMEOUT_MS;
    this.newId = opts.newId ?? defaultId;
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onAutoSettle = opts.onAutoSettle ?? (() => {});
  }

  private notifyAutoSettle(id: string, reason: SudoSettleReason, scoopJid: string): void {
    try {
      this.onAutoSettle(id, reason, scoopJid);
    } catch {}
  }

  register(
    scoopJid: string,
    request: SudoRequest,
    approverJid?: string
  ): { id: string; pending: Promise<SudoDecision> } {
    const id = this.newId();
    const pending = new Promise<SudoDecision>((resolve) => {
      let timerHandle: unknown = null;
      if (Number.isFinite(this.timeoutMs) && this.timeoutMs > 0) {
        timerHandle = this.setTimer(() => {
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);

          entry.resolve(timedOutDecision('cone-timeout'));
          this.notifyAutoSettle(id, 'expired', entry.scoopJid);
        }, this.timeoutMs);
      }
      this.pending.set(id, { scoopJid, request, resolve, timerHandle, approverJid });
    });
    return { id, pending };
  }

  resolve(id: string, decision: SudoDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    if (entry.timerHandle != null) this.clearTimer(entry.timerHandle);
    entry.resolve(decision);
    return true;
  }

  failScoop(scoopJid: string): number {
    let count = 0;
    for (const [id, entry] of this.pending) {
      if (entry.scoopJid !== scoopJid) continue;
      this.pending.delete(id);
      if (entry.timerHandle != null) this.clearTimer(entry.timerHandle);
      entry.resolve({ decision: 'deny' });
      this.notifyAutoSettle(id, 'scoop-dropped', entry.scoopJid);
      count++;
    }
    return count;
  }

  failAll(): number {
    let count = 0;
    for (const [id, entry] of this.pending) {
      if (entry.timerHandle != null) this.clearTimer(entry.timerHandle);
      entry.resolve({ decision: 'deny' });
      this.notifyAutoSettle(id, 'shutdown', entry.scoopJid);
      count++;
    }
    this.pending.clear();
    return count;
  }

  get(id: string): PendingSudoRequest | null {
    const entry = this.pending.get(id);
    if (!entry) return null;
    return {
      id,
      scoopJid: entry.scoopJid,
      request: entry.request,

      ...(entry.approverJid ? { approverJid: entry.approverJid } : {}),
    };
  }

  list(): PendingSudoRequest[] {
    const out: PendingSudoRequest[] = [];
    for (const [id, entry] of this.pending) {
      out.push({
        id,
        scoopJid: entry.scoopJid,
        request: entry.request,
        ...(entry.approverJid ? { approverJid: entry.approverJid } : {}),
      });
    }
    return out;
  }

  size(): number {
    return this.pending.size;
  }
}
