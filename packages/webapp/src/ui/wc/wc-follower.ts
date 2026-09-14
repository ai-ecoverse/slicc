import type { TranscriptExportSelector } from '@slicc/shared-ts';
import { TranscriptExportError } from '@slicc/shared-ts';
import type { SliccPermissions } from '@slicc/webcomponents';
import { createLogger } from '../../base/logger.js';
import { applyHostFlagOverrides, isFeatureEnabled } from '../../core/feature-flags.js';
import {
  FOLLOWER_STATUS_STORAGE_KEY,
  getFollowerTrayRuntimeStatus,
  subscribeToFollowerTrayRuntimeStatus,
} from '../../scoops/tray-follower-status.js';
import { shouldApplyFollowerStatus } from '../../scoops/tray-follower-sync.js';
import { resolveFollowerJoinUrl, storeTrayJoinUrl } from '../../scoops/tray-runtime-config.js';
import type { TrayTargetEntry } from '../../scoops/tray-sync-protocol.js';
import { isReadOnlyUnit } from '../../work-unit/client/presentation.js';
import { setupStandalonePrelude } from '../boot/setup-standalone-prelude.js';
import type { BootStageLogger } from '../boot/types.js';
import { performFollowerSwitchOut } from '../follower-switch-out.js';
import { CHERRY_RUNTIME_TAG, startPageFollowerTray } from '../page-follower-tray.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import { applyCherryTheme } from '../theme-engine.js';
import type { AgentEvent } from '../types.js';
import { RemoteWorkUnitClient } from '../work-unit-client/remote.js';
import { wireWcAttach } from './wc-attach.js';
import { createFollowerChatHost, type WcChatHost } from './wc-chat-host.js';
import { wireWcFollowerBrowser } from './wc-follower-browser.js';
import { createFollowerModelSurface } from './wc-follower-model-surface.js';
import { openDelegatedOAuthPopup } from './wc-follower-oauth.js';
import type { WcShellBoot } from './wc-live.js';
import { mountWcShell } from './wc-mount.js';
import { installLeaderPermissionsSurface } from './wc-permissions.js';
import type { WcShellRefs } from './wc-shell.js';
import {
  buildWelcomeHandoffCard,
  isLoginDipAction,
  showSignInRedirect,
  WELCOME_HANDOFF_CARD_CLASS,
} from './wc-signin-redirect.js';
import { WcSprinkleZone } from './wc-sprinkles.js';

const log = createLogger('wc-follower');

const WELCOME_DIP_SRC_PREFIX = '/shared/sprinkles/welcome/';

const SUGGESTIONS_DIP_SRC_PREFIX = '/shared/sprinkles/suggestions/';

function resolveExportSelector(sessionId: string | undefined): TranscriptExportSelector | null {
  if (sessionId === undefined || sessionId === 'active') return { kind: 'active' };
  if (sessionId.trim() === '') return null;
  return { kind: 'frozen', sessionId };
}

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

  if (!features.files) {
    fileTree.closest('slicc-surface')?.remove();
  } else {
    fileTree.style.display = 'none';
    fileTree.parentElement?.append(
      placeholder(
        "Files live on the leader. A follower mirrors the leader's chat, sprinkles, and browser tabs - not its filesystem."
      )
    );
  }

  if (!features.terminal) {
    termSurface.closest('slicc-surface')?.remove();
  } else {
    termSurface.append(
      placeholder(
        'The shell runs on the leader. A follower has no local terminal - drive the session through chat.'
      )
    );
  }

  if (!features.memory) {
    memoryHost.closest('slicc-surface')?.remove();
  } else {
    memoryHost.append(
      placeholder('Memory lives on the leader. A follower has no local memory store.')
    );
  }

  if (!features.monitor) {
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
  monitor: boolean;
  showTimestamps: boolean;
}

const ALL_FEATURES_ENABLED: CherryFeatureSet = {
  terminal: true,
  files: true,
  memory: true,
  browser: true,
  modelPicker: true,
  history: true,
  nav: true,
  monitor: true,
  showTimestamps: true,
};

function applyFeatureVisibility(features: CherryFeatureSet): void {
  const hidden: string[] = [];

  const dockMap: [keyof CherryFeatureSet, string][] = [
    ['terminal', 'term'],
    ['files', 'files'],
    ['memory', 'memory'],
    ['browser', 'browser'],
    ['monitor', 'monitor'],
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

export function followerAdvertisesCdpTargets(
  hasLocalCdpSurface: boolean,
  uiOnly: boolean
): boolean {
  return hasLocalCdpSurface && !uiOnly;
}

async function applyPushedLayoutDocument(
  boot: { refs: WcShellRefs },
  doc: unknown,
  log: BootStageLogger
): Promise<void> {
  const [{ parseLayoutDocument }, { panelizeShell }] = await Promise.all([
    import('@slicc/webcomponents/panel/layout-schema'),
    import('./panelize-shell.js'),
  ]);
  const parsed = parseLayoutDocument(doc);
  if ('error' in parsed) {
    log.warn('follower: host-pushed layout failed validation — keeping the default', {
      error: parsed.error,
    });
    return;
  }
  panelizeShell(boot.refs, parsed);
  log.info('follower: applied host-pushed layout document', {
    id: parsed.id,
    locked: parsed.locked === true,
  });
}

async function applyCherryHostChrome(
  boot: WcShellBoot,
  prelude: Awaited<ReturnType<typeof setupStandalonePrelude>>,
  isCherry: boolean
): Promise<void> {
  if (isCherry && prelude.cherryTransport?.flags) {
    try {
      const pushedFlags = JSON.parse(prelude.cherryTransport.flags);
      if (pushedFlags && typeof pushedFlags === 'object' && !Array.isArray(pushedFlags)) {
        applyHostFlagOverrides(pushedFlags);
      }
    } catch (err) {
      log.warn('follower: host-pushed flags were not valid JSON — ignoring', err);
    }
  }

  const panelsRequested = isFeatureEnabled('panel-layouts');
  boot.refs.dockTree.tilesMovable = panelsRequested;

  if (isCherry && prelude.cherryTransport?.layout) {
    try {
      const pushed = JSON.parse(prelude.cherryTransport.layout);

      if (pushed && typeof pushed === 'object' && 'base' in pushed) {
        if (panelsRequested) await applyPushedLayoutDocument(boot, pushed, log);
        else log.warn('follower: ignoring host-pushed layout — the panel-layouts flag is off');
      } else {
        (boot.refs.dockTree as unknown as { setTree(spec: unknown): void }).setTree(pushed);
      }
    } catch (err) {
      log.warn('follower: host-pushed layout was not valid JSON — keeping the default', err);
    }
  }
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: follower boot has sequential setup steps
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: follower boot has sequential setup steps
export async function bootFollowerFloat(
  app: HTMLElement,
  bootLog: BootStageLogger,
  runtimeMode: UiRuntimeMode
): Promise<void> {
  const isCherry = runtimeMode === 'cherry';
  const uiOnly = isCherry && new URLSearchParams(window.location.search).get('ui-only') === '1';

  const ancestorOrigin = window.location.ancestorOrigins?.[0];
  const isExtensionSidePanel =
    isCherry && (ancestorOrigin?.startsWith('chrome-extension://') ?? false);

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
    const { bootLeaderFloat } = await import('./wc-live.js');
    return bootLeaderFloat(app, bootLog, 'standalone');
  }

  const floatKind = isCherry ? 'cherry' : isExtensionSidePanel ? 'extension' : 'standalone';

  let boot!: WcShellBoot;
  let features!: CherryFeatureSet;
  let workUnits!: RemoteWorkUnitClient;

  const agentEventListeners = new Set<(event: AgentEvent) => void>();
  let detachAgentEvents: (() => void) | null = null;

  let modelSurface: ReturnType<typeof createFollowerModelSurface> | null = null;

  const focusLeaderTab = (): void =>
    prelude.cherryTransport?.emitSliccEventToHost('slicc.open-leader-tab');

  const requestLeaderSignIn = (): void => {
    if (!isExtensionSidePanel) return;
    showSignInRedirect(boot.refs.thread, { onOpenTab: focusLeaderTab });
  };

  const replaceWelcomeDipsWithHandoff = (host: HTMLElement): boolean => {
    const welcomeImgs = host.querySelectorAll<HTMLImageElement>(
      `img[src^="${WELCOME_DIP_SRC_PREFIX}"]`
    );
    if (welcomeImgs.length === 0) return false;
    welcomeImgs.forEach((img, i) => {
      if (i === 0 && !leaderOnboardingDone) {
        img.replaceWith(buildWelcomeHandoffCard(host.ownerDocument, { onOpenTab: focusLeaderTab }));
      } else {
        img.remove();
      }
    });
    return true;
  };

  let leaderOnboardingDone = false;
  const removeSuggestionStreamDips = (host: HTMLElement): void => {
    const streamImgs = host.querySelectorAll<HTMLImageElement>(
      `img[src^="${SUGGESTIONS_DIP_SRC_PREFIX}"]`
    );
    if (streamImgs.length === 0) return;
    for (const img of streamImgs) img.remove();
    leaderOnboardingDone = true;
    for (const card of boot.refs.thread.querySelectorAll(`.${WELCOME_HANDOFF_CARD_CLASS}`)) {
      card.remove();
    }
  };

  const mounted = await mountWcShell(app, bootLog, {
    floatKind,
    connect: async (shell) => {
      boot = shell;

      if (isCherry && prelude.cherryTransport?.theme) {
        applyCherryTheme(prelude.cherryTransport.theme);
      }
      await applyCherryHostChrome(boot, prelude, isCherry);

      const cherryEffortLevel = isCherry && prelude.cherryTransport?.effortLevel;
      if (cherryEffortLevel) localStorage.setItem('slicc_locked_effort_level', cherryEffortLevel);
      else localStorage.removeItem('slicc_locked_effort_level');
      features =
        isCherry && prelude.cherryTransport
          ? { ...ALL_FEATURES_ENABLED, ...prelude.cherryTransport.features }
          : ALL_FEATURES_ENABLED;
      renderFollowerInertPanels(
        boot.refs.fileTree,
        boot.refs.termSurface,
        boot.refs.memoryHost,
        boot.refs.monitor,
        features
      );
      applyFeatureVisibility(features);

      void import('../timestamp-preference.js').then(
        ({ applyTimestampVisibility, initTimestampPreference }) => {
          if (!features.showTimestamps) applyTimestampVisibility(false);
          else initTimestampPreference();
        }
      );

      void import('../legacy-styles.js')
        .then(({ loadDipStyles, loadSprinkleStyles }) =>
          Promise.all([loadDipStyles(), loadSprinkleStyles()])
        )
        .catch(() => undefined);

      workUnits = new RemoteWorkUnitClient({ getSync: () => follower?.currentSync ?? null });

      const followerHost = createFollowerChatHost({
        getSync: () => follower?.currentSync ?? null,
        onAgentEvent: (listener) => {
          agentEventListeners.add(listener);
          return () => agentEventListeners.delete(listener);
        },
        onAgentError: (error) => {
          log.warn('follower send failed', { error });

          chat.controller.addAssistantMessage(
            `_That message was not sent to the leader — ${error}_`
          );
        },
      });
      const followerChatHost: WcChatHost = {
        ...followerHost,
        sendSprinkleLick: (name, body, targetScoop) => {
          followerHost.sendSprinkleLick(name, body, targetScoop);

          const action = (body as { action?: unknown } | undefined)?.action;
          if (typeof action === 'string' && isLoginDipAction(action)) requestLeaderSignIn();
        },
        addressableUnitId: () => addressableUnitId(),
        onMessageRendered: (messageHost) => {
          removeSuggestionStreamDips(messageHost);

          if (isExtensionSidePanel) replaceWelcomeDipsWithHandoff(messageHost);
        },

        onSelectionApplied: () => {
          setComposerState(composerEnabled, composerPlaceholder);
          modelSurface?.onShownUnitChanged();
        },

        onSnapshotRendered: (messages) => {
          chat.controller.setProcessing(messages.some((message) => message.isStreaming));
        },

        ownsModelPill: true,
        takeAttachments: () => attachStage.take(),
      };
      return { client: workUnits, host: followerChatHost };
    },
  });
  const chat = mounted.chat;
  const controller = chat.controller;

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

  const CONNECTING = 'Connecting to leader…';
  const CONNECTED = 'Ask the leader, or describe a change…';

  const GAVE_UP = "Couldn't reach the leader. Reload to retry.";

  const LEADER_BUSY = 'The leader is busy — hang on…';

  let shownUnit: string | null = null;

  const shownUnitId = (): string | null => boot.getSelected()?.id ?? shownUnit;

  const usableUnitId = (jid: string | null | undefined): string | null =>
    jid && jid.length > 0 ? jid : null;

  let unitConfirmedThisSession = false;

  const addressableUnitId = (): string | null =>
    unitConfirmedThisSession ? usableUnitId(shownUnitId() ?? workUnits.selectedUnitId) : null;

  const composerReadOnly = (): boolean => {
    const unit = boot.getSelected();
    return unit ? isReadOnlyUnit(unit) : false;
  };

  let composerEnabled = false;
  let composerPlaceholder = CONNECTING;
  const setComposerState = (enabled: boolean, placeholder: string): void => {
    composerEnabled = enabled;
    composerPlaceholder = placeholder;

    const live = enabled && addressableUnitId() !== null;
    boot.refs.inputCard.setAttribute('placeholder', enabled && !live ? CONNECTING : placeholder);

    if (live && !composerReadOnly()) boot.refs.inputCard.removeAttribute('disabled');
    else boot.refs.inputCard.setAttribute('disabled', '');
  };
  setComposerState(false, CONNECTING);

  subscribeToFollowerTrayRuntimeStatus((status) => {
    try {
      window.localStorage.setItem(FOLLOWER_STATUS_STORAGE_KEY, JSON.stringify(status));
    } catch {}
  });
  try {
    window.localStorage.setItem(
      FOLLOWER_STATUS_STORAGE_KEY,
      JSON.stringify(getFollowerTrayRuntimeStatus())
    );
  } catch {}

  if (!uiOnly) boot.refs.composer.setAttribute('ptt', '');

  const attachStage = wireWcAttach({
    inputCard: boot.refs.inputCard as HTMLElement & { value?: string },
    freezer: boot.refs.freezer,
    composer: boot.refs.composer,
    noCamera: uiOnly,
    log,
  });

  const sprinkleZone = new WcSprinkleZone(boot.refs);
  const sprinkleCallbacks = sprinkleZone.callbacks();

  const showUnit = (jid: string | null): void => {
    shownUnit = jid;
    if (!jid) return;
    const unit = workUnits.currentUnits().find((candidate) => candidate.id === jid);
    if (!unit) {
      boot.watchUnit(jid);
      setComposerState(composerEnabled, composerPlaceholder);
      return;
    }

    if (boot.getSelected()?.id !== unit.id) {
      boot.selectScoop(unit);
      return;
    }

    setComposerState(composerEnabled, composerPlaceholder);
  };

  const forgetSessionSelection = (): void => {
    unitConfirmedThisSession = false;
    workUnits.resetSelection();
  };
  boot.refs.switcher.connection = 'disconnected';

  let follower!: ReturnType<typeof startPageFollowerTray>;

  let permissionsSurface: SliccPermissions | null = null;
  const ensureFollowerPermissionsSurface = (): SliccPermissions | null => {
    if (!permissionsSurface) {
      permissionsSurface = installLeaderPermissionsSurface({ runtimeMode })?.element ?? null;
    }
    return permissionsSurface;
  };

  let trayTargets: TrayTargetEntry[] = [];
  const followerBrowser = wireWcFollowerBrowser({
    refs: boot.refs,
    getSync: () => follower.currentSync,
    getTargets: () => trayTargets,
    hasCdpBrowser: () => followerAdvertisesCdpTargets(prelude.hasLocalCdpSurface, uiOnly),
    window,
    log,
  });

  modelSurface = createFollowerModelSurface({
    composerMeta: boot.refs.composerMeta,

    getUnits: () => workUnits.currentUnits(),
    setModel: (unitId, model) => {
      void workUnits.setModel(unitId, model).catch(() => undefined);
    },
    getSync: () => follower.currentSync,
    getSelectedScoopJid: () => shownUnitId(),
    modelPickerEnabled: features.modelPicker,
    getLockedEffortLevel: () => localStorage.getItem('slicc_locked_effort_level'),
  });

  workUnits.subscribeList(() => modelSurface?.onShownUnitChanged());

  follower = startPageFollowerTray(
    workUnits.wrapOptions({
      joinUrl,
      runtime: isCherry ? CHERRY_RUNTIME_TAG : 'slicc-standalone',
      advertisesCdpTargets: followerAdvertisesCdpTargets(prelude.hasLocalCdpSurface, uiOnly),
      onTargetsUpdated: (targets) => {
        trayTargets = targets;
        followerBrowser.refresh();
      },

      ...(isCherry || uiOnly
        ? {}
        : {
            onOAuthPopupRequest: (url: string, signal: AbortSignal) =>
              openDelegatedOAuthPopup(url, signal, {
                getPermissionsSurface: ensureFollowerPermissionsSurface,
                window,
              }),
          }),
      browserAPI: prelude.browser,

      onSnapshot: (_messages, scoopJid) => {
        unitConfirmedThisSession = true;

        showUnit(usableUnitId(scoopJid));
      },

      onUserMessage: (text, _messageId, _scoopJid, attachments) =>
        controller.addUserMessage(text, attachments),

      onBiscottoMessageState: (_messageId, state) => {
        switch (state) {
          case 'pending':
            controller.addAssistantMessage('_Sent for review — waiting for the host._');
            break;
          case 'rejected':
            controller.addAssistantMessage('_The host did not forward that message._');
            break;
          case 'unanswered':
            controller.addAssistantMessage(
              '_No one reviewed that message in time, so it was not forwarded._'
            );
            break;
          case 'approved':
            break;
        }
      },
      onStatus: (status, scoopJid) => {
        if (shouldApplyFollowerStatus(scoopJid, shownUnitId())) {
          controller.setProcessing(status === 'processing');
        }
      },
      setChatAgent: (agent) => {
        detachAgentEvents?.();
        detachAgentEvents = agent.onEvent((event) => {
          for (const listener of agentEventListeners) listener(event);
        });
      },

      onSudoApprovalRequest: async (request) => {
        const { openSudoApprovalDialog } = await import('./wc-sudo-approval.js');
        const cherryHostOrigin = isCherry ? prelude.cherryTransport?.hostOrigin : undefined;
        const decision = await openSudoApprovalDialog(
          {
            kind: request.kind,
            detail: request.detail,
            ...(request.suggestedPattern ? { suggestedPattern: request.suggestedPattern } : {}),
          },
          {
            allowAlways: false,
            signal: request.signal,
            expiresAt: request.expiresAt,

            requester:
              request.requester ??
              request.scoopName ??
              (cherryHostOrigin ? `via ${cherryHostOrigin}` : undefined),
          }
        );
        return { decision: decision.decision, attestation: 'none' };
      },
      onConnectionChange: (connected) => {
        boot.refs.switcher.connection = connected ? 'connected' : 'disconnected';
        if (!connected) forgetSessionSelection();
        setComposerState(connected, connected ? CONNECTED : CONNECTING);
        if (!connected) modelSurface?.reset();
        if (isCherry)
          prelude.cherryTransport?.emitSliccEventToHost(
            connected ? 'slicc.follower.ready' : 'slicc.follower.disconnected'
          );
      },
      getSelectedScoopJid: () => shownUnitId(),

      onLeaderStalled: (stalled) => {
        setComposerState(!stalled, stalled ? LEADER_BUSY : CONNECTED);
      },
      onGaveUp: (lastError) => {
        log.error('follower gave up reaching the leader', { error: lastError });
        boot.refs.switcher.connection = 'disconnected';
        forgetSessionSelection();
        setComposerState(false, GAVE_UP);
        modelSurface?.reset();

        if (isCherry) prelude.cherryTransport?.emitSliccEventToHost('slicc.follower.disconnected');
      },

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
        unitConfirmedThisSession = true;

        const shown = shownUnitId();
        if (!shown || !scoops.some((scoop) => scoop.jid === shown)) {
          showUnit(usableUnitId(activeScoopJid));
        } else {
          showUnit(shown);
        }
        boot.wiring.refreshScoops?.();
      },
      onModelsList: (models) => modelSurface?.onModelsList(models),
      onModelState: (state) => modelSurface?.onModelState(state),
      ...(isCherry
        ? {
            onCherrySliccEvent: (name, detail) =>
              prelude.cherryTransport?.emitSliccEventToHost(name, detail),
          }
        : {}),
    })
  );

  for (const action of ['save', 'skip', 'erase'] as const) {
    boot.refs.freezer.addEventListener(`new-chat-${action}`, () => {
      follower.currentSync?.requestNewSession(action);
    });
  }

  if (isFeatureEnabled('agentic-memory')) {
    boot.refs.freezer.querySelector('slicc-freezer-new')?.setAttribute('no-skip', '');
  }

  boot.refs.switcher.addEventListener('slicc-scoop-select', (event) => {
    const scoopJid = (event as CustomEvent<{ key?: string }>).detail?.key;
    if (scoopJid) shownUnit = scoopJid;
  });

  if (isCherry && prelude.cherryTransport) {
    prelude.cherryTransport.onHostEvent = (name, detail) =>
      follower.currentSync?.sendCherryHostEvent(name, detail);

    prelude.cherryTransport.onExportRequest = (_requestId, sessionId, signal, onProgress) => {
      const sync = follower.currentSync;
      if (!sync) return Promise.reject(new TranscriptExportError('transfer-aborted'));
      const selector = resolveExportSelector(sessionId);
      if (!selector) return Promise.reject(new TranscriptExportError('session-not-found'));
      return sync.requestTranscriptExport(selector, signal, onProgress);
    };
  }

  let stopNavigateWatcher: (() => void) | null = null;
  if (!isCherry) {
    const { startFollowerNavigateWatcher } = await import('../follower-navigate-watcher.js');
    stopNavigateWatcher = startFollowerNavigateWatcher(
      prelude.realCdpTransport,
      () => follower.currentSync
    );
  }

  let exportInFlight = false;
  const syncFollowerMenuItems = (): void => {
    boot.refs.avatarMenu.items = [
      { kind: 'separator' },
      ...(isExtensionSidePanel
        ? [{ id: 'focus-leader-tab', label: 'Bring leader to front', icon: 'external-link' }]
        : []),
      {
        id: 'export-transcript',
        label: exportInFlight ? 'Exporting…' : 'Export transcript',
        icon: 'download',
        disabled: exportInFlight || undefined,
      },
      { id: 'tray-stop', label: 'Disconnect from leader', icon: 'unplug', danger: true },
    ];
  };
  syncFollowerMenuItems();

  boot.refs.avatarMenu.addEventListener('slicc-avatar-action', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (id === 'focus-leader-tab') {
      prelude.cherryTransport?.emitSliccEventToHost('slicc.focus-leader-tab');
      return;
    }
    if (id === 'tray-stop') {
      window.dispatchEvent(
        new CustomEvent('slicc:tray-leave', { detail: { workerBaseUrl: null } })
      );
      return;
    }
    if (id === 'export-transcript' && !exportInFlight) {
      exportInFlight = true;
      syncFollowerMenuItems();
      const sync = follower.currentSync;
      if (!sync) {
        exportInFlight = false;
        syncFollowerMenuItems();
        return;
      }
      const abort = new AbortController();
      void sync
        .requestTranscriptExport({ kind: 'active' }, abort.signal)
        .then(async (blob) => {
          const { downloadTranscriptBlob } = await import('./wc-transcript-export.js');
          const filename = `slicc-transcript-${new Date().toISOString().slice(0, 10)}.zip`;
          await downloadTranscriptBlob(blob, filename);
        })
        .catch((err) => {
          log.error('follower transcript export failed', { error: String(err) });
        })
        .finally(() => {
          exportInFlight = false;
          syncFollowerMenuItems();
        });
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
