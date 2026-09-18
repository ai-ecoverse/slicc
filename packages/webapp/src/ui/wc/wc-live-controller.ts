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

export interface WelcomeInterceptHolder {
  intercept: ((event: LickEvent) => boolean) | null;
}

export function createWcController(
  refs: WcShellRefs,
  host: WcChatHost,
  workUnits: WorkUnitClient,
  getSelected: () => WorkUnitSummary | null,
  onIdle?: () => void,
  welcome?: WelcomeInterceptHolder
): { controller: WcChatController; agentHandle: AgentHandle } {
  const dipInstances = new Map<string, DipInstance[]>();

  void import('../legacy-styles.js')
    .then(({ loadDipStyles }) => loadDipStyles())
    .catch(() => undefined);

  let units: readonly WorkUnitSummary[] = [];
  workUnits.subscribeList((next) => {
    units = next;
  });

  const addressedUnitId = () =>
    host.addressableUnitId ? host.addressableUnitId() : (getSelected()?.id ?? null);

  const agentHandle = createWorkUnitAgentHandle(workUnits, {
    getSelectedId: addressedUnitId,
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
      const previous = dipInstances.get(message.id);
      const messageHost = els[0];
      if (!messageHost) {
        if (previous) disposeDips(previous);
        dipInstances.delete(message.id);
        return;
      }

      host.onMessageRendered?.(messageHost);

      const originUnitId = addressedUnitId() ?? undefined;
      dipInstances.set(
        message.id,
        hydrateDips(
          messageHost,
          (action, data) => {
            const event: LickEvent = {
              type: 'sprinkle',
              sprinkleName: 'inline',
              timestamp: new Date().toISOString(),
              body: { action, data },
            };
            if (welcome?.intercept?.(event)) return;
            host.sendSprinkleLick('inline', { action, data }, undefined, originUnitId);
          },
          { previous, streaming: message.isStreaming === true }
        )
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
