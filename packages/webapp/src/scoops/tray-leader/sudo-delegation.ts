/**
 * Delegate a sudo approval to tray followers' humans (issue #2062).
 *
 * The leader's native approval surface is wherever the leader tab runs — an
 * OS dialog on the Mac, nothing at all on the headless cloud float. When the
 * human is demonstrably somewhere else (driving from the phone) or there is
 * no local human, the prompt goes out over the tray instead: every connected
 * follower that advertised `capabilities.sudoApproval` receives the same
 * `sudo.approve.request`; the first verdict wins and the others get a
 * `sudo.approve.cancel`.
 *
 * Policy guards live here, not on the follower:
 *  - `always` is accepted only from a follower that advertised `biometric`
 *    (Face ID / passcode gate); anyone else's `always` is downgraded to a
 *    one-shot `allow`, so an unauthenticated web tab cannot widen the policy.
 *  - Fail closed: timeout, every candidate disconnecting, a dead channel, or a
 *    malformed reply all resolve `deny`.
 *
 * A headless leader with NO capable follower connected does not deny at once:
 * it parks the request, asks the hub to push-wake registered phones, and
 * delivers the prompt to the first capable follower whose `hello` arrives
 * before the deadline. That is the suspended-iPhone path: banner → tap →
 * reconnect → Face ID.
 *
 * Modeled on `oauth-popup-delegation.ts` (waiter map, timeout, disconnect
 * settlement).
 */

import type { TraySudoAttestation } from '@slicc/shared-ts';
import type { SudoDecision, SudoRequest } from '../../sudo/types.js';
import type { LeaderSyncContext } from './context.js';

/** Same fail-closed window the cone-mediated path uses (5 minutes). */
export const SUDO_DELEGATION_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingDelegation {
  requestId: string;
  request: SudoRequest;
  /** Followers that currently hold an open prompt for this request. */
  prompted: Set<string>;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  settle: (decision: SudoDecision) => void;
}

export interface SudoDelegationDeps {
  /** Clock seam (epoch ms). */
  now?: () => number;
  /** Timeout seam. */
  timeoutMs?: number;
  /** ID seam. */
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

  /** Bootstrap ids of connected followers that can render a sudo prompt. */
  capableFollowers(): string[] {
    const out: string[] = [];
    for (const [id, follower] of this.context.followers.followers) {
      if (follower.peerCapabilities?.sudoApproval === true) out.push(id);
    }
    return out;
  }

  /** True when at least one connected follower can render a sudo prompt. */
  hasCapableFollower(): boolean {
    return this.capableFollowers().length > 0;
  }

  /** Number of prompts currently parked or on screen (tests / diagnostics). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Ship `request` to every capable follower and resolve with the first
   * verdict. See the module doc for the policy guards. `scoopName` is
   * forwarded so the card can say which scoop is asking.
   */
  requestApproval(request: SudoRequest, opts: { scoopName?: string } = {}): Promise<SudoDecision> {
    const requestId = this.newId();
    const expiresAt = this.now() + this.timeoutMs;
    return new Promise<SudoDecision>((resolve) => {
      const entry: PendingDelegation = {
        requestId,
        request: { ...request, ...(opts.scoopName ? {} : {}) },
        prompted: new Set(),
        expiresAt,
        timer: setTimeout(() => {
          this.context.log.warn('Delegated sudo approval timed out — denying', { requestId });
          this.settle(requestId, { decision: 'deny' });
        }, this.timeoutMs),
        settle: resolve,
      };
      this.pending.set(requestId, entry);

      const scoopName = opts.scoopName;
      for (const bootstrapId of this.capableFollowers()) {
        this.prompt(entry, bootstrapId, scoopName);
      }

      // Wake suspended phones. Metadata only — the request itself travels over
      // the data channel once the phone reconnects.
      this.sendPush(request, requestId, scoopName);

      if (entry.prompted.size === 0 && this.context.options.headlessLeader !== true) {
        // A leader with a human of its own only delegates when someone is
        // there to answer; parking would leave the local human staring at
        // nothing. (`shouldDelegate` normally prevents reaching this.)
        this.context.log.warn('No capable follower for delegated sudo approval — denying', {
          requestId,
        });
        this.settle(requestId, { decision: 'deny' });
      }
    });
  }

  /**
   * A follower just completed its `hello`. Deliver every parked prompt it is
   * eligible for (the headless-leader wake-up path).
   */
  handleFollowerReady(bootstrapId: string): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (follower?.peerCapabilities?.sudoApproval !== true) return;
    for (const entry of this.pending.values()) {
      if (!entry.prompted.has(bootstrapId)) this.prompt(entry, bootstrapId);
    }
  }

  /** A follower answered. Ignored unless it was prompted for that request. */
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

  private prompt(entry: PendingDelegation, bootstrapId: string, scoopName?: string): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) return;
    const sent = follower.sync.send({
      type: 'sudo.approve.request',
      requestId: entry.requestId,
      kind: entry.request.kind,
      detail: entry.request.detail,
      ...(entry.request.suggestedPattern
        ? { suggestedPattern: entry.request.suggestedPattern }
        : {}),
      ...(scoopName ? { scoopName } : {}),
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
    } catch {
      // No controller socket (tests, reconnecting) — the data-channel prompt
      // still went out to connected followers.
    }
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

  /** Deny everything outstanding (leader shutdown). */
  dispose(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, { decision: 'deny' });
    }
  }
}
