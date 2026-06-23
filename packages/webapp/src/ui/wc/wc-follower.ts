import { createLogger } from '../../core/logger.js';
import { resolveFollowerJoinUrl } from '../../scoops/tray-runtime-config.js';
import { setupStandalonePrelude } from '../boot/setup-standalone-prelude.js';
import type { BootStageLogger } from '../boot/types.js';
import { performFollowerSwitchOut } from '../follower-switch-out.js';
import { CHERRY_RUNTIME_TAG, startPageFollowerTray } from '../page-follower-tray.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import type { AgentHandle } from '../types.js';
import { WcChatController } from './wc-chat-controller.js';
import { prepareWcShell } from './wc-live.js';
import { submittedText } from './wc-shell.js';
import { WcSprinkleZone } from './wc-sprinkles.js';

const log = createLogger('wc-follower');

/** A placeholder agent until the follower sync connects and replaces it via setChatAgent. */
const NOOP_AGENT: AgentHandle = {
  sendMessage: () => {},
  onEvent: () => () => {},
  stop: () => {},
};

export async function mountWcUiFollower(
  app: HTMLElement,
  bootLog: BootStageLogger,
  runtimeMode: UiRuntimeMode
): Promise<void> {
  const prelude = await setupStandalonePrelude({
    runtimeMode,
    envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
    window,
    log: bootLog,
  });

  const isCherry = runtimeMode === 'cherry';
  const joinUrl = isCherry
    ? prelude.cherryJoinUrl
    : resolveFollowerJoinUrl(window.location.href, window.localStorage);
  if (!joinUrl) {
    log.error('follower mount with no join URL — falling back to live boot');
    const { mountWcUiLive } = await import('./wc-live.js');
    return mountWcUiLive(app, bootLog, 'standalone');
  }

  // Reuse the WC shell frame WITHOUT a client (never call boot.setClient /
  // attachWcClient — those require an OffscreenClient + spawn the worker).
  const boot = prepareWcShell(app, isCherry ? 'cherry · follower' : 'follower');
  const controller = new WcChatController({ thread: boot.refs.thread, agent: NOOP_AGENT });
  boot.setController(controller);
  boot.refs.inputCard.removeAttribute('disabled');

  // Composer submit → forward to the (follower-sync) agent the controller holds.
  boot.refs.inputCard.addEventListener('submit', (event) => {
    const text = submittedText(event);
    if (text) controller.sendUserMessage(text);
  });

  const sprinkleZone = new WcSprinkleZone(boot.refs);
  const sprinkleCallbacks = sprinkleZone.callbacks();

  const follower = startPageFollowerTray({
    joinUrl,
    runtime: isCherry ? CHERRY_RUNTIME_TAG : 'slicc-standalone',
    browserAPI: prelude.browser,
    onSnapshot: (messages) => controller.loadMessages(messages),
    // Real signatures: onUserMessage(text, messageId, scoopJid, attachments?)
    // and WcChatController.addUserMessage(text, attachments?) — match wc-tray.ts:97.
    onUserMessage: (text, _messageId, _scoopJid, attachments) =>
      controller.addUserMessage(text, attachments),
    onStatus: (status) => controller.setProcessing(status === 'processing'),
    setChatAgent: (agent) => controller.setAgent(agent),
    addSprinkle: sprinkleCallbacks.addSprinkle,
    removeSprinkle: sprinkleCallbacks.removeSprinkle,
    ...(isCherry
      ? {
          onCherrySliccEvent: (name, detail) =>
            prelude.cherryTransport?.emitSliccEventToHost(name, detail),
        }
      : {}),
  });

  if (isCherry && prelude.cherryTransport) {
    prelude.cherryTransport.onHostEvent = (name, detail) =>
      follower.currentSync?.sendCherryHostEvent(name, detail);
  }

  // Task 4: Navigate-lick watcher for non-cherry follower.
  if (!isCherry) {
    const { startFollowerNavigateWatcher } = await import('../follower-navigate-watcher.js');
    startFollowerNavigateWatcher(prelude.realCdpTransport, () => follower.currentSync);
  }

  // Task 6 (switch-out): Minimal follower nav menu + tray-leave listener.
  // (wireWcNav needs a worker client; a follower has none, so we set the
  // menu items directly.)
  boot.refs.avatarMenu.items = [
    { kind: 'separator' },
    { id: 'tray-stop', label: 'Disconnect from leader', icon: 'unplug', danger: true },
  ];
  boot.refs.avatarMenu.addEventListener('slicc-avatar-action', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (id === 'tray-stop') {
      window.dispatchEvent(
        new CustomEvent('slicc:tray-leave', { detail: { workerBaseUrl: null } })
      );
    }
  });

  window.addEventListener('slicc:tray-leave', (ev) => {
    const detail = (ev as CustomEvent<{ workerBaseUrl?: string | null }>).detail ?? {};
    performFollowerSwitchOut(
      { workerBaseUrl: detail.workerBaseUrl ?? null },
      {
        storage: window.localStorage,
        stopFollower: () => follower.stop(),
        reload: () => window.location.reload(),
      }
    );
  });

  log.info('follower mounted', { runtimeMode, isCherry });
}
