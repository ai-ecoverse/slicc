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
  /** Force the legacy wire shape: `isCone` only, no edge. */
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
  /** Prompts the transport actually received. */
  sent: Array<{ id: string | null; text: string }>;
  /** Units the transport was asked to abort. */
  stopped: string[];
  /** `true` when this transport can carry a backend queue at all (#2362). */
  carriesQueue: boolean;
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
  const stopped: string[] = [];

  const kernel = {
    getScoop: (jid: string) => roster.find((scoop) => scoop.jid === jid),
    getScoops: () => roster,
    requestScoopMessages: () => {},
    sendRaw: (message: { scoopJid?: string; text?: string }) => {
      sent.push({ id: message.scoopJid ?? null, text: message.text ?? '' });
    },
    setSelectedScoopJid: () => {},
    stopScoop: (jid: string) => stopped.push(jid),
  } as unknown as OffscreenClient;

  const client = new LocalWorkUnitClient({
    fills,
    getAwaiting: () => awaiting,
    getClient: () => kernel,
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
    carriesQueue: true,
    client,
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
  const stopped: string[] = [];
  let selected: string | null = null;

  const sync = {
    selectScoop: (jid: string) => {
      selected = jid;
    },
    sendMessage: (text: string) => sent.push({ id: selected, text }),
    stop: () => {
      if (selected) stopped.push(selected);
    },
  } as unknown as FollowerSyncManager;

  const client = new RemoteWorkUnitClient({ getSync: () => sync });
  const options: FollowerSyncManagerOptions = client.wrapOptions({} as FollowerSyncManagerOptions);

  return {
    carriesQueue: false,
    client,
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
        isCone: unit.parentId === null,
        jid: unit.id,
        name: unit.name,
        state: STATE_FOR[unit.status],
        ...(unit.legacyWire ? {} : { parentId: unit.parentId }),
        ...(unit.phase ? { activity: unit.phase } : {}),
        ...(unit.awaiting ? { activity: 'awaiting' as const } : {}),
        ...(typeof unit.fill === 'number' ? { fill: unit.fill } : {}),
        ...(unit.model ? { model: unit.model } : {}),
      }));
      selected = selectedId ?? summaries[0]?.jid ?? null;
      options.onScoopsList?.(summaries, selected ?? '');
    },
    stopped,
  };
}

/** Sort-free comparison key for a roster, so parity failures read clearly. */
export function idsOf(units: readonly WorkUnitSummary[]): string[] {
  return units.map((unit) => unit.id);
}
