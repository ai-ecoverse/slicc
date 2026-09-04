import type { BootStageLogger } from '../boot/types.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { WcPageVfs, WcShellBoot } from './wc-live.js';
import {
  applyLeaderLocalThinkingChange,
  effortOverrideForAgent,
  hydratePersistedConeSession,
  thinkingLevelForAgent,
} from './wc-live-thinking-hydration.js';

/**
 * The leader's composer EXTRAS: the suggested placeholder, persisted-session
 * hydration, the VFS-backed add-menu, history navigation and the thinking
 * picker.
 *
 * Submit, stop and the avatar's local gaze channels are NOT here — they are
 * the same on every float and live in `attachWcChat` (#2382 D2b). What is
 * left is everything that needs a kernel: a VFS to stage a file from, a
 * persisted session to hydrate, a record to write a reasoning level onto.
 */
export function wireWcComposer(deps: {
  boot: WcShellBoot;
  client: OffscreenClient;
  setRefreshPlaceholder(fn: () => void): void;
  triggerPlaceholder(): void;
  openReader(): Promise<WcPageVfs['reader']>;
  openWriter(): Promise<WcPageVfs['writer']>;
  log: BootStageLogger;
}): { getAttachStage(): import('./wc-attach.js').WcAttachmentStage | null } {
  const { boot, client, openReader, log } = deps;
  const { refs } = boot;
  void import('./wc-placeholder.js').then(({ createPlaceholderRefresher }) => {
    deps.setRefreshPlaceholder(
      createPlaceholderRefresher({
        inputCard: refs.inputCard as HTMLElement & { value?: string },
        getMessages: () => boot.getController()?.getMessages() ?? [],
        defaultPlaceholder:
          refs.inputCard.getAttribute('placeholder') ?? 'Ask sliccy, or describe a change…',
      })
    );
  });

  void hydratePersistedConeSession({
    pendingUrlContext: boot.wiring.pendingUrlContext,
    win: window,
    hasSelection: () => !!boot.getSelected(),
    loadMessages: (messages) => boot.getController()?.loadMessages(messages),
    onHydrated: deps.triggerPlaceholder,
  }).catch((err) => log.warn('WC session hydration failed', err));

  let attachStage: import('./wc-attach.js').WcAttachmentStage | null = null;
  void import('./wc-attach.js')
    .then(({ wireWcAttach }) => {
      attachStage = wireWcAttach({
        inputCard: refs.inputCard as HTMLElement & { value?: string },
        freezer: refs.freezer,
        composer: refs.composer,
        openReader,
        openWriter: deps.openWriter,
        listConversations: async () => {
          const { readSessionsIndex } = await import('../session-freezer.js');
          const entries = await readSessionsIndex(await openReader());
          return entries.map((entry) => ({
            id: entry.filename,
            label: entry.title,
            sub: `${entry.messageCount} turns`,
          }));
        },
        log,
      });
    })
    .catch((err) => log.error('WC add-menu wiring failed', err));

  void import('./wc-history-nav.js')
    .then(({ wireWcHistoryNav }) =>
      wireWcHistoryNav({ thread: refs.thread, inputCard: refs.inputCard })
    )
    .catch((err) => log.error('WC history nav wiring failed', err));

  refs.composerMeta.addEventListener('thinking-change', (event) => {
    if (localStorage.getItem('slicc_locked_effort_level')) return;
    const metaLevel = (event as CustomEvent<{ thinking?: string }>).detail?.thinking;
    const level = thinkingLevelForAgent(metaLevel);
    const effort = effortOverrideForAgent(metaLevel);
    const selected = boot.getSelected();
    if (selected && level) {
      void applyLeaderLocalThinkingChange(client, selected.id, level, effort).catch((err) =>
        log.warn('local thinking update failed', err)
      );
    }
  });

  return { getAttachStage: () => attachStage };
}
