import { isFeatureEnabled } from '../../core/feature-flags.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import type { WorkUnitSummary } from '../../work-unit/client/types.js';
import { tmpDirFor } from '../../work-unit/descriptor.js';
import { isRootUnit } from '../../work-unit/policy.js';
import type { BootStageLogger } from '../boot/types.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { FrozenSession } from '../session-freezer.js';
import {
  LEADER_BROADCAST_SNAPSHOT_EVENT,
  LEADER_RUN_NEW_SESSION_EVENT,
  type LeaderRunNewSessionDetail,
} from './leader-session-events.js';
import type { WcChatController } from './wc-chat-controller.js';
import {
  coneBadgeFor,
  enrichFreezerIcons,
  FREEZER_TINT,
  type FrozenSessionIndexEntry,
  readFreezerEntries,
  readFreezerIndexState,
  rebuildFreezerIndexFromArchives,
  renderFreezerCards,
  SESSIONS_INDEX_PATH,
  thawFrozenSession,
} from './wc-freezer.js';
import type { WcPageVfs } from './wc-live.js';
import { applyShellContext, type WcShellRefs } from './wc-shell.js';
import {
  defaultRootOf,
  rootForConeFolder,
  rootForSelection,
  switcherLabelFor,
} from './wc-unit-context.js';

export interface FreezerRailDeps {
  refs: WcShellRefs;
  openVfs(): Promise<WcPageVfs>;
  client: OffscreenClient;
  getController(): WcChatController | null;
  getSelected(): WorkUnitSummary | null;
  selectScoop(unit: WorkUnitSummary): void;

  getUnits(): readonly WorkUnitSummary[];
  clearSelection(): void;

  holdQueuedPile(): void;
  log: BootStageLogger;
}

export interface FreezerRailHandles {
  refreshFreezer(): void;
  openFrozen(slug: string): Promise<void>;
  getViewedFrozenSessionId(): string | null;

  freezeCone(root: RegisteredScoop): Promise<void>;
}

interface ArchiveConeSessionDeps {
  action: 'save' | 'skip';
  writer: Awaited<ReturnType<FreezerRailDeps['openVfs']>>['writer'];

  root: RegisteredScoop | undefined;
  client: Pick<OffscreenClient, 'spawnAgent' | 'sendSprinkleLick' | 'getScoops'>;
  freezerNew(): HTMLElement | null;
  refreshFreezer(): void;
  runNewSessionFreeze: typeof import('../new-session.js').runNewSessionFreeze;
  runNewSessionFreezeQuick: typeof import('../new-session.js').runNewSessionFreezeQuick;
  log: BootStageLogger;
}

async function captureCompleteSnapshotFor(
  root: RegisteredScoop | undefined,
  frozen: FrozenSession
): Promise<void> {
  const { getTranscriptExportService } = await import('../../transcript/export-provider.js');
  await getTranscriptExportService().captureFrozen({
    sessionId: frozen.sessionId ?? frozen.archive.id,
    title: frozen.archive.title,
    frozenAt: frozen.archive.frozenAt,
    createdAt: frozen.archive.createdAt,
    updatedAt: frozen.archive.updatedAt,
    ...(root ? { rootJid: root.jid } : {}),
  });
}

function recordFor(
  client: OffscreenClient,
  unit: { id: string } | undefined
): RegisteredScoop | undefined {
  if (!unit) return undefined;
  return client.getScoops().find((scoop) => scoop.jid === unit.id);
}

function archiveConeTarget(root: RegisteredScoop): { folder: string; label: string; jid: string } {
  return {
    folder: root.folder,
    label: switcherLabelFor({
      assistantLabel: root.assistantLabel,
      name: root.name,
      role: isRootUnit(root) ? 'primary' : 'child',
    }),
    jid: root.jid,
  };
}

async function archiveConeSession(deps: ArchiveConeSessionDeps): Promise<void> {
  const { root } = deps;

  const cone = root ? archiveConeTarget(root) : undefined;
  const captureCompleteSnapshot = (frozen: FrozenSession): Promise<void> =>
    captureCompleteSnapshotFor(root, frozen);

  const onSessionSettled = (entry: FrozenSessionIndexEntry | null): void => {
    void import('./wc-gelatiere.js')
      .then(({ notifyGelatiereOfSessionEnd }) =>
        notifyGelatiereOfSessionEnd({
          client: deps.client,
          vfs: deps.writer,
          log: deps.log,
          cone,
          archive: entry?.filename,
        })
      )
      .catch((err) => deps.log.warn('gelatiere notification failed to load', err));
  };
  if (deps.action !== 'save') {
    await deps.runNewSessionFreezeQuick({
      vfs: deps.writer,
      cone,
      captureCompleteSnapshot,
      onSessionSettled,
    });
    return;
  }
  await deps.runNewSessionFreeze({
    vfs: deps.writer,
    cone,
    agenticMemorySpawn: (options) => deps.client.spawnAgent(options),
    captureCompleteSnapshot,
    onSessionSettled,
    onProgress: (fraction) => {
      const el = deps.freezerNew();
      if (!el) return;
      if (fraction === null) el.removeAttribute('progress');
      else el.setAttribute('progress', String(fraction));
    },
    onBackgroundEnriched: deps.refreshFreezer,
  });
}

async function archiveUnlessErase(
  action: 'save' | 'skip' | 'erase',
  deps: Omit<ArchiveConeSessionDeps, 'action'>
): Promise<void> {
  if (action === 'erase') return;
  await archiveConeSession({ ...deps, action });
}

interface ClearConeSessionDeps {
  writer: ArchiveConeSessionDeps['writer'];

  root: RegisteredScoop | undefined;
  client: Pick<OffscreenClient, 'clearAllMessages'>;

  discardLiveSnapshot: boolean;
  getController(): WcChatController | null;
  log: BootStageLogger;
  resetNewSessionTmp: typeof import('../new-session.js').resetNewSessionTmp;

  tmpDir: string;
}

async function clearConeSession(deps: ClearConeSessionDeps): Promise<void> {
  try {
    await deps.resetNewSessionTmp(deps.writer, deps.tmpDir);
  } catch (err) {
    deps.log.warn('WC new session /tmp reset failed — clearing anyway', err);
  }
  await deps.client.clearAllMessages(
    deps.root?.jid,
    deps.discardLiveSnapshot ? { discardLiveSnapshot: true } : {}
  );
  deps.getController()?.loadMessages([]);
  window.dispatchEvent(new CustomEvent(LEADER_BROADCAST_SNAPSHOT_EVENT));
  void import('../../speech/dictation-priming.js')
    .then(({ resetDictationPriming }) => resetDictationPriming())
    .catch(() => undefined);
}

function paintFrozenChrome(refs: WcShellRefs, entry: FrozenSessionIndexEntry | undefined): void {
  const column = (refs.thread as { inner?: HTMLElement }).inner ?? refs.thread;
  column.prepend(frozenProvenanceEl(refs.thread.ownerDocument, entry));
  refs.thread.setAttribute('accent', FREEZER_TINT);
  applyShellContext(refs, { kind: 'freezer' });
  refs.inputCard.setAttribute('disabled', '');
  refs.switcher.removeAttribute('active');
}

export function frozenProvenanceEl(
  doc: Document,
  entry: Pick<FrozenSessionIndexEntry, 'cone' | 'coneLabel'> | undefined
): HTMLElement {
  const cone = entry ? coneBadgeFor(entry as FrozenSessionIndexEntry) : undefined;
  const el = doc.createElement('slicc-day-separator');
  el.setAttribute('label', cone ? `Frozen chat · from cone ${cone}` : 'Frozen chat');
  el.setAttribute('data-frozen-provenance', cone ?? '');
  return el;
}

export function wireFreezerRail(deps: FreezerRailDeps): FreezerRailHandles {
  const { refs, openVfs, client, getController, getSelected, clearSelection, log } = deps;
  let frozenEntries: FrozenSessionIndexEntry[] = [];
  let currentFrozenSessionId: string | null = null;
  const selectScoop = (unit: WorkUnitSummary): void => {
    currentFrozenSessionId = null;
    deps.selectScoop(unit);
  };

  let refreshSeq = 0;
  let iconEnriching = false;
  const refreshFreezer = (): void => {
    const seq = ++refreshSeq;
    void openVfs()
      .then(async ({ reader, writer }) => {
        let entries = await readFreezerEntries(reader);
        if (entries === null) {
          const state = await readFreezerIndexState(reader);
          if (state.kind !== 'corrupt') return;
          log.warn('WC freezer index corrupt — rebuilding from archives');
          entries = await rebuildFreezerIndexFromArchives(reader);
          if (entries.length === 0) return;
          await writer.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(entries, null, 2));
        }
        if (seq !== refreshSeq) return;
        frozenEntries = entries;
        renderFreezerCards(refs.freezer, entries);
        if (!iconEnriching && entries.some((entry) => !entry.icon && !entry.pendingEnrichment)) {
          iconEnriching = true;
          void import('../../providers/quick-llm.js')
            .then(({ pickLucideIcon }) =>
              enrichFreezerIcons({
                reader,
                writer,
                freezer: refs.freezer,
                entries,
                pickIcon: (subject) => pickLucideIcon({ subject }),
              })
            )
            .catch((err) => log.warn('WC freezer icon enrichment failed', err))
            .finally(() => {
              iconEnriching = false;
            });
        }
      })
      .catch((err) => log.error('WC freezer refresh failed', err));
  };

  let newSessionInFlight = false;
  const freezerNew = (): HTMLElement | null => refs.freezer.querySelector('slicc-freezer-new');
  const runNewSession = (action: 'save' | 'skip' | 'erase'): void => {
    if (newSessionInFlight) return;
    newSessionInFlight = true;
    freezerNew()?.setAttribute('busy', '');
    void (async () => {
      const root = recordFor(client, rootForSelection(deps.getUnits(), getSelected()));
      try {
        const { writer } = await openVfs();
        const { resetNewSessionTmp, runNewSessionFreeze, runNewSessionFreezeQuick } = await import(
          '../new-session.js'
        );
        await archiveUnlessErase(action, {
          writer,
          root,
          client,
          freezerNew,
          refreshFreezer,
          runNewSessionFreeze,
          runNewSessionFreezeQuick,
          log,
        });

        await clearConeSession({
          writer,
          root,
          client,
          getController,
          log,
          resetNewSessionTmp,
          tmpDir: tmpDirFor(client.getScoops(), root),
          discardLiveSnapshot: action === 'erase',
        });
        refreshFreezer();

        const next =
          deps.getUnits().find((unit) => unit.id === root?.jid) ?? defaultRootOf(deps.getUnits());
        if (next) selectScoop(next);
      } catch (err) {
        log.error('WC new session failed', err);
      } finally {
        newSessionInFlight = false;
        const el = freezerNew();
        el?.removeAttribute('busy');
        el?.removeAttribute('progress');
      }
    })();
  };

  for (const action of ['save', 'skip', 'erase'] as const) {
    refs.freezer.addEventListener(`new-chat-${action}`, () => runNewSession(action));
  }

  const freezeCone = async (root: RegisteredScoop): Promise<void> => {
    const { writer } = await openVfs();
    const { runNewSessionArchiveOnly } = await import('../new-session.js');
    await runNewSessionArchiveOnly({
      vfs: writer,
      cone: archiveConeTarget(root),
      captureCompleteSnapshot: (frozen) => captureCompleteSnapshotFor(root, frozen),
    });
    refreshFreezer();
  };
  if (isFeatureEnabled('agentic-memory')) freezerNew()?.setAttribute('no-skip', '');
  window.addEventListener(LEADER_RUN_NEW_SESSION_EVENT, (event) => {
    const action = (event as CustomEvent<Partial<LeaderRunNewSessionDetail>>).detail?.action;
    if (action === 'save' || action === 'skip' || action === 'erase') runNewSession(action);
  });

  const openFrozen = async (slug: string): Promise<void> => {
    let entry = frozenEntries.find((candidate) => candidate.filename === slug);
    try {
      const { reader } = await openVfs();
      if (!entry) {
        entry = ((await readFreezerEntries(reader)) ?? []).find(
          (candidate) => candidate.filename === slug
        );
      }
      const { messages } = await thawFrozenSession(
        reader,
        entry ?? { filename: slug, title: slug, frozenAt: '', messageCount: 0 }
      );
      refs.thread.setAttribute('context', `freezer:${entry?.filename ?? slug}`);
      currentFrozenSessionId = entry?.sessionId ?? entry?.filename ?? null;

      deps.holdQueuedPile();
      getController()?.loadMessages(messages);
      paintFrozenChrome(refs, entry);
      clearSelection();
    } catch (err) {
      log.error('WC thaw failed', err);
      if (!getSelected()) {
        const cone = rootForConeFolder(deps.getUnits(), entry?.cone);
        if (cone) selectScoop(cone);
      }
    }
  };

  refs.freezer.addEventListener('freezer-card-select', (event) => {
    const slug = (event as CustomEvent<{ slug?: string }>).detail?.slug;
    if (slug) void openFrozen(slug);
  });

  return {
    refreshFreezer,
    openFrozen,
    getViewedFrozenSessionId: () => currentFrozenSessionId,
    freezeCone,
  };
}
