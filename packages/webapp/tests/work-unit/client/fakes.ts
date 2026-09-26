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

export interface FakeUnit {
  id: string;

  parentId: string | null | undefined;
  name: string;
  folder: string;
  assistantLabel: string;
  status: ScoopStatus;
  phase?: 'thinking' | 'tool';
  awaiting?: boolean;

  fill?: number;
  model?: { provider: string; id: string };

  noRoleFlag?: boolean;

  legacyWire?: boolean;
}

export interface ClientHarness {
  client: WorkUnitClient;

  setRoster(units: readonly FakeUnit[], selectedId?: string): void;

  emitSnapshot(id: string, messages: readonly unknown[], queuedIds?: readonly string[]): void;

  emitMessage(id: string, message: { id: string; content: string }): void;
  emitStatus(id: string, status: ScoopStatus): void;

  sent: Array<{
    id: string | null;
    text: string;
    messageId?: string;
    steer?: boolean;
    guestGate?: unknown;
  }>;

  modelWrites: Array<{ id: string | null; model: string }>;

  stopped: string[];

  disconnect(): void;

  selections: string[];

  transcriptRequests: string[];

  resetSelection?: () => void;

  carriesQueue: boolean;

  carriesGuestGate: boolean;

  mirrorsOneUnit: boolean;

  acksModelWrite: boolean;
}

const STATE_FOR: Record<ScoopStatus, NonNullable<ScoopSummary['state']>> = {
  error: 'broken',
  initializing: 'initializing',
  processing: 'working',
  ready: 'idle',
};

export function makeLocalHarness(): ClientHarness {
  let roster: RegisteredScoop[] = [];
  const statuses = new Map<string, ScoopStatus>();
  const fills = new Map<string, number>();
  const phases = new Map<string, 'thinking' | 'tool'>();
  let awaiting: string | null = null;
  const sent: ClientHarness['sent'] = [];
  const modelWrites: ClientHarness['modelWrites'] = [];
  const stopped: string[] = [];
  const transcriptRequests: string[] = [];

  let attached = true;
  const kernel = {
    getScoop: (jid: string) => roster.find((scoop) => scoop.jid === jid),
    getScoops: () => roster,
    requestScoopMessages: (jid: string) => transcriptRequests.push(jid),
    sendUserMessage: (message: {
      scoopJid: string;
      text: string;
      messageId: string;
      steer?: boolean;
      guestGate?: unknown;
      attachments?: unknown;
    }) => {
      sent.push({
        id: message.scoopJid,
        text: message.text,
        messageId: message.messageId,
        ...(message.steer ? { steer: true } : {}),
        ...(message.guestGate ? { guestGate: message.guestGate } : {}),
      });
      return Promise.resolve();
    },

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
    transcriptRequests,
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

export function makeRemoteHarness(): ClientHarness {
  const sent: ClientHarness['sent'] = [];
  const modelWrites: ClientHarness['modelWrites'] = [];
  const stopped: string[] = [];
  const selections: string[] = [];

  let leaderRoutesTo: string | null = null;

  const sync = {
    selectScoop: (jid: string) => {
      selections.push(jid);

      leaderRoutesTo = jid;
    },
    sendMessage: (
      text: string,
      messageId?: string,
      _attachments?: unknown,
      options?: { steer?: boolean }
    ) => {
      sent.push({
        id: leaderRoutesTo,
        text,
        ...(messageId ? { messageId } : {}),
        ...(options?.steer ? { steer: true } : {}),
      });
      return true;
    },

    selectModel: (modelId: string, scoopJid?: string) =>
      modelWrites.push({ id: scoopJid ?? leaderRoutesTo, model: modelId }),
    stop: () => {
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
    resetSelection: () => client.resetSelection(),
    selections,
    transcriptRequests: selections,
    emitMessage: () => {},
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

      leaderRoutesTo = selectedId ?? summaries[0]?.jid ?? null;
      options.onScoopsList?.(summaries, leaderRoutesTo ?? '');
    },
    stopped,
  };
}

export function idsOf(units: readonly WorkUnitSummary[]): string[] {
  return units.map((unit) => unit.id);
}
