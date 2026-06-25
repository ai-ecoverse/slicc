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

/**
 * Render a terminal boot error into the app root (createElement/textContent,
 * not innerHTML). Used when the follower can't even start — e.g. a cherry
 * handshake rejection — so the user/host sees a message instead of a blank page.
 */
function renderFollowerBootError(app: HTMLElement, message: string): void {
  while (app.firstChild) app.removeChild(app.firstChild);
  const box = document.createElement('div');
  box.style.cssText = 'padding:2rem;text-align:center;font-family:system-ui;';
  const h = document.createElement('h1');
  h.style.color = 'var(--s2-negative, #e34850)';
  h.textContent = 'Could not start follower';
  const p = document.createElement('p');
  p.style.color = 'var(--s2-content-tertiary, #717171)';
  p.textContent = message;
  box.append(h, p);
  app.appendChild(box);
}

/**
 * Follower mode has no kernel worker, so there's no local VFS, shell, or memory
 * store — the Files, Terminal, and Memory panels in the shared shell layout are
 * inert (nothing populates them, and the follower-sync protocol doesn't stream
 * the leader's filesystem, terminal, or memory). Replace them with the same
 * `wcui-placeholder` treatment the Browser surface already uses so the user gets
 * an explanation instead of an empty/black panel. A follower mirrors the
 * leader's chat, sprinkles, and browser tabs — not its filesystem/shell/memory.
 */
function renderFollowerInertPanels(
  fileTree: HTMLElement,
  termSurface: HTMLElement,
  memoryHost: HTMLElement
): void {
  const placeholder = (text: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'wcui-placeholder';
    el.textContent = text;
    return el;
  };
  // Files: the file tree is never wired in follower mode — hide it and explain.
  fileTree.style.display = 'none';
  fileTree.parentElement?.append(
    placeholder(
      'Files live on the leader. A follower mirrors the leader’s chat, sprinkles, and browser tabs — not its filesystem.'
    )
  );
  // Terminal: the surface host stays empty in follower mode — drop a note in.
  termSurface.append(
    placeholder(
      'The shell runs on the leader. A follower has no local terminal — drive the session through chat.'
    )
  );
  // Memory: the global-memory view is kernel-backed and unused in follower mode.
  memoryHost.append(
    placeholder('Memory lives on the leader. A follower has no local memory store.')
  );
}

export async function mountWcUiFollower(
  app: HTMLElement,
  bootLog: BootStageLogger,
  runtimeMode: UiRuntimeMode
): Promise<void> {
  const isCherry = runtimeMode === 'cherry';

  // The prelude builds the page BrowserAPI/transport (and, for cherry, completes
  // the host handshake — which can reject on a bad joinToken/origin/timeout).
  // Guard it so a failure shows a message instead of a blank page.
  let prelude: Awaited<ReturnType<typeof setupStandalonePrelude>>;
  try {
    prelude = await setupStandalonePrelude({
      runtimeMode,
      envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
      window,
      log: bootLog,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('follower prelude failed', { runtimeMode, error: message });
    renderFollowerBootError(app, message);
    return;
  }

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
  // No kernel worker in follower mode → the Files/Terminal/Memory panels are
  // inert. Swap them for an explanatory placeholder instead of an empty panel.
  renderFollowerInertPanels(boot.refs.fileTree, boot.refs.termSurface, boot.refs.memoryHost);
  const controller = new WcChatController({
    thread: boot.refs.thread,
    agent: NOOP_AGENT,
    onQueuedChange: (items) => {
      boot.refs.queuedStack.setMessages(items);
    },
  });
  boot.setController(controller);

  // Connection-state UX: the composer holds a NOOP agent until the WebRTC
  // channel connects and the real follower sync is installed via setChatAgent.
  // Keep it DISABLED until then so input typed pre-connect can't be silently
  // dropped, and surface a clear status via the placeholder.
  const CONNECTING = 'Connecting to leader…';
  const CONNECTED = 'Ask the leader, or describe a change…';
  // Terminal: the auto-reconnect loop exhausted its attempts (initial failures
  // now route through that loop too — see tray-webrtc startFollowerWithAutoReconnect).
  const GAVE_UP = "Couldn't reach the leader. Reload to retry.";
  const setComposerState = (enabled: boolean, placeholder: string): void => {
    boot.refs.inputCard.setAttribute('placeholder', placeholder);
    if (enabled) boot.refs.inputCard.removeAttribute('disabled');
    else boot.refs.inputCard.setAttribute('disabled', '');
  };
  setComposerState(false, CONNECTING);

  // Composer submit → forward to the (follower-sync) agent the controller holds.
  boot.refs.inputCard.addEventListener('submit', (event) => {
    const text = submittedText(event);
    if (text) {
      controller.sendUserMessage(text);
      (boot.refs.inputCard as HTMLElement & { clear?: () => void }).clear?.();
    }
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
    onConnectionChange: (connected) =>
      setComposerState(connected, connected ? CONNECTED : CONNECTING),
    onGaveUp: (lastError) => {
      log.error('follower gave up reaching the leader', { error: lastError });
      setComposerState(false, GAVE_UP);
    },
    addSprinkle: sprinkleCallbacks.addSprinkle,
    removeSprinkle: sprinkleCallbacks.removeSprinkle,
    onOpen: (path) => {
      if (/^https?:\/\//.test(path)) window.open(path, '_blank', 'noopener');
      else log.warn('follower sprinkle open() of a local path is unavailable', { path });
    },
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

  // Task 4: Navigate-lick watcher for non-cherry follower. Capture its stop fn
  // so switch-out tears down the CDP listeners before reload.
  let stopNavigateWatcher: (() => void) | null = null;
  if (!isCherry) {
    const { startFollowerNavigateWatcher } = await import('../follower-navigate-watcher.js');
    stopNavigateWatcher = startFollowerNavigateWatcher(
      prelude.realCdpTransport,
      () => follower.currentSync
    );
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
        stopFollower: () => {
          stopNavigateWatcher?.();
          follower.stop();
        },
        getHref: () => window.location.href,
        replaceHref: (url) => window.history.replaceState(null, '', url),
        reload: () => window.location.reload(),
      }
    );
  });

  log.info('follower mounted', { runtimeMode, isCherry });
}
