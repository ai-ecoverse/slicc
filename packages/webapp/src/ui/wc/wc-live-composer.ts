import type { BootStageLogger } from '../boot/types.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { WcPageVfs, WcShellBoot } from './wc-live.js';
import {
  applyLeaderLocalThinkingChange,
  effortOverrideForAgent,
  hydratePersistedConeSession,
  thinkingLevelForAgent,
} from './wc-live-thinking-hydration.js';
import { submittedSteer, submittedText } from './wc-shell.js';

/** Composer wiring: hydration, attachments, submit/stop, history, and thinking. */
export function wireWcComposer(deps: {
  boot: WcShellBoot;
  client: OffscreenClient;
  agentHandle: ReturnType<OffscreenClient['createAgentHandle']>;
  setRefreshPlaceholder(fn: () => void): void;
  triggerPlaceholder(): void;
  openReader(): Promise<WcPageVfs['reader']>;
  openWriter(): Promise<WcPageVfs['writer']>;
  log: BootStageLogger;
}): { getAttachStage(): import('./wc-attach.js').WcAttachmentStage | null } {
  const { boot, client, agentHandle, openReader, log } = deps;
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

  refs.switcher.setAttribute('gaze-target', 'slicc-input-card');
  refs.inputCard.addEventListener('input', () => {
    refs.switcher.scrutinize();
    refs.switcher.wake();
  });

  refs.inputCard.addEventListener('submit', (event) => {
    const text = submittedText(event);
    if (!text) return;
    boot.wiring.awaitingInput = null;
    boot.wiring.refreshScoops?.();
    boot.wiring.notifyScoopStateChanged?.();
    const dictation =
      (event as unknown as CustomEvent<{ source?: string }>).detail?.source === 'dictation';
    if (dictation) {
      void import('../../speech/voice-reply.js')
        .then(({ markVoiceSubmission }) => markVoiceSubmission())
        .catch(() => undefined);
      void import('../../speech/soundscape.js')
        .then(({ beginVoiceTurn, playCue }) => {
          beginVoiceTurn();
          playCue('sent');
        })
        .catch(() => undefined);
    }
    boot.getController()?.sendUserMessage(text, attachStage?.take(), {
      dictation,
      steer: submittedSteer(event),
    });
    (refs.inputCard as HTMLElement & { clear?: () => void }).clear?.();
    const jid = boot.getSelected()?.jid;
    if (jid) {
      refs.switcher.setAttribute('attention', jid);
      boot.wiring.lastActivity.set(jid, text.slice(0, 600));
    }
  });

  refs.inputCard.addEventListener('stop', () => {
    if (boot.getController()?.processing) agentHandle.stop();
  });

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
      void applyLeaderLocalThinkingChange(client, selected.jid, level, effort).catch((err) =>
        log.warn('local thinking update failed', err)
      );
    }
  });

  return { getAttachStage: () => attachStage };
}
