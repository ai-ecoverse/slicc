/**
 * Follower WebRTC bootstrap — the signaling state machine of the tray hub.
 *
 * A follower cannot talk to the leader directly until a peer connection
 * exists, so the DO brokers one: the follower attaches, the leader is told to
 * make an offer, and offer / answer / ICE candidates are exchanged through
 * this coordinator. Followers poll over HTTP (`action: 'poll'`) with a cursor
 * into a per-bootstrap event log; the leader pushes over its control socket.
 *
 * Extracted from `SessionTrayDurableObject` behind a {@link BootstrapDeps}
 * seam (issue #2674), mirroring `session-tray-preview.ts` and
 * `session-tray-biscotto.ts`. Everything the coordinator needs about the tray
 * arrives through `deps`; it never reaches into the DO.
 *
 * State lives on the tray record (`tray.bootstraps`), not on this object, so it
 * survives DO hibernation. The coordinator is therefore free to be re-created
 * per instance.
 */

import {
  type FollowerBiscottoIdentity,
  type FollowerBootstrapRequest,
  type FollowerBootstrapResponse,
  type FollowerTrust,
  type LeaderToWorkerControlMessage,
  TRAY_BOOTSTRAP_MAX_RETRIES,
  TRAY_BOOTSTRAP_RETRY_AFTER_MS,
  TRAY_BOOTSTRAP_TIMEOUT_MS,
  type TrayBootstrapEvent,
  type TrayBootstrapFailure,
  type TrayBootstrapStatus,
  type TrayIceCandidate,
  type TrayLeaderSummary,
  type TraySessionDescription,
  type TurnIceServer,
  type WorkerToLeaderControlMessage,
} from '@slicc/shared-ts';
import { isIceCandidate, isSessionDescription } from './session-tray-requests.js';
import {
  jsonResponse,
  normalizeBiscottoGate,
  type TrayBootstrapRecord,
  type TrayRecord,
  type TrayWebSocketLike,
} from './shared.js';

// Grace period after a bootstrap reaches a terminal state before it is pruned.
// Gives the follower time to poll the final failure before the record vanishes.
const BOOTSTRAP_TERMINAL_GRACE_MS = 5 * 60 * 1000;
// Maximum bootstrap events kept per record. The follower polls via a cursor so
// only recent events matter; old SDP payloads (kilobytes each) are dropped.
const MAX_BOOTSTRAP_EVENTS = 20;

type TrayBootstrapEventInput =
  | { type: 'bootstrap.offer'; offer: TraySessionDescription }
  | { type: 'bootstrap.ice_candidate'; candidate: TrayIceCandidate }
  | { type: 'bootstrap.failed'; failure: TrayBootstrapFailure };

/** The slice of the durable object this coordinator needs. */
export interface BootstrapDeps {
  requireTray(): TrayRecord;
  persistTray(): Promise<void>;
  now(): number;
  isoNow(): string;
  hasLiveLeader(): boolean;
  sendToLeader(message: WorkerToLeaderControlMessage): boolean;
  getIceServers(): Promise<TurnIceServer[] | undefined>;
  leaderSummary(): Promise<TrayLeaderSummary | null>;
}

function bootstrapNotFound(): Response {
  return jsonResponse({ error: 'Bootstrap not found', code: 'BOOTSTRAP_NOT_FOUND' }, 404);
}

export class BootstrapCoordinator {
  constructor(private readonly deps: BootstrapDeps) {}

  // ──────────────────────────────────────────────────────────────────────
  // Follower-facing HTTP surface (`POST /join/:token` with an `action`)
  // ──────────────────────────────────────────────────────────────────────

  handleRequest(request: FollowerBootstrapRequest): Promise<Response> {
    switch (request.action) {
      case 'poll':
        return this.handlePoll(request.controllerId, request.bootstrapId, request.cursor ?? 0);
      case 'answer':
        return this.handleAnswer(request.controllerId, request.bootstrapId, request.answer);
      case 'ice-candidate':
        return this.handleIceCandidate(
          request.controllerId,
          request.bootstrapId,
          request.candidate
        );
      case 'retry':
        return this.handleRetry(request.controllerId, request.bootstrapId, request.runtime);
      default:
        return Promise.resolve(
          jsonResponse(
            { error: 'Invalid bootstrap request', code: 'INVALID_BOOTSTRAP_REQUEST' },
            400
          )
        );
    }
  }

  private async handlePoll(
    controllerId: string | undefined,
    bootstrapId: string | undefined,
    cursor: number
  ): Promise<Response> {
    const bootstrap = this.find(controllerId, bootstrapId);
    if (!bootstrap) return bootstrapNotFound();

    this.refreshState(bootstrap);
    await this.deps.persistTray();
    return await this.buildResponse(bootstrap, eventsAfter(bootstrap, cursor));
  }

  private async handleAnswer(
    controllerId: string | undefined,
    bootstrapId: string | undefined,
    answer: TraySessionDescription | undefined
  ): Promise<Response> {
    if (!isSessionDescription(answer, 'answer')) {
      return jsonResponse(
        { error: 'A valid bootstrap answer is required', code: 'INVALID_BOOTSTRAP_REQUEST' },
        400
      );
    }
    return this.relayToLeader(controllerId, bootstrapId, (bootstrap) => ({
      type: 'bootstrap.answer',
      trayId: this.deps.requireTray().trayId,
      controllerId: bootstrap.controllerId,
      bootstrapId: bootstrap.bootstrapId,
      answer,
    }));
  }

  private async handleIceCandidate(
    controllerId: string | undefined,
    bootstrapId: string | undefined,
    candidate: TrayIceCandidate | undefined
  ): Promise<Response> {
    if (!isIceCandidate(candidate)) {
      return jsonResponse(
        { error: 'A valid ICE candidate is required', code: 'INVALID_BOOTSTRAP_REQUEST' },
        400
      );
    }
    return this.relayToLeader(controllerId, bootstrapId, (bootstrap) => ({
      type: 'bootstrap.ice_candidate',
      trayId: this.deps.requireTray().trayId,
      controllerId: bootstrap.controllerId,
      bootstrapId: bootstrap.bootstrapId,
      candidate,
    }));
  }

  /**
   * Shared body of `answer` and `ice-candidate`: resolve the bootstrap, refuse
   * once it has failed, hand the signal to the leader, and fail the bootstrap
   * (retryably, if attempts remain) when the control channel is gone. The only
   * difference is the message built for the leader and — for `answer` — the
   * transition to `connected`, which the caller expresses by the message type.
   */
  private async relayToLeader(
    controllerId: string | undefined,
    bootstrapId: string | undefined,
    build: (bootstrap: TrayBootstrapRecord) => WorkerToLeaderControlMessage
  ): Promise<Response> {
    const bootstrap = this.find(controllerId, bootstrapId);
    if (!bootstrap) return bootstrapNotFound();

    this.refreshState(bootstrap);
    if (bootstrap.state === 'failed') {
      await this.deps.persistTray();
      return await this.buildResponse(bootstrap, [], 409);
    }

    const message = build(bootstrap);
    if (!this.deps.sendToLeader(message)) {
      const retryable = this.canRetry(bootstrap);
      this.fail(bootstrap, {
        code: 'LEADER_NOT_CONNECTED',
        message: 'Leader control channel is not connected',
        retryable,
        retryAfterMs: retryable ? TRAY_BOOTSTRAP_RETRY_AFTER_MS : null,
      });
      await this.deps.persistTray();
      return await this.buildResponse(bootstrap, [], 409);
    }

    // An answer completes the handshake; a trickled candidate only refreshes it.
    if (message.type === 'bootstrap.answer') {
      bootstrap.state = 'connected';
      bootstrap.failure = null;
    }
    bootstrap.updatedAt = this.deps.isoNow();
    await this.deps.persistTray();
    return await this.buildResponse(bootstrap, []);
  }

  private async handleRetry(
    controllerId: string | undefined,
    bootstrapId: string | undefined,
    runtime: string | undefined
  ): Promise<Response> {
    const bootstrap = this.find(controllerId, bootstrapId);
    if (!bootstrap) return bootstrapNotFound();

    this.refreshState(bootstrap);
    if (
      bootstrap.state !== 'failed' ||
      !bootstrap.failure?.retryable ||
      !this.canRetry(bootstrap) ||
      !this.deps.hasLiveLeader()
    ) {
      await this.deps.persistTray();
      return await this.buildResponse(bootstrap, [], 409);
    }

    this.pruneTerminal();
    const retried = this.create(
      bootstrap.controllerId,
      runtime ?? bootstrap.runtime,
      bootstrap.retryCount + 1,
      bootstrap.maxRetries,
      // Carry the seat forward: a retried bootstrap that dropped `biscottoId`
      // would be announced to the leader as a full-trust follower.
      bootstrap.biscottoId
    );
    this.deps.requireTray().bootstraps[retried.bootstrapId] = retried;
    this.notifyLeaderJoinRequested(retried, await this.deps.getIceServers());
    await this.deps.persistTray();
    return await this.buildResponse(retried, []);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Leader-facing control-socket surface
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Resolve a bootstrap named by a leader control message, telling the leader
   * when it does not exist so it stops signaling into a record we dropped.
   */
  private findForLeader(
    socket: TrayWebSocketLike,
    controllerId: string,
    bootstrapId: string
  ): TrayBootstrapRecord | null {
    const bootstrap = this.find(controllerId, bootstrapId);
    if (!bootstrap) {
      socket.send(JSON.stringify({ type: 'error', code: 'BOOTSTRAP_NOT_FOUND', bootstrapId }));
      return null;
    }
    this.refreshState(bootstrap);
    return bootstrap;
  }

  onLeaderOffer(
    socket: TrayWebSocketLike,
    message: LeaderToWorkerControlMessage & { type: 'bootstrap.offer' }
  ): void {
    const bootstrap = this.findForLeader(socket, message.controllerId, message.bootstrapId);
    if (!bootstrap || bootstrap.state === 'failed') return;
    this.appendEvent(bootstrap, { type: 'bootstrap.offer', offer: message.offer });
    bootstrap.state = 'offered';
    bootstrap.failure = null;
  }

  onLeaderIceCandidate(
    socket: TrayWebSocketLike,
    message: LeaderToWorkerControlMessage & { type: 'bootstrap.ice_candidate' }
  ): void {
    const bootstrap = this.findForLeader(socket, message.controllerId, message.bootstrapId);
    if (!bootstrap || bootstrap.state === 'failed') return;
    this.appendEvent(bootstrap, {
      type: 'bootstrap.ice_candidate',
      candidate: message.candidate,
    });
  }

  onLeaderFailed(
    socket: TrayWebSocketLike,
    message: LeaderToWorkerControlMessage & { type: 'bootstrap.failed' }
  ): void {
    const bootstrap = this.find(message.controllerId, message.bootstrapId);
    if (!bootstrap) {
      socket.send(
        JSON.stringify({
          type: 'error',
          code: 'BOOTSTRAP_NOT_FOUND',
          bootstrapId: message.bootstrapId,
        })
      );
      return;
    }
    this.fail(bootstrap, {
      code: message.code,
      message: message.message,
      retryable: message.retryable ?? this.canRetry(bootstrap),
      retryAfterMs:
        message.retryable === false
          ? null
          : (message.retryAfterMs ?? TRAY_BOOTSTRAP_RETRY_AFTER_MS),
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Record lifecycle
  // ──────────────────────────────────────────────────────────────────────

  /**
   * The bootstrap a freshly-attached follower should use, minting one (and
   * asking the leader for an offer) when there is nothing reusable.
   */
  async ensure(
    controllerId: string,
    runtime: string | undefined,
    biscottoId?: string
  ): Promise<TrayBootstrapRecord> {
    this.pruneTerminal();
    const existing = this.find(controllerId);
    // Reuse ONLY within the same capability. `controllerId` is client-supplied
    // and a non-terminal bootstrap outlives its controller record (the DO
    // prunes stale controllers, `pruneTerminal` only reaps terminal
    // bootstraps), so a guest presenting a pruned full follower's controllerId
    // would otherwise adopt that follower's `biscottoId: undefined` bootstrap
    // and be announced as `trust: 'full'` — straight past the allowlist.
    // Mismatched capability ⇒ mint a fresh one.
    if (existing && existing.biscottoId === biscottoId) {
      this.refreshState(existing);
      return existing;
    }

    const bootstrap = this.create(controllerId, runtime, 0, TRAY_BOOTSTRAP_MAX_RETRIES, biscottoId);
    this.deps.requireTray().bootstraps[bootstrap.bootstrapId] = bootstrap;
    this.notifyLeaderJoinRequested(bootstrap, await this.deps.getIceServers());
    return bootstrap;
  }

  private create(
    controllerId: string,
    runtime: string | undefined,
    retryCount = 0,
    maxRetries = TRAY_BOOTSTRAP_MAX_RETRIES,
    biscottoId?: string
  ): TrayBootstrapRecord {
    const createdAt = this.deps.isoNow();
    return {
      controllerId,
      bootstrapId: crypto.randomUUID(),
      runtime,
      attempt: retryCount + 1,
      retryCount,
      maxRetries,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(this.deps.now() + TRAY_BOOTSTRAP_TIMEOUT_MS).toISOString(),
      state: 'pending',
      failure: null,
      events: [],
      nextSequence: 1,
      biscottoId,
    };
  }

  private notifyLeaderJoinRequested(
    bootstrap: TrayBootstrapRecord,
    iceServers?: TurnIceServer[]
  ): void {
    const message: WorkerToLeaderControlMessage = {
      type: 'follower.join_requested',
      trayId: this.deps.requireTray().trayId,
      controllerId: bootstrap.controllerId,
      runtime: bootstrap.runtime,
      bootstrapId: bootstrap.bootstrapId,
      attempt: bootstrap.attempt,
      expiresAt: bootstrap.expiresAt,
      // The leader's controller socket is the ONLY authenticated channel that
      // can tell it what a peer is; the peer's own `hello` cannot be believed.
      ...this.biscottoAnnouncement(bootstrap),
    };
    if (iceServers) {
      (message as { iceServers?: TurnIceServer[] }).iceServers = iceServers;
    }
    this.deps.sendToLeader(message);
  }

  /**
   * Trust fields for a `follower.join_requested`. A bootstrap with no
   * `biscottoId` is a full follower and gets `trust: 'full'` stated
   * explicitly — silence would be ambiguous with an older hub.
   *
   * A seat that was revoked between attach and announcement resolves to no
   * record; that announces as a biscotto with its stored id and empty label
   * rather than falling back to `full`, because failing toward MORE trust here
   * would turn a revocation race into a privilege escalation.
   */
  private biscottoAnnouncement(bootstrap: TrayBootstrapRecord): {
    trust: FollowerTrust;
    biscotto?: FollowerBiscottoIdentity;
  } {
    if (!bootstrap.biscottoId) return { trust: 'full' };
    const record = (this.deps.requireTray().biscotti ?? []).find(
      (entry) => entry.id === bootstrap.biscottoId
    );
    return {
      trust: 'biscotto',
      biscotto: {
        id: bootstrap.biscottoId,
        label: record?.label ?? '',
        expiresAt: record?.expiresAt,
        gates: {
          message: normalizeBiscottoGate(record?.gates.message),
          tool: normalizeBiscottoGate(record?.gates.tool),
        },
      },
    };
  }

  private find(controllerId?: string, bootstrapId?: string): TrayBootstrapRecord | null {
    const tray = this.deps.requireTray();

    if (bootstrapId) {
      const bootstrap = tray.bootstraps[bootstrapId] ?? null;
      if (!bootstrap) {
        return null;
      }
      return controllerId && bootstrap.controllerId !== controllerId ? null : bootstrap;
    }

    if (!controllerId) {
      return null;
    }

    return (
      Object.values(tray.bootstraps)
        .filter((bootstrap) => bootstrap.controllerId === controllerId)
        .sort(
          (left, right) =>
            right.attempt - left.attempt || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        )[0] ?? null
    );
  }

  /**
   * Move a still-open bootstrap to `failed` when the world moved on under it:
   * the leader's control channel dropped, or the attempt outlived its window.
   */
  private refreshState(bootstrap: TrayBootstrapRecord): void {
    if (bootstrap.state === 'failed' || bootstrap.state === 'connected') {
      return;
    }

    const retryable = this.canRetry(bootstrap);
    const retryAfterMs = retryable ? TRAY_BOOTSTRAP_RETRY_AFTER_MS : null;

    if (!this.deps.hasLiveLeader()) {
      this.fail(bootstrap, {
        code: 'LEADER_NOT_CONNECTED',
        message: 'Leader control channel disconnected before bootstrap completed',
        retryable,
        retryAfterMs,
      });
      return;
    }

    if (this.deps.now() > Date.parse(bootstrap.expiresAt)) {
      this.fail(bootstrap, {
        code: 'BOOTSTRAP_TIMEOUT',
        message: `Bootstrap attempt timed out after ${TRAY_BOOTSTRAP_TIMEOUT_MS}ms`,
        retryable,
        retryAfterMs,
      });
    }
  }

  private fail(
    bootstrap: TrayBootstrapRecord,
    failure: Omit<TrayBootstrapFailure, 'failedAt'> & { failedAt?: string }
  ): void {
    if (bootstrap.state === 'failed') {
      return;
    }

    const failedAt = failure.failedAt ?? this.deps.isoNow();
    const normalizedFailure: TrayBootstrapFailure = { ...failure, failedAt };
    bootstrap.state = 'failed';
    bootstrap.failure = normalizedFailure;
    bootstrap.expiresAt = failedAt;
    this.appendEvent(bootstrap, { type: 'bootstrap.failed', failure: normalizedFailure }, failedAt);
  }

  private appendEvent(
    bootstrap: TrayBootstrapRecord,
    event: TrayBootstrapEventInput,
    sentAt = this.deps.isoNow()
  ): void {
    const nextEvent = {
      ...event,
      sequence: bootstrap.nextSequence,
      sentAt,
    } as TrayBootstrapEvent;
    bootstrap.nextSequence += 1;
    bootstrap.updatedAt = sentAt;
    bootstrap.events.push(nextEvent);
    // Cap events to avoid unbounded growth from SDP payloads (KB each).
    // The follower polls via cursor so only the tail matters, but the offer
    // is only carried in the events stream — preserve it at the head so a
    // burst of ICE candidates can't drop it and force a timeout+retry.
    if (bootstrap.events.length > MAX_BOOTSTRAP_EVENTS) {
      const offer = bootstrap.events.find((e) => e.type === 'bootstrap.offer');
      const tailSize = offer ? MAX_BOOTSTRAP_EVENTS - 1 : MAX_BOOTSTRAP_EVENTS;
      const tail = bootstrap.events.slice(-tailSize);
      bootstrap.events = offer && !tail.includes(offer) ? [offer, ...tail] : tail;
    }
  }

  private canRetry(bootstrap: TrayBootstrapRecord): boolean {
    return bootstrap.retryCount < bootstrap.maxRetries;
  }

  /**
   * Remove bootstrap records in a terminal state whose grace window has
   * elapsed. Called opportunistically when bootstraps are mutated.
   */
  private pruneTerminal(): void {
    const tray = this.deps.requireTray();
    const nowMs = this.deps.now();
    for (const [id, bootstrap] of Object.entries(tray.bootstraps)) {
      const isTerminal =
        bootstrap.state === 'connected' ||
        (bootstrap.state === 'failed' && !this.canRetry(bootstrap));
      if (!isTerminal) continue;
      const deadlineMs = Date.parse(bootstrap.expiresAt) + BOOTSTRAP_TERMINAL_GRACE_MS;
      if (nowMs > deadlineMs) {
        delete tray.bootstraps[id];
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Response shaping
  // ──────────────────────────────────────────────────────────────────────

  /** The follower-facing view of a bootstrap. Also embedded in the attach response. */
  buildStatus(bootstrap: TrayBootstrapRecord): TrayBootstrapStatus {
    return {
      controllerId: bootstrap.controllerId,
      bootstrapId: bootstrap.bootstrapId,
      attempt: bootstrap.attempt,
      state: bootstrap.state,
      expiresAt: bootstrap.expiresAt,
      cursor: Math.max(0, bootstrap.nextSequence - 1),
      maxRetries: bootstrap.maxRetries,
      retriesRemaining: Math.max(0, bootstrap.maxRetries - bootstrap.retryCount),
      retryAfterMs: bootstrap.failure?.retryable
        ? (bootstrap.failure.retryAfterMs ?? TRAY_BOOTSTRAP_RETRY_AFTER_MS)
        : null,
      failure: bootstrap.failure,
    };
  }

  private async buildResponse(
    bootstrap: TrayBootstrapRecord,
    events: TrayBootstrapEvent[],
    status = 200
  ): Promise<Response> {
    const tray = this.deps.requireTray();
    const iceServers = await this.deps.getIceServers();
    const payload: FollowerBootstrapResponse = {
      trayId: tray.trayId,
      controllerId: bootstrap.controllerId,
      role: 'follower',
      leader: await this.deps.leaderSummary(),
      participantCount: Object.keys(tray.controllers).length,
      bootstrap: this.buildStatus(bootstrap),
      events,
    };
    if (iceServers) {
      payload.iceServers = iceServers;
    }
    return jsonResponse(payload, status);
  }
}

/** Events strictly after `cursor`. A non-finite or negative cursor replays everything. */
function eventsAfter(bootstrap: TrayBootstrapRecord, cursor: number): TrayBootstrapEvent[] {
  const normalizedCursor = Number.isFinite(cursor) ? Math.max(0, Math.trunc(cursor)) : 0;
  return bootstrap.events.filter((event) => event.sequence > normalizedCursor);
}
