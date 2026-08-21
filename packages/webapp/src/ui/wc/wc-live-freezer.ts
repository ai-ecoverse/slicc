import { isFeatureEnabled } from '../../core/feature-flags.js';
import type { RegisteredScoop } from '../../scoops/types.js';
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
  getSelected(): RegisteredScoop | null;
  selectScoop(scoop: RegisteredScoop): void;
  clearSelection(): void;
  log: BootStageLogger;
}

export interface FreezerRailHandles {
  refreshFreezer(): void;
  openFrozen(slug: string): Promise<void>;
  getViewedFrozenSessionId(): string | null;
}

interface ArchiveConeSessionDeps {
  action: 'save' | 'skip';
  writer: Awaited<ReturnType<FreezerRailDeps['openVfs']>>['writer'];
  /** Root being archived; `undefined` only if the roster is empty. */
  root: RegisteredScoop | undefined;
  client: Pick<OffscreenClient, 'spawnAgent'>;
  freezerNew(): HTMLElement | null;
  refreshFreezer(): void;
  runNewSessionFreeze: typeof import('../new-session.js').runNewSessionFreeze;
  runNewSessionFreezeQuick: typeof import('../new-session.js').runNewSessionFreezeQuick;
}

/**
 * The archive half of "New chat" — everything before the clear. Both the
 * Markdown freeze and the complete-snapshot capture are scoped to `root`
 * (#2272): a sibling cone's conversation does not belong in this archive's
 * bundle, and a sibling cone's running turn must not hold up the freeze.
 */
async function archiveConeSession(deps: ArchiveConeSessionDeps): Promise<void> {
  const { root } = deps;
  const cone = root ? { folder: root.folder, label: switcherLabelFor(root) } : undefined;
  const captureCompleteSnapshot = async (frozen: FrozenSession): Promise<void> => {
    const { getTranscriptExportService } = await import('../../transcript/export-provider.js');
    await getTranscriptExportService().captureFrozen({
      sessionId: frozen.sessionId ?? frozen.archive.id,
      title: frozen.archive.title,
      frozenAt: frozen.archive.frozenAt,
      createdAt: frozen.archive.createdAt,
      updatedAt: frozen.archive.updatedAt,
      ...(root ? { rootJid: root.jid } : {}),
    });
  };
  if (deps.action !== 'save') {
    await deps.runNewSessionFreezeQuick({ vfs: deps.writer, cone, captureCompleteSnapshot });
    return;
  }
  await deps.runNewSessionFreeze({
    vfs: deps.writer,
    cone,
    agenticMemorySpawn: (options) => deps.client.spawnAgent(options),
    captureCompleteSnapshot,
    onProgress: (fraction) => {
      const el = deps.freezerNew();
      if (!el) return;
      if (fraction === null) el.removeAttribute('progress');
      else el.setAttribute('progress', String(fraction));
    },
    onBackgroundEnriched: deps.refreshFreezer,
  });
}

/** Wire frozen-session refresh, new-session actions, and read-only thaw routing. */
export function wireFreezerRail(deps: FreezerRailDeps): FreezerRailHandles {
  const { refs, openVfs, client, getController, getSelected, clearSelection, log } = deps;
  let frozenEntries: FrozenSessionIndexEntry[] = [];
  let currentFrozenSessionId: string | null = null;
  const selectScoop = (scoop: RegisteredScoop): void => {
    currentFrozenSessionId = null;
    deps.selectScoop(scoop);
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
      // "New chat" belongs to the cone the user is looking at (#2272): a
      // selected scoop resolves to the root that owns it, nothing selected
      // to the default root. Captured BEFORE the awaits so a roster refresh
      // mid-freeze cannot move the target between archive and clear.
      const root = rootForSelection(client.getScoops(), getSelected());
      try {
        const { writer } = await openVfs();
        const { resetNewSessionTmp, runNewSessionFreeze, runNewSessionFreezeQuick } = await import(
          '../new-session.js'
        );
        if (action !== 'erase') {
          await archiveConeSession({
            action,
            writer,
            root,
            client,
            freezerNew,
            refreshFreezer,
            runNewSessionFreeze,
            runNewSessionFreezeQuick,
          });
        }
        await resetNewSessionTmp(writer);
        await client.clearAllMessages(root?.jid);
        getController()?.loadMessages([]);
        window.dispatchEvent(new CustomEvent(LEADER_BROADCAST_SNAPSHOT_EVENT));
        void import('../../speech/dictation-priming.js')
          .then(({ resetDictationPriming }) => resetDictationPriming())
          .catch(() => undefined);
        refreshFreezer();
        // Stay on the cone we just cleared — its record may have been
        // replaced by a roster refresh, so re-resolve by jid.
        const next =
          client.getScoops().find((scoop) => scoop.jid === root?.jid) ??
          defaultRootOf(client.getScoops());
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
  if (isFeatureEnabled('agentic-memory')) freezerNew()?.setAttribute('no-skip', '');
  window.addEventListener(LEADER_RUN_NEW_SESSION_EVENT, (event) => {
    const action = (event as CustomEvent<Partial<LeaderRunNewSessionDetail>>).detail?.action;
    if (action === 'save' || action === 'skip' || action === 'erase') runNewSession(action);
  });

  const openFrozen = async (slug: string): Promise<void> => {
    // Hoisted so the catch can route the fallback selection to the cone the
    // archive named, even when the thaw itself is what failed.
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
      getController()?.loadMessages(messages);
      refs.thread.setAttribute('accent', FREEZER_TINT);
      applyShellContext(refs, { kind: 'freezer' });
      refs.inputCard.setAttribute('disabled', '');
      refs.switcher.removeAttribute('active');
      clearSelection();
    } catch (err) {
      log.error('WC thaw failed', err);
      if (!getSelected()) {
        // Fall back to the cone the archive came from, not blindly to the
        // primary one (#2272); legacy archives carry no `cone` field and
        // resolve to the default root as before.
        const cone = rootForConeFolder(client.getScoops(), entry?.cone);
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
  };
}
