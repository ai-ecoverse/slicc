import type { TraySudoAttestation } from '@slicc/shared-ts';
import type { SudoDecision, SudoRequest } from '../../sudo/types.js';
import type { LeaderSyncContext } from './context.js';

export const SUDO_DELEGATION_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingDelegation {
  requestId: string;
  request: SudoRequest;

  scoopName?: string;

  prompted: Set<string>;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  settle: (decision: SudoDecision) => void;
}

export interface SudoDelegationDeps {
  now?: () => number;

  timeoutMs?: number;

  newId?: () => string;
}

export class SudoDelegation {
  private readonly pending = new Map<string, PendingDelegation>();
  private counter = 0;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly newId: () => string;

  constructor(
    private readonly context: LeaderSyncContext,
    deps: SudoDelegationDeps = {}
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? SUDO_DELEGATION_TIMEOUT_MS;
    this.newId = deps.newId ?? (() => `sudo-${this.now()}-${++this.counter}`);
    context.followers.onFollowerRemoved({
      afterRegistryCleanup: (bootstrapId) => this.handleFollowerRemoved(bootstrapId),
    });
  }

  capableFollowers(): string[] {
    const out: string[] = [];
    for (const [id, follower] of this.context.followers.followers) {
      if (follower.peerCapabilities?.sudoApproval === true) out.push(id);
    }
    return out;
  }

  hasCapableFollower(): boolean {
    return this.capableFollowers().length > 0;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  requestApproval(request: SudoRequest, opts: { scoopName?: string } = {}): Promise<SudoDecision> {
    const requestId = this.newId();
    const expiresAt = this.now() + this.timeoutMs;
    return new Promise<SudoDecision>((resolve) => {
      const entry: PendingDelegation = {
        requestId,
        request,
        scoopName: opts.scoopName,
        prompted: new Set(),
        expiresAt,
        timer: setTimeout(() => {
          this.context.log.warn('Delegated sudo approval timed out — denying', { requestId });
          this.settle(requestId, { decision: 'deny' });
        }, this.timeoutMs),
        settle: resolve,
      };
      this.pending.set(requestId, entry);

      for (const bootstrapId of this.capableFollowers()) {
        this.prompt(entry, bootstrapId);
      }

      this.sendPush(request, requestId, entry.scoopName);

      if (entry.prompted.size === 0 && this.context.options.headlessLeader !== true) {
        this.context.log.warn('No capable follower for delegated sudo approval — denying', {
          requestId,
        });
        this.settle(requestId, { decision: 'deny' });
      }
    });
  }

  handleFollowerReady(bootstrapId: string): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (follower?.peerCapabilities?.sudoApproval !== true) return;
    for (const entry of this.pending.values()) {
      if (!entry.prompted.has(bootstrapId)) this.prompt(entry, bootstrapId);
    }
  }

  handleResponse(
    bootstrapId: string,
    requestId: string,
    decision: unknown,
    pattern: unknown,
    attestation: unknown
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry?.prompted.has(bootstrapId)) {
      this.context.log.warn('Ignoring sudo verdict for an unknown or unprompted request', {
        bootstrapId,
        requestId,
      });
      return;
    }
    const follower = this.context.followers.followers.get(bootstrapId);
    const biometric = follower?.peerCapabilities?.biometric === true;
    const att: TraySudoAttestation | undefined =
      attestation === 'biometric' || attestation === 'passcode' || attestation === 'none'
        ? attestation
        : undefined;

    let verdict: SudoDecision;
    if (decision === 'allow') {
      verdict = { decision: 'allow', ...(att ? { attestation: att } : {}) };
    } else if (decision === 'always') {
      if (!biometric) {
        this.context.log.info('Downgrading "always" from a non-biometric follower to "allow"', {
          bootstrapId,
          requestId,
        });
        verdict = { decision: 'allow', ...(att ? { attestation: att } : {}) };
      } else {
        const safe =
          typeof pattern === 'string' && pattern.trim().length > 0
            ? pattern.trim()
            : entry.request.suggestedPattern?.trim() || entry.request.detail;
        verdict = { decision: 'always', pattern: safe, ...(att ? { attestation: att } : {}) };
      }
    } else {
      verdict = { decision: 'deny' };
    }
    this.context.log.info('Delegated sudo approval settled by follower', {
      bootstrapId,
      requestId,
      decision: verdict.decision,
      attestation: att ?? 'none',
    });
    this.settle(requestId, verdict, bootstrapId);
  }

  private prompt(entry: PendingDelegation, bootstrapId: string): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) return;
    const scoopName = entry.scoopName;
    const sent = follower.sync.send({
      type: 'sudo.approve.request',
      requestId: entry.requestId,
      kind: entry.request.kind,
      detail: entry.request.detail,
      ...(entry.request.suggestedPattern
        ? { suggestedPattern: entry.request.suggestedPattern }
        : {}),
      ...(scoopName ? { scoopName } : {}),

      ...(entry.request.requester ? { requester: entry.request.requester } : {}),
      expiresAt: entry.expiresAt,
    });
    if (sent === false) {
      this.context.log.warn('Could not deliver delegated sudo prompt', {
        bootstrapId,
        requestId: entry.requestId,
      });
      return;
    }
    entry.prompted.add(bootstrapId);
  }

  private sendPush(request: SudoRequest, requestId: string, scoopName?: string): void {
    try {
      this.context.sendControl({
        type: 'push.send',
        category: 'sudo_request',
        label: scoopName ?? request.kind,
        requestId,
      });
    } catch {}
  }

  private settle(requestId: string, decision: SudoDecision, winner?: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    for (const bootstrapId of entry.prompted) {
      if (bootstrapId === winner) continue;
      this.context.followers.followers
        .get(bootstrapId)
        ?.sync.send({ type: 'sudo.approve.cancel', requestId });
    }
    entry.settle(decision);
  }

  private handleFollowerRemoved(bootstrapId: string): void {
    for (const entry of this.pending.values()) {
      entry.prompted.delete(bootstrapId);
      if (entry.prompted.size === 0 && this.context.options.headlessLeader !== true) {
        this.context.log.warn('Every prompted follower disconnected — denying sudo approval', {
          requestId: entry.requestId,
        });
        this.settle(entry.requestId, { decision: 'deny' });
      }
    }
  }

  dispose(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, { decision: 'deny' });
    }
  }
}
