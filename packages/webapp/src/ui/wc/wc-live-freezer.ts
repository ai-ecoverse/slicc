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
import { defaultRootOf } from './wc-unit-context.js';

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
      try {
        const { writer } = await openVfs();
        const { resetNewSessionTmp, runNewSessionFreeze, runNewSessionFreezeQuick } = await import(
          '../new-session.js'
        );
        if (action !== 'erase') {
          const captureCompleteSnapshot = async (frozen: FrozenSession): Promise<void> => {
            const { getTranscriptExportService } = await import(
              '../../transcript/export-provider.js'
            );
            await getTranscriptExportService().captureFrozen({
              sessionId: frozen.sessionId ?? frozen.archive.id,
              title: frozen.archive.title,
              frozenAt: frozen.archive.frozenAt,
              createdAt: frozen.archive.createdAt,
              updatedAt: frozen.archive.updatedAt,
            });
          };
          if (action === 'save') {
            await runNewSessionFreeze({
              vfs: writer,
              agenticMemorySpawn: (options) => client.spawnAgent(options),
              captureCompleteSnapshot,
              onProgress: (fraction) => {
                const el = freezerNew();
                if (!el) return;
                if (fraction === null) el.removeAttribute('progress');
                else el.setAttribute('progress', String(fraction));
              },
              onBackgroundEnriched: refreshFreezer,
            });
          } else {
            await runNewSessionFreezeQuick({ vfs: writer, captureCompleteSnapshot });
          }
        }
        await resetNewSessionTmp(writer);
        await client.clearAllMessages();
        getController()?.loadMessages([]);
        window.dispatchEvent(new CustomEvent(LEADER_BROADCAST_SNAPSHOT_EVENT));
        void import('../../speech/dictation-priming.js')
          .then(({ resetDictationPriming }) => resetDictationPriming())
          .catch(() => undefined);
        refreshFreezer();
        const cone = defaultRootOf(client.getScoops());
        if (cone) selectScoop(cone);
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
    try {
      const { reader } = await openVfs();
      let entry = frozenEntries.find((candidate) => candidate.filename === slug);
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
        const cone = defaultRootOf(client.getScoops());
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
