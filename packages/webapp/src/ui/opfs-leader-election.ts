/**
 * Cross-tab OPFS leader election.
 *
 * `createSyncAccessHandle` is exclusive per OPFS file across all tabs
 * and workers. With the worker-owned-OPFS regime
 * (`slicc_opfs_vfs === 'opfs'`) every standalone tab would spawn its
 * own kernel-worker and race for the same OPFS handles on boot. This
 * module elects a single writer using a `BroadcastChannel`
 * (`slicc-opfs-leader`); first-writer-wins, no failover.
 *
 * Wire protocol:
 *   - `claim {tabId, claimedAt}` — a fresh tab announcing its bid.
 *   - `ack   {tabId, claimedAt, targetTabId}` — the standing leader
 *     telling a specific claimant it lost.
 *
 * Resolution:
 *   - Leader (if any) replies to every `claim` with an `ack`.
 *   - A claimant that receives an `ack` for itself becomes a follower.
 *   - A claimant that sees a peer `claim` with an OLDER
 *     `(claimedAt, tabId)` becomes a follower (deterministic
 *     simultaneous-boot tie-break).
 *   - If no ack arrives within `electionTimeoutMs`, the claimant
 *     promotes itself to leader and keeps the channel open to
 *     respond to future claims.
 *
 * Intentionally narrow: no leader hand-off, no liveness/failover, no
 * write-tool changes. The non-leader tab's UI gates writes via the
 * `OpfsLeaderElectionResult.isLeader` flag (banner in
 * `opfs-readonly-banner.ts`).
 */

/**
 * Minimal `BroadcastChannel` shape the election relies on. The page
 * runtime supplies the real `BroadcastChannel`; tests inject a mock.
 */
export interface OpfsLeaderChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export interface OpfsLeaderInfo {
  /** Stable per-tab identifier; UUID when available. */
  tabId: string;
  /** Wall-clock time of this tab's first claim. Earlier wins. */
  claimedAt: number;
}

export interface OpfsLeaderElectionResult {
  /** True when this tab won (or stood alone). */
  isLeader: boolean;
  /** Local tab info — always populated. */
  self: OpfsLeaderInfo;
  /** Populated only when `isLeader === false`. */
  leader?: OpfsLeaderInfo;
  /**
   * Tear down the channel and listeners. Idempotent. The leader path
   * keeps the channel alive between `elect` resolution and `dispose`
   * so it can ack subsequent claimants.
   */
  dispose: () => void;
}

export interface OpfsLeaderElectionOptions {
  /** Channel name. Default `slicc-opfs-leader`. */
  channelName?: string;
  /** Ms to wait for an existing leader's ack. Default 300. */
  electionTimeoutMs?: number;
  /** Test override for this tab's id. */
  tabId?: string;
  /** Test override for this tab's claim timestamp. */
  claimedAt?: number;
  /** Inject a channel factory; defaults to global `BroadcastChannel`. */
  channelFactory?: (name: string) => OpfsLeaderChannelLike;
  /** Inject a clock; defaults to `Date.now`. */
  now?: () => number;
  /** Optional logger; defaults to console. */
  logger?: { warn(message: string, ...rest: unknown[]): void };
}

interface ClaimMessage {
  type: 'opfs-leader:claim';
  tabId: string;
  claimedAt: number;
}

interface AckMessage {
  type: 'opfs-leader:ack';
  tabId: string;
  claimedAt: number;
  targetTabId: string;
}

type OpfsLeaderMessage = ClaimMessage | AckMessage;

const DEFAULT_CHANNEL_NAME = 'slicc-opfs-leader';
const DEFAULT_ELECTION_TIMEOUT_MS = 300;

/** Lower-wins comparator on `(claimedAt, tabId)`. */
function isOlder(a: OpfsLeaderInfo, b: OpfsLeaderInfo): boolean {
  if (a.claimedAt !== b.claimedAt) return a.claimedAt < b.claimedAt;
  return a.tabId < b.tabId;
}

function isClaim(data: unknown): data is ClaimMessage {
  if (typeof data !== 'object' || data === null) return false;
  const m = data as Partial<ClaimMessage>;
  return (
    m.type === 'opfs-leader:claim' && typeof m.tabId === 'string' && typeof m.claimedAt === 'number'
  );
}

function isAck(data: unknown): data is AckMessage {
  if (typeof data !== 'object' || data === null) return false;
  const m = data as Partial<AckMessage>;
  return (
    m.type === 'opfs-leader:ack' &&
    typeof m.tabId === 'string' &&
    typeof m.claimedAt === 'number' &&
    typeof m.targetTabId === 'string'
  );
}

function generateTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `opfs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Run the OPFS leader election. Resolves with `{ isLeader, self,
 * leader?, dispose }`. The caller MUST eventually call `dispose()` —
 * the leader keeps the channel open between resolution and dispose so
 * it can ack any newcomers.
 */
export function electOpfsLeader(
  opts: OpfsLeaderElectionOptions = {}
): Promise<OpfsLeaderElectionResult> {
  const channelName = opts.channelName ?? DEFAULT_CHANNEL_NAME;
  const electionTimeoutMs = opts.electionTimeoutMs ?? DEFAULT_ELECTION_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const log = opts.logger ?? console;

  const self: OpfsLeaderInfo = {
    tabId: opts.tabId ?? generateTabId(),
    claimedAt: opts.claimedAt ?? now(),
  };

  const factory =
    opts.channelFactory ??
    ((name: string): OpfsLeaderChannelLike =>
      new BroadcastChannel(name) as unknown as OpfsLeaderChannelLike);

  let channel: OpfsLeaderChannelLike;
  try {
    channel = factory(channelName);
  } catch (err) {
    // No BroadcastChannel available (very old browser, restricted
    // context). Fall back to leader — single-tab mode is the only
    // safe assumption; downstream code keeps the OPFS writer path.
    log.warn(
      '[opfs-leader] BroadcastChannel unavailable; defaulting to leader',
      err instanceof Error ? err.message : String(err)
    );
    return Promise.resolve({
      isLeader: true,
      self,
      dispose: () => {},
    });
  }

  return new Promise<OpfsLeaderElectionResult>((resolve) => {
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let isLeader = false;
    // Peer claims we saw during the race where we were OLDER than the
    // peer — i.e., we'd be the leader in that pair. The peer may not
    // have seen our claim (race-startup ordering means the peer's
    // bus subscription can post-date our initial broadcast). When we
    // promote to leader, ack every saved peer so they fail over to
    // follower deterministically. Without this, the late-joining tab
    // misses our claim AND our future broadcast and ends up
    // double-leadering on its own timeout.
    const pendingAcks = new Map<string, OpfsLeaderInfo>();

    const sendAck = (target: OpfsLeaderInfo): void => {
      const ack: AckMessage = {
        type: 'opfs-leader:ack',
        tabId: self.tabId,
        claimedAt: self.claimedAt,
        targetTabId: target.tabId,
      };
      channel.postMessage(ack);
    };

    const onMessage = (ev: MessageEvent): void => {
      const data = ev.data as OpfsLeaderMessage;
      if (isClaim(data)) {
        if (data.tabId === self.tabId) return;
        if (isLeader) {
          // Standing leader: tell the newcomer it lost.
          sendAck({ tabId: data.tabId, claimedAt: data.claimedAt });
          return;
        }
        if (resolved) return;
        const peer: OpfsLeaderInfo = { tabId: data.tabId, claimedAt: data.claimedAt };
        if (isOlder(peer, self)) {
          finishAsFollower(peer);
        } else {
          // We're older. Remember the peer; if we win the race we
          // need to ack them since they may not have seen our claim.
          pendingAcks.set(peer.tabId, peer);
        }
        return;
      }
      if (isAck(data)) {
        if (data.targetTabId !== self.tabId) return;
        if (resolved) return;
        finishAsFollower({ tabId: data.tabId, claimedAt: data.claimedAt });
        return;
      }
    };

    const finishAsFollower = (leader: OpfsLeaderInfo): void => {
      if (resolved) return;
      resolved = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      // Followers do NOT need the channel further — they're inert.
      channel.removeEventListener('message', onMessage);
      try {
        channel.close();
      } catch {
        /* test mocks may not support close */
      }
      disposed = true;
      resolve({
        isLeader: false,
        self,
        leader,
        dispose: () => {
          /* already torn down */
        },
      });
    };

    const finishAsLeader = (): void => {
      if (resolved) return;
      resolved = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      isLeader = true;
      // Ack peers we already saw during the race. Race-startup
      // ordering can mean a younger peer never received our initial
      // claim (their bus subscription post-dated our broadcast); a
      // follow-up ack closes that window before their election
      // timeout promotes them to a duplicate leader.
      for (const peer of pendingAcks.values()) sendAck(peer);
      pendingAcks.clear();
      // Keep the channel open so we can ack subsequent claimants
      // until the caller disposes us.
      resolve({
        isLeader: true,
        self,
        dispose: () => {
          if (disposed) return;
          disposed = true;
          channel.removeEventListener('message', onMessage);
          try {
            channel.close();
          } catch {
            /* test mocks may not support close */
          }
        },
      });
    };

    channel.addEventListener('message', onMessage);

    const claim: ClaimMessage = {
      type: 'opfs-leader:claim',
      tabId: self.tabId,
      claimedAt: self.claimedAt,
    };
    try {
      channel.postMessage(claim);
    } catch (err) {
      // Posting failed — treat as leader by default; better to keep
      // the writer path on this tab than to silently disable writes.
      log.warn(
        '[opfs-leader] initial claim postMessage failed; defaulting to leader',
        err instanceof Error ? err.message : String(err)
      );
      finishAsLeader();
      return;
    }

    timeoutId = setTimeout(finishAsLeader, electionTimeoutMs);
  });
}
