/**
 * The chat half of the WC shell, over the client protocol (#2382 PR D2b).
 *
 * This is what every float renders: the tab strip, the transcript, the queued
 * pile, the composer (submit and stop), the selection and the per-unit model
 * pill. All of it reads {@link WorkUnitClient} and nothing about a transport
 * — the four things that DO need one arrive through {@link WcChatHost}.
 *
 * Before this, a leader ran `attachWcClient` and a follower ran its own
 * ~300 lines inside `mountWcUiFollower`: two controllers, two strip
 * publishers, two selection paths, two composer wirings. They drifted, which
 * is the whole reason #2274 built the protocol — the follower's Stop button
 * had no listener at all until PR A, and its model pill latched an empty
 * catalog for a session (#2329).
 *
 * What is NOT here: everything that needs a kernel (VFS, terminal, monitor,
 * sprinkles, permissions, transcript export, sudo, stats) lives in
 * `attachWcWorkbench`, and everything that needs a tray (connection state,
 * the join lifecycle, the model catalog) stays with the follower mount.
 */

import { toTabDescriptors } from '../../work-unit/client/presentation.js';
import type { WorkUnitClient } from '../../work-unit/client/types.js';
import type { AgentHandle } from '../types.js';
import type { WcChatController } from './wc-chat-controller.js';
import type { WcChatHost } from './wc-chat-host.js';
import type { WcShellBoot } from './wc-live.js';
import type { WcLiveWiring } from './wc-live-callbacks.js';
import { createWcController } from './wc-live-controller.js';
import { scoopColor } from './wc-scoop-color.js';
import { type SwitcherScoop, submittedSteer, submittedText } from './wc-shell.js';

/** What a float gets back, for the wiring only it can do. */
export interface WcChatAttachment {
  controller: WcChatController;
  /** Send / stop, addressed at the selected unit. */
  agentHandle: AgentHandle;
  /** Repaint the tab strip from the current roster and selection. */
  publishStrip(): void;
}

/**
 * Install the strip publisher on the wiring and keep it fed by the roster.
 *
 * The strip is published from ONE place because its order depends on the
 * selection as well as the roster (`orderForSwitcher` puts the selected
 * cone's scoops first), so every path that moves either has to repaint — and
 * a second publisher would race the first with a different notion of "now".
 *
 * The roster is READ at repaint time (`currentUnits`), never held: the
 * leader's `awaitingInput` and the selection both move with no transport
 * event behind them, so a cached copy would render the previous instant.
 */
export function installStripPublisher(wiring: WcLiveWiring, client: WorkUnitClient): () => void {
  const publish = (): void => {
    wiring.refs.switcher.scoops = toTabDescriptors(
      client.currentUnits(),
      wiring.getSelected()?.id,
      scoopColor
    ) as SwitcherScoop[];
    wiring.refreshConeActions?.();
  };
  wiring.refreshScoops = publish;
  // Fires once immediately with the roster as it stands, so the strip is
  // never empty waiting for a first change. Never unsubscribed: the shell
  // owns this client for the lifetime of the page.
  client.subscribeList(() => publish());
  return publish;
}

/**
 * Wire the transport-agnostic chat surface onto a prepared shell.
 *
 * Order matters and is the same on both floats: the host is installed first
 * (selection routes its queue-cancel and its record read through it), then
 * the controller, then the strip publisher, then the input listeners — so a
 * click, a roster push or a submit arriving mid-wire finds a complete shell.
 */
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

  // A tab click selects a SUMMARY from the client's own roster — never a
  // record, and never the descriptor the strip is rendering, which carries
  // only what the chip draws.
  refs.switcher.addEventListener('slicc-scoop-select', (event) => {
    const key = (event as CustomEvent<{ key?: string }>).detail?.key;
    const unit = client.currentUnits().find((candidate) => candidate.id === key);
    if (unit && unit.id !== boot.getSelected()?.id) boot.selectScoop(unit);
  });

  // The avatar's two LOCAL expression channels. Neither belongs on the wire:
  // scrutiny answers whoever is typing on THIS device, and the wake is the
  // same gesture.
  refs.switcher.setAttribute('gaze-target', 'slicc-input-card');
  refs.inputCard.addEventListener('input', () => {
    refs.switcher.scrutinize();
    refs.switcher.wake();
  });

  refs.inputCard.addEventListener('submit', (event) => {
    const text = submittedText(event);
    const attachments = host.takeAttachments?.();
    // A bare submit with an attachment and no text is a real send; a bare
    // submit with neither is not.
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

  // Stop aborts the turn of the unit THIS float is reading. Guarded on the
  // controller's own turn state: a stop with nothing running is meaningless,
  // and on a follower it would abort a turn the user cannot see.
  refs.inputCard.addEventListener('stop', () => {
    if (boot.getController()?.processing) agentHandle.stop();
  });

  return { agentHandle, controller, publishStrip };
}
