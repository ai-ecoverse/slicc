import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import type { ExportServiceDeps } from '../../transcript/export-service.js';
import type { ProfileExportDeps } from '../../transcript/profile-export.js';
import type { KnownSecretBatchRedactor } from '../../transcript/redact.js';
import type { WorkUnitConversationStore } from '../../work-unit/conversation/store.js';
import { legacyRecordIsCone } from '../../work-unit/record.js';
import { createPageProfileExportDeps } from '../profile-export-deps.js';

export const SIX_KERNEL_FS_DB_NAME = 'slicc-fs';

export const FRAME_KNOWN_SECRETS: KnownSecretBatchRedactor = {
  redact: async (texts) => texts,
};

export function restoredUnits(records: readonly RegisteredScoop[]): RegisteredScoop[] {
  const rootJid = records.find((s) => legacyRecordIsCone(s))?.jid;
  return records.map((s) =>
    s.parentJid !== undefined
      ? s
      : { ...s, parentJid: legacyRecordIsCone(s) ? null : (rootJid ?? null) }
  );
}

export interface UpgradeExportStores {
  vfs: LocalVfsClient;
  units: readonly RegisteredScoop[];
  loadPersistedSessions: ExportServiceDeps['collection']['loadPersistedSessions'];
  loadUiChatSessions: ExportServiceDeps['collection']['loadUiChatSessions'];
  readSnapshot: ExportServiceDeps['snapshotStore']['read'];
  version: string;
}

export function createUpgradeExportDeps(stores: UpgradeExportStores): ProfileExportDeps {
  const units = stores.units;
  const cone = units.find((u) => u.parentJid === null);
  const serviceDeps: ExportServiceDeps = {
    collection: {
      listScoops: () => units,
      isProcessing: () => false,
      getAgentMessages: () => null,
      loadPersistedSessions: stores.loadPersistedSessions,
      loadUiChatSessions: stores.loadUiChatSessions,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    knownSecrets: FRAME_KNOWN_SECRETS,
    snapshotStore: {
      read: stores.readSnapshot,
      write: async () => {
        throw new Error('The upgrade exporter never writes into six.');
      },
    },
    vfs: stores.vfs,
    getActiveSessionInfo: () => ({ id: cone?.jid ?? 'session', title: cone?.name ?? 'SLICC' }),
    version: stores.version,
  };
  return {
    ...createPageProfileExportDeps({
      serviceDeps,
      listUnits: () => units,
      version: stores.version,
    }),

    storedSecretKinds: async () => [],
  };
}

export const SIX_HISTORY_UNREADABLE_ERROR =
  "Some of SLICC 6's chat history couldn't be read. Nothing was moved; try again.";

export async function migrateLegacyConversations(
  store: WorkUnitConversationStore,
  units: readonly RegisteredScoop[]
): Promise<void> {
  const [{ migrateConversations }, { SessionStore }, { SessionStore: UiSessionStore }] =
    await Promise.all([
      import('../../work-unit/conversation/migration.js'),
      import('../../core/session.js'),
      import('../../scoops/chat-session-store.js'),
    ]);
  const agentSessions = new SessionStore();
  const uiSessions = new UiSessionStore();
  let skipped = 0;
  try {
    ({ skipped } = await migrateConversations({
      store,
      units: [...units],
      loadAgentSession: async (id) => {
        const saved = await agentSessions.load(id);
        return saved ? { messages: saved.messages, createdAt: saved.createdAt } : null;
      },
      loadChatSession: async (id) => {
        const saved = await uiSessions.load(id);
        return saved ? { messages: saved.messages, createdAt: saved.createdAt } : null;
      },
    }));
  } catch {
    throw new Error(SIX_HISTORY_UNREADABLE_ERROR);
  }
  if (skipped > 0) throw new Error(SIX_HISTORY_UNREADABLE_ERROR);
}

export async function openUpgradeExportDeps(version: string): Promise<ProfileExportDeps> {
  const [{ VirtualFS }, db, { CanonicalSessionReader }, { WorkUnitConversationStore }, snap] =
    await Promise.all([
      import('../../fs/index.js'),
      import('../../scoops/db.js'),
      import('../../work-unit/conversation/sessions.js'),
      import('../../work-unit/conversation/store.js'),
      import('../../transcript/snapshot-store.js'),
    ]);
  const fs = await VirtualFS.create({ dbName: SIX_KERNEL_FS_DB_NAME });
  const vfs = fs as unknown as LocalVfsClient;
  const store = new WorkUnitConversationStore();
  const units = restoredUnits(Object.values(await db.getAllScoops()));
  await migrateLegacyConversations(store, units);
  const sessions = new CanonicalSessionReader(store);
  return createUpgradeExportDeps({
    vfs,
    units,
    loadPersistedSessions: () => sessions.loadAgentSessions(),
    loadUiChatSessions: () => sessions.loadChatSessions(),
    readSnapshot: (sessionId) => snap.readSnapshot(vfs, sessionId),
    version,
  });
}
