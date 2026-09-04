import { resolveCurrentModel, resolveModelById } from '../../providers/account-store.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import { modelForUnit } from '../../work-unit/client/presentation.js';
import type { WorkUnitClient, WorkUnitSummary } from '../../work-unit/client/types.js';
import { type DipInstance, disposeDips, hydrateDips } from '../dip.js';
import type { AgentHandle } from '../types.js';
import { createWorkUnitAgentHandle } from '../work-unit-client/agent-handle.js';
import { WcChatController } from './wc-chat-controller.js';
import type { WcChatHost } from './wc-chat-host.js';
import type { WcShellRefs } from './wc-shell.js';
import { unitSlugFor } from './wc-unit-context.js';

/** Mutable slot for the lazily-wired welcome-flow lick interceptor. */
export interface WelcomeInterceptHolder {
  intercept: ((event: LickEvent) => boolean) | null;
}

/**
 * Controller + dip lifecycle over the client protocol (#2382 PR D2b).
 *
 * Transport-agnostic: everything it renders comes from `WorkUnitClient`, and
 * the four things a client cannot do come from {@link WcChatHost}. Both
 * floats build their controller here, so the queued pile, the dips, the
 * tool-UI cards and the busy chrome cannot drift apart again.
 */
export function createWcController(
  refs: WcShellRefs,
  host: WcChatHost,
  workUnits: WorkUnitClient,
  getSelected: () => WorkUnitSummary | null,
  onIdle?: () => void,
  welcome?: WelcomeInterceptHolder
): { controller: WcChatController; agentHandle: AgentHandle } {
  const dipInstances = new Map<string, DipInstance[]>();
  // Dips render as cards; their chrome is a lazy legacy stylesheet. Loaded
  // here because any float that renders a transcript can receive one.
  // PAGE THEMING is deliberately NOT here: the custom-theme overrides and the
  // sprinkle theme broadcast belong to a float that owns its page, and
  // applying them under a Cherry host would fight the theme that host pushed.
  void import('../legacy-styles.js')
    .then(({ loadDipStyles }) => loadDipStyles())
    .catch(() => undefined);

  // Send and stop ride the client protocol; the agent EVENT stream stays on
  // the transport that owns it — the kernel handle on a leader, the sync
  // manager on a follower (see `createWorkUnitAgentHandle`).
  /**
   * The roster, kept fresh from the protocol's push. Held rather than fetched
   * because the telemetry context below is read synchronously, on a path that
   * cannot await — and `subscribeList` fires once immediately, so it is never
   * empty for longer than the client itself is.
   *
   * Never unsubscribed: this controller lives as long as the shell does.
   */
  let units: readonly WorkUnitSummary[] = [];
  workUnits.subscribeList((next) => {
    units = next;
  });

  const agentHandle = createWorkUnitAgentHandle(workUnits, {
    // The unit the SHELL says it is showing. A follower narrows this: until
    // its leader has named a unit for this session there is nothing to
    // address, and a send would be dropped after the bubble was already
    // rendered (see `WcChatHost.addressableUnitId`).
    getSelectedId: () =>
      host.addressableUnitId ? host.addressableUnitId() : (getSelected()?.id ?? null),
    onError: (error) => host.emitAgentError(error),
    onEvent: (listener) => host.onAgentEvent(listener),
  });
  agentHandle.onEvent((event) => {
    if (event.type !== 'tool_use_start' && event.type !== 'tool_result') return;
    if (event.type === 'tool_result' && event.isError) refs.switcher.glower();
    void import('../../speech/soundscape.js')
      .then(({ playCue }) =>
        playCue(event.type === 'tool_use_start' ? 'tool-start' : 'tool-finish')
      )
      .catch(() => undefined);
  });

  const controller = new WcChatController({
    thread: refs.thread,
    agent: agentHandle,
    resolveTelemetryContext: () => {
      const unit = getSelected();
      if (!unit) return null;
      const scoopName = unitSlugFor(unit);
      try {
        // One per-unit model read (#2382 PR C): the client's summary, which is
        // the same answer the pill and the picker use.
        const pinned = modelForUnit(units, unit.id);
        const model = pinned ? resolveModelById(pinned.id, pinned.provider) : resolveCurrentModel();
        return { scoopName, model: model.id };
      } catch {
        return { scoopName, model: '' };
      }
    },
    onTurnComplete: (message) => {
      if (!host.speaksReplies) return;
      void import('../../speech/voice-reply.js')
        .then(async ({ consumeVoiceSubmission, speakReplyMarkdown }) => {
          if (!consumeVoiceSubmission()) return;
          const { endVoiceTurn, setTtsActive } = await import('../../speech/soundscape.js');
          try {
            if (message?.content) {
              setTtsActive(true);
              try {
                await speakReplyMarkdown(message.content);
              } finally {
                setTtsActive(false);
              }
            }
          } finally {
            endVoiceTurn();
          }
        })
        .catch(() => undefined);
    },
    onProcessingChange: (processing) => {
      refs.frame.toggleAttribute('data-processing', processing);
      refs.inputCard.querySelector('slicc-send-button')?.toggleAttribute('busy', processing);
      if (!processing) onIdle?.();
    },
    onBusyPhaseChange: (phase) => {
      refs.inputCard.querySelector('slicc-send-button')?.setAttribute('phase', phase);
    },
    onToolProgressChange: (fraction) => {
      const button = refs.inputCard.querySelector('slicc-send-button');
      if (!button) return;
      if (fraction === null) button.removeAttribute('progress');
      else button.setAttribute('progress', fraction.toFixed(3));
    },
    onMessageDisposed: (messageId) => {
      const instances = dipInstances.get(messageId);
      if (instances) {
        disposeDips(instances);
        dipInstances.delete(messageId);
      }
    },
    onMessageRendered: (message, els) => {
      const messageHost = els[0];
      if (!messageHost) return;
      // Before hydration on purpose: a float that replaces a dip wants the
      // replacement instead of the live one, not on top of it.
      host.onMessageRendered?.(messageHost);
      dipInstances.set(
        message.id,
        hydrateDips(messageHost, (action, data) => {
          const event: LickEvent = {
            type: 'sprinkle',
            sprinkleName: 'inline',
            timestamp: new Date().toISOString(),
            body: { action, data },
          };
          if (welcome?.intercept?.(event)) return;
          host.sendSprinkleLick('inline', { action, data });
        })
      );
    },
    onQueuedChange: (items) => refs.queuedStack.setMessages(items),
    onLickBackpressureChange: (notice) => {
      refs.lickBackpressureNotice.textContent = notice?.text ?? '';
      refs.lickBackpressureNotice.toggleAttribute('hidden', notice === null);
    },
    onToolUiAction: (requestId, action, data) => {
      host.sendToolUiAction(requestId, action, data);
    },
    onQueuedCancel: (messageId) => {
      const jid = getSelected()?.id;
      if (!jid) return;
      void host.deleteQueuedMessage(jid, messageId).catch(() => undefined);
    },
    ...(host.readOnlyToolUi ? { readOnlyToolUi: true as const } : {}),
  });

  refs.queuedStack.addEventListener('slicc-queued-remove', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (!id) return;
    controller.removeQueuedMessage(id);
    const jid = getSelected()?.id;
    if (jid) void host.deleteQueuedMessage(jid, id).catch(() => undefined);
  });
  return { controller, agentHandle };
}
