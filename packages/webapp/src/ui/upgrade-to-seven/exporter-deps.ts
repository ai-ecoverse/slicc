/**
 * The exporter page's stores (slicc#4051). No kernel runs here, so the page
 * opens only what the export reads, directly:
 *
 * - six's kernel VFS (`slicc-fs` in OPFS, through `VirtualFS`), read-only use;
 * - `slicc-groups` (the units and licks) and the canonical conversation store;
 * - `slicc_accounts`, the global VFS and the mount table, as the leader page's
 *   `createPageProfileExportDeps` reads them.
 *
 * Six's known-secret redactor can't be reached from seven's hidden frame: no
 * node-server bridge, no extension id. The page-known secrets (`slicc_accounts`
 * keys and tokens, the GitHub token, MCP headers and URL secrets) and the
 * at-rest credential patterns still apply, and only files redaction left
 * unchanged stay in place, where they already were.
 */

import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import type { ExportServiceDeps } from '../../transcript/export-service.js';
import type { ProfileExportDeps } from '../../transcript/profile-export.js';
import type { KnownSecretBatchRedactor } from '../../transcript/redact.js';
import type { WorkUnitConversationStore } from '../../work-unit/conversation/store.js';
import { legacyRecordIsCone } from '../../work-unit/record.js';
import { createPageProfileExportDeps } from '../profile-export-deps.js';

/** Six's kernel VFS: `slicc-fs/` in OPFS. */
export const SIX_KERNEL_FS_DB_NAME = 'slicc-fs';

/** Known secrets the frame can't reach pass through; the literal and pattern layers still run. */
export const FRAME_KNOWN_SECRETS: KnownSecretBatchRedactor = {
  redact: async (texts) => texts,
};

/**
 * Units as the kernel restores them: a record saved before the ownership
 * edge gets its `parentJid` from the legacy `isCone` flag, in memory only.
 */
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

/** The exporter's deps over already-open stores. */
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
    // The secret stores need the bridge or the extension too; report none.
    storedSecretKinds: async () => [],
  };
}

/**
 * Run six's boot migration into the canonical conversation store, as the
 * kernel would (`Orchestrator.migrateConversations`), so a profile whose
 * history is still only in the legacy stores exports it. A no-op once done;
 * it never deletes a legacy record. A failure leaves the export to the
 * canonical records there are.
 */
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
  try {
    await migrateConversations({
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
    });
  } catch {
    // The kernel treats a failed pass the same way: the legacy stores are untouched.
  }
}

/** Open the stores in this page and build the deps. */
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
