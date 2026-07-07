import { createLogger } from '../../core/logger.js';
import { resolveFollowerJoinUrl, storeTrayJoinUrl } from '../../scoops/tray-runtime-config.js';
import { setupStandalonePrelude } from '../boot/setup-standalone-prelude.js';
import type { BootStageLogger } from '../boot/types.js';
import { type DipInstance, disposeDips, hydrateDips } from '../dip.js';
import { performFollowerSwitchOut } from '../follower-switch-out.js';
import { CHERRY_RUNTIME_TAG, startPageFollowerTray } from '../page-follower-tray.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import { applyCherryTheme } from '../theme-engine.js';
import type { AgentHandle } from '../types.js';
import { wireWcAttach } from './wc-attach.js';
import { WcChatController } from './wc-chat-controller.js';
import { prepareWcShell } from './wc-live.js';
import { scoopColor } from './wc-scoop-color.js';
import { submittedText } from './wc-shell.js';
import {
  buildWelcomeHandoffCard,
  isLoginDipAction,
  showSignInRedirect,
} from './wc-signin-redirect.js';
import { WcSprinkleZone } from './wc-sprinkles.js';

const log = createLogger('wc-follower');

/** Source-path prefix of the onboarding welcome dips (`welcome.shtml`,
 *  `connect-llm.shtml`) posted by the onboarding orchestrator as
 *  `![…](/shared/sprinkles/welcome/…)` image references. */
const WELCOME_DIP_SRC_PREFIX = '/shared/sprinkles/welcome/';

/** A placeholder agent until the follower sync connects and replaces it via setChatAgent. */
const NOOP_AGENT: AgentHandle = {
  sendMessage: () => {},
  onEvent: () => () => {},
  stop: () => {},
};

/**
 * Render a terminal boot error into the app root (createElement/textContent,
 * not innerHTML). Used when the follower can't even start - e.g. a cherry
 * handshake rejection - so the user/host sees a message instead of a blank page.
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
 * Follower mode has no kernel worker, so there's no local VFS, shell, memory
 * store, or orchestrator - the Files, Terminal, Memory, and Monitor panels in
 * the shared shell layout are inert (nothing populates them, and the
 * follower-sync protocol doesn't stream the leader's filesystem, terminal,
 * memory, or kernel/orchestrator state that Monitor reads - scoops, session
 * cost, processes, cron tasks, webhooks, mounts, MCP servers, and OAuth
 * accounts). Replace them with the same `wcui-placeholder` treatment the
 * Browser surface already uses so the user gets an explanation instead of an
 * empty/black panel. A follower mirrors the leader's chat, sprinkles, and
 * browser tabs - not its filesystem/shell/memory/kernel state.
 *
 * When cherry features disable a panel (feature = false), the entire
 * `slicc-surface` parent is removed from the DOM so the tab bar auto-hides it.
 */
function renderFollowerInertPanels(
  fileTree: HTMLElement,
  termSurface: HTMLElement,
  memoryHost: HTMLElement,
  monitor: HTMLElement,
  features: { terminal: boolean; files: boolean; memory: boolean; monitor: boolean }
): void {
  const placeholder = (text: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'wcui-placeholder';
    el.textContent = text;
    return el;
  };
  // Files: the file tree is never wired in follower mode - hide it and explain.
  if (!features.files) {
    // Completely remove the files surface from DOM
    fileTree.closest('slicc-surface')?.remove();
  } else {
    fileTree.style.display = 'none';
    fileTree.parentElement?.append(
      placeholder(
        "Files live on the leader. A follower mirrors the leader's chat, sprinkles, and browser tabs - not its filesystem."
      )
    );
  }
  // Terminal: the surface host stays empty in follower mode - drop a note in.
  if (!features.terminal) {
    // Completely remove the terminal surface from DOM
    termSurface.closest('slicc-surface')?.remove();
  } else {
    termSurface.append(
      placeholder(
        'The shell runs on the leader. A follower has no local terminal - drive the session through chat.'
      )
    );
  }
  // Memory: the global-memory view is kernel-backed and unused in follower mode.
  if (!features.memory) {
    // Completely remove the memory surface from DOM
    memoryHost.closest('slicc-surface')?.remove();
  } else {
    memoryHost.append(
      placeholder('Memory lives on the leader. A follower has no local memory store.')
    );
  }
  // Monitor: the dashboard (scoops, session cost, processes, cron tasks,
  // webhooks, mounts, MCP servers, OAuth accounts) is entirely
  // orchestrator/kernel-backed - never wired in follower mode, so the panel
  // would otherwise render permanently empty.
  if (!features.monitor) {
    // Completely remove the monitor surface from DOM
    monitor.closest('slicc-surface')?.remove();
  } else {
    monitor.style.display = 'none';
    monitor.parentElement?.append(
      placeholder("Monitor reads the leader's kernel state. A follower has no local kernel.")
    );
  }
}

interface CherryFeatureSet {
  terminal: boolean;
  files: boolean;
  memory: boolean;
  browser: boolean;
  modelPicker: boolean;
  history: boolean;
  nav: boolean;
  newSprinkle: boolean;
  monitor: boolean;
}

/** All features enabled — the default for non-cherry followers. */
const ALL_FEATURES_ENABLED: CherryFeatureSet = {
  terminal: true,
  files: true,
  memory: true,
  browser: true,
  modelPicker: true,
  history: true,
  nav: true,
  newSprinkle: true,
  monitor: true,
};

/**
 * Inject a persistent stylesheet hiding disabled UI elements. CSS survives
 * DOM re-renders (dock rebuilds when sprinkle tabs change), unlike DOM removal.
 */
function applyFeatureVisibility(features: CherryFeatureSet): void {
  const hidden: string[] = [];

  const dockMap: [keyof CherryFeatureSet, string][] = [
    ['terminal', 'term'],
    ['files', 'files'],
    ['memory', 'memory'],
    ['browser', 'browser'],
    ['monitor', 'monitor'],
    ['newSprinkle', 'new'],
  ];
  for (const [feat, dockId] of dockMap) {
    if (!features[feat]) hidden.push(`slicc-dock-item[data-t="${dockId}"]`);
  }

  if (!features.modelPicker) hidden.push('slicc-composer-meta');
  if (!features.history) hidden.push('slicc-freezer');
  if (!features.nav) hidden.push('slicc-nav');
  if (
    !features.terminal &&
    !features.files &&
    !features.memory &&
    !features.browser &&
    !features.monitor
  ) {
    hidden.push('slicc-dock .div', 'slicc-dock .grow');
  }

  if (hidden.length || !features.history) {
    const style = document.createElement('style');
    let css = hidden.length ? `${hidden.join(',\n')}{display:none!important;}` : '';
    if (!features.history) css += '\n.wcui-appcol{padding-left:0!important;}';
    style.textContent = css;
    document.head.append(style);
  }
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: follower boot has sequential setup steps
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: follower boot has sequential setup steps
export async function mountWcUiFollower(
  app: HTMLElement,
  bootLog: BootStageLogger,
  runtimeMode: UiRuntimeMode
): Promise<void> {
  const isCherry = runtimeMode === 'cherry';
  const uiOnly = isCherry && new URLSearchParams(window.location.search).get('ui-only') === '1';
  // The login hand-off (welcome-dip replacement, sign-in card, open-leader-tab)
  // is EXTENSION-SIDE-PANEL-ONLY. Only that follower host can complete it: its
  // cherry host (`sidepanel-entry.ts`) relays `slicc.open-leader-tab` to the SW,
  // which focuses the pinned leader tab and opens its Settings dialog. A general
  // cherry embed in a third-party page has no such leader tab, so the hand-off
  // must NOT fire there (its host page owns onboarding). The side panel is the
  // only follower whose immediate ancestor is the extension origin — its parent
  // is `sidepanel.html` at `chrome-extension://<id>`. `ancestorOrigins` is
  // Chromium/WebKit-only; the extension is Chromium, so the optional-chain
  // fallback simply disables the hand-off elsewhere.
  const ancestorOrigin = window.location.ancestorOrigins?.[0];
  const isExtensionSidePanel =
    isCherry && (ancestorOrigin?.startsWith('chrome-extension://') ?? false);

  // The prelude builds the page BrowserAPI/transport (and, for cherry, completes
  // the host handshake - which can reject on a bad joinToken/origin/timeout).
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
    log.error('follower mount with no join URL - falling back to live boot');
    const { mountWcUiLive } = await import('./wc-live.js');
    return mountWcUiLive(app, bootLog, 'standalone');
  }

  // Reuse the WC shell frame WITHOUT a client (never call boot.setClient /
  // attachWcClient - those require an OffscreenClient + spawn the worker).
  const boot = prepareWcShell(app, isCherry ? 'cherry · follower' : 'follower');

  // Apply host-supplied theme AFTER the shell mounts — mountWcShell's
  // ensureSystemTheme() sets body data-theme from OS preference, so we must
  // override it afterward. The static import (not dynamic await) keeps this
  // synchronous with no flash.
  if (isCherry && prelude.cherryTransport?.theme) {
    applyCherryTheme(prelude.cherryTransport.theme);
  }
  // No kernel worker in follower mode → the Files/Terminal/Memory panels are
  // inert. Swap them for an explanatory placeholder instead of an empty panel.
  // For cherry followers, respect the host's feature toggles; for regular followers,
  // show all panels by default.
  const cherryEffortLevel = isCherry && prelude.cherryTransport?.effortLevel;
  if (cherryEffortLevel) localStorage.setItem('slicc_locked_effort_level', cherryEffortLevel);
  const features: CherryFeatureSet =
    isCherry && prelude.cherryTransport ? prelude.cherryTransport.features : ALL_FEATURES_ENABLED;
  renderFollowerInertPanels(
    boot.refs.fileTree,
    boot.refs.termSurface,
    boot.refs.memoryHost,
    boot.refs.monitor,
    features
  );
  applyFeatureVisibility(features);

  // Dip + sprinkle "chrome" styles (card backgrounds/borders, panel chrome) are
  // lazy legacy stylesheets — the leader loads `loadDipStyles` in `wc-live` and
  // `loadSprinkleStyles` in `wireWcSprinkles`, both leader-only paths the
  // follower never runs. Without them, follower-rendered dips (the welcome /
  // onboarding nudge) and leader-synced sprinkles lose their card background and
  // chrome (they render as bare, unstyled text). Load both here.
  void import('../legacy-styles.js')
    .then(({ loadDipStyles, loadSprinkleStyles }) =>
      Promise.all([loadDipStyles(), loadSprinkleStyles()])
    )
    .catch(() => undefined);

  // Inline sprinkles ("dips") — the ` ```shtml ` blocks the agent posts inside
  // chat messages (welcome/onboarding nudge, generic dips). The leader hydrates
  // these via attachWcClient, which the follower never runs, so without this
  // the welcome login nudge and other dips render as nothing in the panel.
  // Hydrate them here and forward their licks to the leader over the tray.
  const dipInstances = new Map<string, DipInstance[]>();
  const focusLeaderTab = (): void =>
    prelude.cherryTransport?.emitSliccEventToHost('slicc.open-leader-tab');
  // Provider login / settings / model changes can't run in the cross-origin
  // panel iframe — they need OAuth / the settings dialog / the model picker,
  // which live on the leader. Focus the SLICC tab (where those run) and surface
  // a redirect card so a panel-only user isn't stranded. Extension-side-panel-
  // only: only that host can focus the pinned leader tab (see `isExtensionSidePanel`).
  const requestLeaderSignIn = (): void => {
    if (!isExtensionSidePanel) return;
    showSignInRedirect(boot.refs.thread, { onOpenTab: focusLeaderTab });
  };
  // Onboarding welcome dips (`/shared/sprinkles/welcome/…`) drive profile
  // collection + provider connect, both of which need the leader — in the side
  // panel they send a lick to a leader with no LLM connected and render a dead
  // OAuth wizard. Swap them in place for a hand-off card that sends the user to
  // the leader tab. Returns true when at least one welcome dip was replaced.
  const replaceWelcomeDipsWithHandoff = (host: HTMLElement): boolean => {
    const welcomeImgs = host.querySelectorAll<HTMLImageElement>(
      `img[src^="${WELCOME_DIP_SRC_PREFIX}"]`
    );
    if (welcomeImgs.length === 0) return false;
    welcomeImgs.forEach((img, i) => {
      // One card per message — replace the first welcome dip, drop the rest so
      // duplicate cards don't stack within a single message.
      if (i === 0) {
        img.replaceWith(buildWelcomeHandoffCard(host.ownerDocument, { onOpenTab: focusLeaderTab }));
      } else {
        img.remove();
      }
    });
    return true;
  };
  const forwardDipLick = (action: string, data: unknown): void => {
    // The cone handles inline-dip licks on the leader.
    follower.currentSync?.sendSprinkleLick('inline', { action, data });
    // A provider-login dip action (welcome dip's connect / device-code) → hand
    // off to the leader tab.
    if (isLoginDipAction(action)) requestLeaderSignIn();
  };

  const controller = new WcChatController({
    thread: boot.refs.thread,
    agent: NOOP_AGENT,
    onQueuedChange: (items) => {
      boot.refs.queuedStack.setMessages(items);
    },
    onMessageRendered: (message, els) => {
      const host = els[0];
      if (!host) return;
      // In the extension side panel, swap onboarding welcome dips for a leader
      // hand-off card BEFORE hydration (removing them so hydrateDips skips them);
      // other dips still hydrate normally.
      if (isExtensionSidePanel) replaceWelcomeDipsWithHandoff(host);
      dipInstances.set(message.id, hydrateDips(host, forwardDipLick));
    },
    onMessageDisposed: (messageId) => {
      const instances = dipInstances.get(messageId);
      if (instances) {
        disposeDips(instances);
        dipInstances.delete(messageId);
      }
    },
    // A follower has no onToolUiAction wiring and no mounted permissions
    // surface (installLeaderPermissionsSurface never runs here) — a
    // leader-broadcast tool_ui card's buttons would silently no-op. Render
    // the static "waiting on the leader" placeholder instead.
    readOnlyToolUi: true,
  });
  boot.setController(controller);

  // Cone-error card CTAs. `errorCardEl` (wc-message-view) bubbles these on the
  // thread; they're wired ONLY in `wireWcNav` on the leader (they open the
  // settings dialog / re-run OAuth / the model picker — none of which exist in
  // the panel). In the extension side panel those buttons would be dead ("Open
  // settings" does nothing), so route them to the leader tab instead — the same
  // handoff as a login dip. Covers the no-provider ("Open settings") and
  // expired-auth ("Log in again") cases a side-panel-only user is most likely to
  // hit. Extension-side-panel-only (a general cherry embed has no leader tab).
  if (isExtensionSidePanel) {
    const ERROR_CARD_LEADER_CTAS = [
      'slicc-error-open-settings',
      'slicc-error-login',
      'slicc-error-change-model',
    ];
    for (const evt of ERROR_CARD_LEADER_CTAS) {
      boot.refs.thread.addEventListener(evt, () => requestLeaderSignIn());
    }
  }

  // Connection-state UX: the composer holds a NOOP agent until the WebRTC
  // channel connects and the real follower sync is installed via setChatAgent.
  // Keep it DISABLED until then so input typed pre-connect can't be silently
  // dropped, and surface a clear status via the placeholder.
  const CONNECTING = 'Connecting to leader…';
  const CONNECTED = 'Ask the leader, or describe a change…';
  // Terminal: the auto-reconnect loop exhausted its attempts (initial failures
  // now route through that loop too - see tray-webrtc startFollowerWithAutoReconnect).
  const GAVE_UP = "Couldn't reach the leader. Reload to retry.";
  const setComposerState = (enabled: boolean, placeholder: string): void => {
    boot.refs.inputCard.setAttribute('placeholder', placeholder);
    if (enabled) boot.refs.inputCard.removeAttribute('disabled');
    else boot.refs.inputCard.setAttribute('disabled', '');
  };
  setComposerState(false, CONNECTING);

  // Push-to-talk: arm the composer's hold-to-dictate gesture. The follower
  // reuses the WC shell WITHOUT attachWcClient (which is where the live/leader
  // mount injects speech + sets `ptt`), so without this the mic gesture is
  // never enabled. `<slicc-composer>` gates the entire PTT press on this
  // attribute and lazily creates its built-in Web Speech engine via
  // `get speech()`, so setting `ptt` is enough — a follower in a real tab
  // (standalone / third-party cherry embed) delegates `microphone` via its
  // `allow=` and dictation works. The whisper upgrade (wc-live) needs the
  // page→worker asset bridge, which a follower has no kernel worker for, so the
  // builtin engine is correct.
  //
  // EXCEPTION — the ui-only follower is the extension side-panel cockpit, a
  // cross-origin iframe inside a `chrome-extension://` side panel. There Chrome
  // keys the mic/camera permission on the top-level (extension) origin and its
  // getUserMedia prompt is not grantable, so dictation always fails with
  // "microphone access denied". Don't arm PTT there — voice lives in the leader
  // tab / detached popout, where getUserMedia works normally.
  if (!uiOnly) boot.refs.composer.setAttribute('ptt', '');

  // Composer add-menu (+): no kernel VFS, so the Files/Skills/Conversations
  // search is unavailable, but the built-in quick-actions still stage inline
  // (base64 data, no path) and ride the next submit to the leader as vision
  // input. No <slicc-permissions> surface here, so wc-attach uses
  // navigator.mediaDevices. `noCamera` drops the camera "Take a photo" action
  // in the side panel (same getUserMedia limitation as PTT); screenshot
  // (getDisplayMedia) + upload keep working there.
  const attachStage = wireWcAttach({
    inputCard: boot.refs.inputCard as HTMLElement & { value?: string },
    freezer: boot.refs.freezer,
    composer: boot.refs.composer,
    noCamera: uiOnly,
    log,
  });

  // Composer submit → forward text + any staged attachments to the
  // (follower-sync) agent the controller holds.
  boot.refs.inputCard.addEventListener('submit', (event) => {
    const text = submittedText(event) ?? '';
    const attachments = attachStage.take();
    if (text.trim() || attachments.length) {
      controller.sendUserMessage(text, attachments);
      (boot.refs.inputCard as HTMLElement & { clear?: () => void }).clear?.();
    }
  });

  const sprinkleZone = new WcSprinkleZone(boot.refs);
  const sprinkleCallbacks = sprinkleZone.callbacks();

  let followerSelectedScoop: string | null = null;

  const follower = startPageFollowerTray({
    joinUrl,
    runtime: isCherry ? CHERRY_RUNTIME_TAG : 'slicc-standalone',
    uiOnly,
    browserAPI: prelude.browser,
    onSnapshot: (messages) => controller.loadMessages(messages),
    // Real signatures: onUserMessage(text, messageId, scoopJid, attachments?)
    // and WcChatController.addUserMessage(text, attachments?) - match wc-tray.ts:97.
    onUserMessage: (text, _messageId, _scoopJid, attachments) =>
      controller.addUserMessage(text, attachments),
    onStatus: (status) => controller.setProcessing(status === 'processing'),
    setChatAgent: (agent) => controller.setAgent(agent),
    onConnectionChange: (connected) => {
      setComposerState(connected, connected ? CONNECTED : CONNECTING);
      if (isCherry)
        prelude.cherryTransport?.emitSliccEventToHost(
          connected ? 'slicc.follower.ready' : 'slicc.follower.disconnected'
        );
    },
    onGaveUp: (lastError) => {
      log.error('follower gave up reaching the leader', { error: lastError });
      setComposerState(false, GAVE_UP);
      // detachSync suppresses onConnectionChange(false) here - emit terminal.
      if (isCherry) prelude.cherryTransport?.emitSliccEventToHost('slicc.follower.disconnected');
    },
    // Cherry's join token comes from the host page out-of-band (no localStorage
    // entry to update); only persist for the plain standalone follower, whose
    // joinUrl is what `resolveFollowerJoinUrl` re-reads from storage on reload.
    ...(isCherry
      ? {}
      : {
          onJoinUrlChanged: (newJoinUrl: string) => {
            log.info('follower joinUrl superseded, persisting replacement', { newJoinUrl });
            storeTrayJoinUrl(window.localStorage, newJoinUrl);
          },
        }),
    addSprinkle: sprinkleCallbacks.addSprinkle,
    removeSprinkle: sprinkleCallbacks.removeSprinkle,
    onOpen: (path) => {
      if (/^https?:\/\//.test(path)) window.open(path, '_blank', 'noopener');
      else log.warn('follower sprinkle open() of a local path is unavailable', { path });
    },
    onScoopsList: (scoops, activeScoopJid) => {
      boot.refs.switcher.scoops = scoops.map((s) => ({
        key: s.jid,
        type: s.isCone ? 'cone' : 'scoop',
        color: scoopColor(s),
        label: s.isCone ? 'sliccy' : s.name,
        eyes: 'open',
      }));
      boot.refs.switcher.setAttribute('active', followerSelectedScoop ?? activeScoopJid);
    },
    ...(isCherry
      ? {
          onCherrySliccEvent: (name, detail) =>
            prelude.cherryTransport?.emitSliccEventToHost(name, detail),
        }
      : {}),
  });

  boot.refs.switcher.addEventListener('slicc-scoop-select', (event) => {
    const scoopJid = (event as CustomEvent<{ key?: string }>).detail?.key;
    if (scoopJid) {
      followerSelectedScoop = scoopJid;
      boot.refs.switcher.setAttribute('active', scoopJid);
      follower.currentSync?.selectScoop(scoopJid);
    }
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
