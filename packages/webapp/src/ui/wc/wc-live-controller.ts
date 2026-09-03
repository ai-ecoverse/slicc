import { resolveCurrentModel, resolveModelById } from '../../providers/account-store.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import { modelForUnit } from '../../work-unit/client/presentation.js';
import type { WorkUnitClient, WorkUnitSummary } from '../../work-unit/client/types.js';
import { type DipInstance, disposeDips, hydrateDips } from '../dip.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { AgentHandle } from '../types.js';
import { createWorkUnitAgentHandle } from '../work-unit-client/agent-handle.js';
import { WcChatController } from './wc-chat-controller.js';
import type { WcShellRefs } from './wc-shell.js';
import { unitSlugFor } from './wc-unit-context.js';

/** Mutable slot for the lazily-wired welcome-flow lick interceptor. */
export interface WelcomeInterceptHolder {
  intercept: ((event: LickEvent) => boolean) | null;
}

/** Controller + dip lifecycle over the live agent handle. */
export function createWcController(
  refs: WcShellRefs,
  client: OffscreenClient,
  workUnits: WorkUnitClient,
  getSelected: () => RegisteredScoop | null,
  onIdle?: () => void,
  welcome?: WelcomeInterceptHolder
): { controller: WcChatController; agentHandle: AgentHandle } {
  const dipInstances = new Map<string, DipInstance[]>();
  void import('../legacy-styles.js')
    .then(({ loadDipStyles }) => loadDipStyles())
    .catch(() => undefined);
  void import('../theme.js')
    .then(({ watchSprinkleThemeBroadcast }) => watchSprinkleThemeBroadcast())
    .catch(() => undefined);
  void import('../theme-engine.js')
    .then(({ applyThemeOverrides }) => applyThemeOverrides())
    .catch(() => undefined);

  // Send and stop ride the client protocol; the agent EVENT stream stays on
  // the kernel handle, which is the transport that owns it (see
  // `createWorkUnitAgentHandle`). One selection rule for both: the unit the
  // panel says it is showing.
  const kernelEvents = client.createAgentHandle();
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
    getSelectedId: () => client.selectedScoopJid,
    onError: (error) => client.emitAgentError(error),
    onEvent: (listener) => kernelEvents.onEvent(listener),
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
      const scoop = getSelected();
      if (!scoop) return null;
      const scoopName = unitSlugFor(scoop);
      try {
        // One per-unit model read (#2382 PR C): the client's summary, which is
        // the same answer the pill and the picker use.
        const pinned = modelForUnit(units, scoop.jid);
        const model = pinned ? resolveModelById(pinned.id, pinned.provider) : resolveCurrentModel();
        return { scoopName, model: model.id };
      } catch {
        return { scoopName, model: '' };
      }
    },
    onTurnComplete: (message) => {
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
      const host = els[0];
      if (!host) return;
      dipInstances.set(
        message.id,
        hydrateDips(host, (action, data) => {
          const event: LickEvent = {
            type: 'sprinkle',
            sprinkleName: 'inline',
            timestamp: new Date().toISOString(),
            body: { action, data },
          };
          if (welcome?.intercept?.(event)) return;
          client.sendSprinkleLick('inline', { action, data });
        })
      );
    },
    onQueuedChange: (items) => refs.queuedStack.setMessages(items),
    onLickBackpressureChange: (notice) => {
      refs.lickBackpressureNotice.textContent = notice?.text ?? '';
      refs.lickBackpressureNotice.toggleAttribute('hidden', notice === null);
    },
    onToolUiAction: (requestId, action, data) => {
      client.sendToolUiAction(requestId, action, data);
    },
    onQueuedCancel: (messageId) => {
      const jid = client.selectedScoopJid;
      if (!jid) return;
      void client.deleteQueuedMessage(jid, messageId).catch(() => undefined);
    },
  });

  refs.queuedStack.addEventListener('slicc-queued-remove', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (!id) return;
    controller.removeQueuedMessage(id);
    const jid = client.selectedScoopJid;
    if (jid) void client.deleteQueuedMessage(jid, id).catch(() => undefined);
  });
  return { controller, agentHandle };
}
