/**
 * Fake kernel and fake tray for the `WorkUnitClient` conformance suite
 * (#2274).
 *
 * Each harness feeds ONE logical roster to its adapter in that transport's
 * own shape — records + page-side maps for the leader, `ScoopSummary` frames
 * for the follower — so a parity assertion over the two is a real statement
 * about the two transports, not about a shared fixture.
 */

import type {
  FollowerSyncManager,
  FollowerSyncManagerOptions,
} from '../../../src/scoops/tray-follower-sync.js';
import type { ScoopSummary } from '../../../src/scoops/tray-sync-protocol.js';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import type {
  OffscreenClient,
  OffscreenClientCallbacks,
} from '../../../src/ui/offscreen-client.js';
import type { ScoopStatus } from '../../../src/ui/wc/wc-live-callbacks.js';
import { LocalWorkUnitClient } from '../../../src/ui/work-unit-client/local.js';
import { RemoteWorkUnitClient } from '../../../src/ui/work-unit-client/remote.js';
import type { WorkUnitClient, WorkUnitSummary } from '../../../src/work-unit/client/types.js';

/** One unit as the conformance suite describes it, transport-independent. */
export interface FakeUnit {
  id: string;
  /** `null` root, a jid for a child, `undefined` only a legacy leader produces. */
  parentId: string | null | undefined;
  name: string;
  folder: string;
  assistantLabel: string;
  status: ScoopStatus;
  phase?: 'thinking' | 'tool';
  awaiting?: boolean;
  /** 0–100, the protocol's scale. */
  fill?: number;
  model?: { provider: string; id: string };
  /**
   * Force the post-#2358 wire shape: the ownership edge only, with the
   * deprecated `isCone` flag stripped — what a peer at protocol version 8
   * receives.
   */
  noRoleFlag?: boolean;
  /**
   * Force the pre-#1666 wire shape: the `isCone` flag only, no edge — what a
   * hosted leader tab opened before `parentId` landed still sends. Mutually
   * exclusive with {@link FakeUnit.noRoleFlag}, which is the opposite gap.
   */
  legacyWire?: boolean;
}

export interface ClientHarness {
  client: WorkUnitClient;
  /** Publish a roster in the transport's own shape. */
  setRoster(units: readonly FakeUnit[], selectedId?: string): void;
  /** Deliver a whole-history replay for one unit. */
  emitSnapshot(id: string, messages: readonly unknown[], queuedIds?: readonly string[]): void;
  /** Deliver an incoming (routed / lick) message. */
  emitMessage(id: string, message: { id: string; content: string }): void;
  emitStatus(id: string, status: ScoopStatus): void;
  /** Prompts the transport actually received, exactly as it received them. */
  sent: Array<{
    id: string | null;
    text: string;
    messageId?: string;
    steer?: boolean;
    guestGate?: unknown;
  }>;
  /** Model writes the transport received, in the transport's own spelling. */
  modelWrites: Array<{ id: string | null; model: string }>;
  /** Units the transport was asked to abort. */
  stopped: string[];
  /**
   * Take the transport away, as a closed kernel port or a dropped data channel
   * does. Everything that claims delivery must then FAIL rather than resolve.
   */
  disconnect(): void;
  /** Units the transport was asked to SELECT, in order (remote only). */
  selections: string[];
  /** `true` when this transport can carry a backend queue at all (#2362). */
  carriesQueue: boolean;
  /**
   * `true` when this transport can carry a turn's guest gate. Only a LOCAL one
   * can: the gate is minted by a leader from its own seat record, so a remote
   * client must refuse a gated send rather than deliver it ungated.
   */
  carriesGuestGate: boolean;
  /**
   * `true` when this transport shows exactly ONE unit at a time. A leader
   * mirrors only the selected unit to a follower, so a snapshot for another
   * unit is superseded; a kernel answers per jid, so it never is.
   */
  mirrorsOneUnit: boolean;
  /**
   * `true` when the backend acks a model write. The tray's `model.select` is
   * fire-and-forget, so a remote client answers `undefined` — "nobody could
   * answer" — and never `true`/`false`.
   */
  acksModelWrite: boolean;
}

const STATE_FOR: Record<ScoopStatus, NonNullable<ScoopSummary['state']>> = {
  error: 'broken',
  initializing: 'initializing',
  processing: 'working',
  ready: 'idle',
};

/** The leader's shape: a registered record plus the page's status maps. */
export function makeLocalHarness(): ClientHarness {
  let roster: RegisteredScoop[] = [];
  const statuses = new Map<string, ScoopStatus>();
  const fills = new Map<string, number>();
  const phases = new Map<string, 'thinking' | 'tool'>();
  let awaiting: string | null = null;
  const sent: ClientHarness['sent'] = [];
  const modelWrites: ClientHarness['modelWrites'] = [];
  const stopped: string[] = [];

  let attached = true;
  const kernel = {
    getScoop: (jid: string) => roster.find((scoop) => scoop.jid === jid),
    getScoops: () => roster,
    requestScoopMessages: () => {},
    sendRaw: (message: {
      scoopJid?: string;
      text?: string;
      messageId?: string;
      steer?: boolean;
      guestGate?: unknown;
    }) => {
      sent.push({
        id: message.scoopJid ?? null,
        text: message.text ?? '',
        ...(message.messageId ? { messageId: message.messageId } : {}),
        ...(message.steer ? { steer: true } : {}),
        ...(message.guestGate ? { guestGate: message.guestGate } : {}),
      });
    },
    // The kernel's ack: `true` for a unit it knows, `false` otherwise — the
    // routing of a child to its owning cone is the kernel's job, so the write
    // is recorded under the id the client named.
    setScoopModel: (jid: string, model: { provider: string; id: string }) => {
      modelWrites.push({ id: jid, model: `${model.provider}:${model.id}` });
      return Promise.resolve(roster.some((scoop) => scoop.jid === jid));
    },
    setSelectedScoopJid: () => {},
    stopScoop: (jid: string) => stopped.push(jid),
  } as unknown as OffscreenClient;

  const client = new LocalWorkUnitClient({
    fills,
    getAwaiting: () => awaiting,
    getClient: () => (attached ? kernel : null),
    phases,
    statuses,
  });

  // The adapter decorates the shell's callback bag; the fake shell's is empty.
  const base: OffscreenClientCallbacks = {
    onIncomingMessage: () => {},
    onScoopCreated: () => {},
    onScoopListUpdate: () => {},
    onStatusChange: () => {},
  };
  const callbacks = client.wrapCallbacks(base);

  return {
    acksModelWrite: true,
    carriesGuestGate: true,
    carriesQueue: true,
    mirrorsOneUnit: false,
    client,
    disconnect: () => {
      attached = false;
    },
    modelWrites,
    selections: [],
    emitMessage: (id, message) => {
      callbacks.onIncomingMessage(id, message as never);
    },
    emitSnapshot: (id, messages, queuedIds) => {
      (
        callbacks.onScoopMessagesReplaced as unknown as (
          jid: string,
          messages: unknown,
          queuedIds?: readonly string[]
        ) => void
      )(id, messages, queuedIds);
    },
    emitStatus: (id, status) => {
      statuses.set(id, status);
      callbacks.onStatusChange(id, status);
    },
    sent,
    setRoster: (units) => {
      roster = units.map(
        (unit) =>
          ({
            assistantLabel: unit.assistantLabel,
            config: {},
            folder: unit.folder,
            jid: unit.id,
            // A record always knows its edge; a legacy WIRE has no local twin.
            name: unit.name,
            parentJid: unit.parentId ?? null,
            ...(unit.model ? { model: unit.model } : {}),
          }) as unknown as RegisteredScoop
      );
      for (const unit of units) {
        statuses.set(unit.id, unit.status);
        if (typeof unit.fill === 'number') fills.set(unit.id, unit.fill / 100);
        if (unit.phase) phases.set(unit.id, unit.phase);
        if (unit.awaiting) awaiting = unit.id;
      }
      callbacks.onScoopListUpdate(roster as never);
    },
    stopped,
  };
}

/** The follower's shape: `ScoopSummary` frames off the tray wire. */
export function makeRemoteHarness(): ClientHarness {
  const sent: ClientHarness['sent'] = [];
  const modelWrites: ClientHarness['modelWrites'] = [];
  const stopped: string[] = [];
  const selections: string[] = [];
  /**
   * The LEADER's registry copy of this follower's selection. Seeded on join
   * (`sendSnapshotToFollower` records the unit whose transcript it sent) and
   * updated by `scoops.select` — the tray's `user_message` and `abort` frames
   * carry NO unit at all, so this is the only thing that decides where a
   * prompt lands. Modelling it here rather than stamping the client's own idea
   * of "selected" into `sent` is what makes a routing claim testable: a client
   * that never selects would silently keep hitting the join-time unit.
   */
  let leaderRoutesTo: string | null = null;

  const sync = {
    selectScoop: (jid: string) => {
      selections.push(jid);
      // The leader's `handleScoopSelection`.
      leaderRoutesTo = jid;
    },
    sendMessage: (
      text: string,
      messageId?: string,
      _attachments?: unknown,
      options?: { steer?: boolean }
    ) => {
      // The wire frame is unscoped; the leader routes it.
      sent.push({
        id: leaderRoutesTo,
        text,
        ...(messageId ? { messageId } : {}),
        ...(options?.steer ? { steer: true } : {}),
      });
      return true;
    },
    // `model.select` is the ONE follower frame that carries a unit, and the
    // leader honours it (`handleModelSelection`); it has no ack.
    selectModel: (modelId: string, scoopJid?: string) =>
      modelWrites.push({ id: scoopJid ?? leaderRoutesTo, model: modelId }),
    stop: () => {
      // `abort` is unscoped too — it aborts whatever the leader is running for
      // THIS follower, which is the unit above.
      if (leaderRoutesTo) stopped.push(leaderRoutesTo);
      return true;
    },
  } as unknown as FollowerSyncManager;

  let connected = true;
  const client = new RemoteWorkUnitClient({ getSync: () => (connected ? sync : null) });
  const options: FollowerSyncManagerOptions = client.wrapOptions({} as FollowerSyncManagerOptions);

  return {
    acksModelWrite: false,
    carriesGuestGate: false,
    carriesQueue: false,
    mirrorsOneUnit: true,
    client,
    disconnect: () => {
      connected = false;
    },
    modelWrites,
    selections,
    emitMessage: () => {
      // The tray wire has no per-unit incoming-message frame: routed messages
      // reach a follower inside the leader's next snapshot. Nothing to emit —
      // the suite skips the incremental case for this transport.
    },
    emitSnapshot: (id, messages) => {
      options.onSnapshot?.(messages as never, id);
    },
    emitStatus: (id, status) => {
      options.onStatus?.(status, id);
    },
    sent,
    setRoster: (units, selectedId) => {
      const summaries: ScoopSummary[] = units.map((unit) => ({
        assistantLabel: unit.assistantLabel,
        folder: unit.folder,
        jid: unit.id,
        name: unit.name,
        state: STATE_FOR[unit.status],
        ...(unit.legacyWire ? {} : { parentId: unit.parentId }),
        ...(unit.noRoleFlag ? {} : { isCone: unit.parentId === null }),
        ...(unit.phase ? { activity: unit.phase } : {}),
        ...(unit.awaiting ? { activity: 'awaiting' as const } : {}),
        ...(typeof unit.fill === 'number' ? { fill: unit.fill } : {}),
        ...(unit.model ? { model: unit.model } : {}),
      }));
      // Join-time seeding: the leader records the unit whose transcript it
      // just sent this follower.
      leaderRoutesTo = selectedId ?? summaries[0]?.jid ?? null;
      options.onScoopsList?.(summaries, leaderRoutesTo ?? '');
    },
    stopped,
  };
}

/** Sort-free comparison key for a roster, so parity failures read clearly. */
export function idsOf(units: readonly WorkUnitSummary[]): string[] {
  return units.map((unit) => unit.id);
}
