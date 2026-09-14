import { toTabDescriptors } from '../../work-unit/client/presentation.js';
import type { WorkUnitClient } from '../../work-unit/client/types.js';
import { UnreadLedger } from '../../work-unit/client/unread.js';
import type { AgentHandle } from '../types.js';
import type { WcChatController } from './wc-chat-controller.js';
import type { WcChatHost } from './wc-chat-host.js';
import type { WcShellBoot } from './wc-live.js';
import type { WcLiveWiring } from './wc-live-callbacks.js';
import { createWcController } from './wc-live-controller.js';
import { scoopColor } from './wc-scoop-color.js';
import { type SwitcherScoop, submittedSteer, submittedText } from './wc-shell.js';

export interface WcChatAttachment {
  controller: WcChatController;

  agentHandle: AgentHandle;

  publishStrip(): void;
}

export function installStripPublisher(wiring: WcLiveWiring, client: WorkUnitClient): () => void {
  const unread = new UnreadLedger();
  const publish = (): void => {
    const units = client.currentUnits();
    const selectedId = wiring.getSelected()?.id;
    wiring.refs.switcher.scoops = toTabDescriptors(
      units,
      selectedId,
      scoopColor,
      unread.sync(units, selectedId)
    ) as SwitcherScoop[];
    wiring.refreshConeActions?.();
  };
  wiring.refreshScoops = publish;

  client.subscribeList(() => publish());
  return publish;
}

export function attachWcChat(
  boot: WcShellBoot,
  client: WorkUnitClient,
  host: WcChatHost
): WcChatAttachment {
  const { refs } = boot;
  boot.setChatTransport(client, host);

  const { controller, agentHandle } = createWcController(
    refs,
    host,
    client,
    () => boot.getSelected(),
    host.onTurnIdle,
    host.welcome
  );
  boot.setController(controller);

  const publishStrip = installStripPublisher(boot.wiring, client);

  refs.switcher.addEventListener('slicc-scoop-select', (event) => {
    const key = (event as CustomEvent<{ key?: string }>).detail?.key;
    const unit = client.currentUnits().find((candidate) => candidate.id === key);
    if (unit && unit.id !== boot.getSelected()?.id) boot.selectScoop(unit);
  });

  refs.switcher.setAttribute('gaze-target', 'slicc-input-card');
  refs.inputCard.addEventListener('input', () => {
    refs.switcher.scrutinize();
    refs.switcher.wake();
  });

  refs.inputCard.addEventListener('submit', (event) => {
    const text = submittedText(event);
    const attachments = host.takeAttachments?.();

    if (!text && !attachments?.length) return;
    boot.wiring.awaitingInput = null;
    boot.wiring.refreshScoops?.();
    boot.wiring.notifyScoopStateChanged?.();
    const dictation =
      (event as unknown as CustomEvent<{ source?: string }>).detail?.source === 'dictation';
    if (dictation && host.speaksReplies) {
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
    controller.sendUserMessage(text ?? '', attachments, {
      dictation,
      steer: submittedSteer(event),
    });
    (refs.inputCard as HTMLElement & { clear?: () => void }).clear?.();
    const jid = boot.getSelected()?.id;
    if (jid) {
      refs.switcher.setAttribute('attention', jid);
      boot.wiring.lastActivity.set(jid, (text ?? '').slice(0, 600));
    }
  });

  refs.inputCard.addEventListener('stop', () => {
    if (boot.getController()?.processing) agentHandle.stop();
  });

  return { agentHandle, controller, publishStrip };
}
