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
import { installFloatbarStatus } from './wc-floatbar-online.js';
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
} from './wc-signin-redirect.js';
import { WcSprinkleZone } from './wc-sprinkles.js';

const log = createLogger('wc-follower');

/** Source-path prefix of the onboarding welcome dips (`welcome.shtml`,
 *  `connect-llm.shtml`) posted by the onboarding orchestrator as
 *  `![…](/shared/sprinkles/welcome/…)` image references. */
const WELCOME_DIP_SRC_PREFIX = '/shared/sprinkles/welcome/';

/**
 * Resolve a host-supplied sessionId string to a TranscriptExportSelector.
 *
 * - `undefined` or the literal `'active'` → `{ kind: 'active' }`
 * - Any other non-empty, non-whitespace string → `{ kind: 'frozen', sessionId }`
 * - Empty string or whitespace-only → `null` (caller rejects with session-not-found)
 */
function resolveExportSelector(sessionId: string | undefined): TranscriptExportSelector | null {
  if (sessionId === undefined || sessionId === 'active') return { kind: 'active' };
  if (sessionId.trim() === '') return null;
  return { kind: 'frozen', sessionId };
}

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
  monitor: boolean;
  showTimestamps: boolean;
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
  monitor: true,
  showTimestamps: true,
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

/**
 * Whether a follower should advertise its local tabs to the leader.
 *
 * Two independent questions, deliberately kept apart:
 *
 * 1. **Capability** — `hasLocalCdpSurface` from `setupStandalonePrelude`, which
 *    is the only thing that knows which transport branch actually ran. A
 *    follower opened from a hosted `/join/…` link has none: `getDefaultCdpUrl()`
 *    resolves to `wss://<hosted-origin>/cdp`, the SPA fallback answers with HTML,
 *    and the 5s refresh loop retries that doomed upgrade forever (#1706).
 * 2. **Policy** — `uiOnly`. The extension side panel *has* a surface (a synthetic
 *    cherry target) but deliberately withholds it, because the extension drives
 *    the real tab through `chrome.debugger` and the two would compete.
 *
 * Never re-derive the capability from URL params here. The prelude's branches
 * disagree about which params matter — the extension-leader branch reaches real
 * Chrome with no bridge params at all — so a URL check silently drops that
 * float. Keying on a float name is the same mistake one level up: it is what
 * went stale when hosted followers shipped nine days after the original gate.
 */
export function followerAdvertisesCdpTargets(
  hasLocalCdpSurface: boolean,
  uiOnly: boolean
): boolean {
  return hasLocalCdpSurface && !uiOnly;
}

/**
 * Apply a host-pushed panel `LayoutDocument` to a cherry follower.
 *
 * Panelizes the follower's shell and loads the document, deliberately WITHOUT a
 * VFS: a pushed layout is applied once at boot and must never be persisted or
 * drifted client-side (the same reason the dock-tree path bypasses
 * `wireDockTreePersistence`). Omitting the filesystem makes that structural —
 * `layout save` in an embed reports "needs a filesystem" instead of quietly
 * writing the embedder's arrangement into the user's profile.
 *
 * A `locked: true` document (tree-wide, or per-panel) is what stops the end user
 * rearranging what the embedder pushed; the layout engine reflects it onto every
 * placed panel.
 */
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

/**
 * Apply what a Cherry host pushed over the handshake: its feature-flag
 * overrides and its layout.
 *
 * Flags go FIRST — a host's own pushed layout is allowed to turn the
 * `panel-layouts` flag on for itself rather than depending on this
 * deployment's worker-level `FEATURE_FLAGS`.
 */
async function applyCherryHostChrome(
  boot: WcShellBoot,
  prelude: Awaited<ReturnType<typeof setupStandalonePrelude>>,
  isCherry: boolean
): Promise<void> {
  // Apply host-pushed feature-flag overrides BEFORE the panel-layouts gate
  // check below — this is what lets a host's own pushed layout turn the flag
  // on for itself, rather than depending on this deployment's worker-level
  // FEATURE_FLAGS. Session-only (see applyHostFlagOverrides): never persisted.
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
  // Resolve once at boot, matching the live path: feature flags have no live
  // refresh, and changing layout engines after mount would strand live panels.
  const panelsRequested = isFeatureEnabled('panel-layouts');
  boot.refs.dockTree.tilesMovable = panelsRequested;
  // A host-pushed layout replaces `buildWcShellFrame`'s chat-only default
  // wholesale. Applied directly, like theme — never through
  // `wireDockTreePersistence` (never wired for followers at all), so a
  // locked Cherry layout is never persisted or drifted client-side.
  // Panel LayoutDocuments are gated by `panel-layouts` like every other float.
  // Legacy DockTreeSpec pushes remain supported in either flag state; their
  // independent `locked` semantics still win over the movement gate.
  if (isCherry && prelude.cherryTransport?.layout) {
    try {
      const pushed = JSON.parse(prelude.cherryTransport.layout);
      // A host may push EITHER shape: the panel-system `LayoutDocument` (has
      // `base`) or the older `DockTreeSpec` (has `zones`). Embedders vendor the
      // SDK and upgrade on their own schedule, so both have to keep working —
      // sniffing the shape is cheaper and less brittle than a version field the
      // older hosts never sent.
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
    const { bootLeaderFloat } = await import('./wc-live.js');
    return bootLeaderFloat(app, bootLog, 'standalone');
  }

  const floatKind = isCherry ? 'cherry' : isExtensionSidePanel ? 'extension' : 'standalone';
  /**
   * The shell, once mounted. Held so the rest of this boot — the tray, the
   * menus, the browser rail — can wire onto it; the frame and the chat
   * surface themselves are `mountWcShell`'s (#2382 D2b).
   */
  let boot!: WcShellBoot;
  let features!: CherryFeatureSet;
  let workUnits!: RemoteWorkUnitClient;
  /**
   * The agent EVENT stream, across reconnects. `setChatAgent` hands a NEW
   * handle on every (re)connect, so listeners are held here and re-attached —
   * one bound to the first handle would go quiet after the first reconnect.
   */
  const agentEventListeners = new Set<(event: AgentEvent) => void>();
  let detachAgentEvents: (() => void) | null = null;
  /**
   * The model pill's own surface, installed once the catalog wiring below
   * runs. Declared here because a selection repaints it, and a selection can
   * land the moment the channel connects.
   */
  let modelSurface: ReturnType<typeof createFollowerModelSurface> | null = null;

  // Inline sprinkles ("dips") — the ` ```shtml ` blocks the agent posts inside
  // chat messages (welcome/onboarding nudge, generic dips) — are hydrated by
  // the SHARED chat wiring now (#2382 D2b), which both floats run. What is
  // still this float's is where a dip's lick goes (over the tray) and the two
  // side-panel hand-offs below.
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

  // ONE mount path (#2382 D2b). This float's transport is the tray: a
  // `RemoteWorkUnitClient` over the sync manager, and a host that forwards the
  // two verbs a follower can and refuses the two it cannot. No workbench —
  // there is no kernel behind it.
  const mounted = await mountWcShell(app, bootLog, {
    floatKind,
    connect: async (shell) => {
      boot = shell;
      // Apply host-supplied theme AFTER the shell mounts — buildWcShellFrame's
      // ensureSystemTheme() sets body data-theme from OS preference, so we must
      // override it afterward. The static import (not dynamic await) keeps this
      // synchronous with no flash.
      if (isCherry && prelude.cherryTransport?.theme) {
        applyCherryTheme(prelude.cherryTransport.theme);
      }
      await applyCherryHostChrome(boot, prelude, isCherry);
      // No kernel worker in follower mode → the Files/Terminal/Memory panels are
      // inert. Swap them for an explanatory placeholder instead of an empty panel.
      // For cherry followers, respect the host's feature toggles; for regular followers,
      // show all panels by default.
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

      // Apply timestamp visibility: cherry embedders can force it off via features.
      // Use applyTimestampVisibility (transient class toggle) rather than
      // setShowTimestamps (persists to localStorage) so the cherry flag doesn't
      // leak into the user's standalone preference on the shared origin.
      void import('../timestamp-preference.js').then(
        ({ applyTimestampVisibility, initTimestampPreference }) => {
          if (!features.showTimestamps) applyTimestampVisibility(false);
          else initTimestampPreference();
        }
      );

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

      /**
       * The follower's half of the client protocol (#2274). `getSync` is lazy, so
       * the channel can arrive whenever it does.
       */
      workUnits = new RemoteWorkUnitClient({ getSync: () => follower?.currentSync ?? null });

      // The chat surface is the SHARED one (#2382 D2b): controller, dips, queued
      // pile, tab strip, composer submit/stop and selection all come from
      // `attachWcChat`, exactly as on the leader. What is follower-specific is the
      // host it runs on — two verbs forwarded over the tray, two refused, and the
      // handful of facts a panel answers differently.
      const followerHost = createFollowerChatHost({
        getSync: () => follower?.currentSync ?? null,
        onAgentEvent: (listener) => {
          agentEventListeners.add(listener);
          return () => agentEventListeners.delete(listener);
        },
        onAgentError: (error) => {
          log.warn('follower send failed', { error });
          // The controller has already appended the bubble and cleared the input
          // by the time this fires, so a log line would leave a message on screen
          // that never left the device. Say so where the user is looking, as the
          // leader does with its error card.
          chat.controller.addAssistantMessage(
            `_That message was not sent to the leader — ${error}_`
          );
        },
      });
      const followerChatHost: WcChatHost = {
        ...followerHost,
        sendSprinkleLick: (name, body, targetScoop) => {
          followerHost.sendSprinkleLick(name, body, targetScoop);
          // A provider-login dip action (the welcome dip's connect / device-code)
          // → hand off to the leader tab, which is where OAuth can run.
          const action = (body as { action?: unknown } | undefined)?.action;
          if (typeof action === 'string' && isLoginDipAction(action)) requestLeaderSignIn();
        },
        addressableUnitId: () => addressableUnitId(),
        onMessageRendered: (messageHost) => {
          // In the extension side panel, swap onboarding welcome dips for a leader
          // hand-off card before hydration (removing them so `hydrateDips` skips
          // them); other dips still hydrate normally.
          if (isExtensionSidePanel) replaceWelcomeDipsWithHandoff(messageHost);
        },
        // The leader answers a selection with a snapshot, not a `model.state`, so
        // nothing else would repaint the pill for the newly shown unit.
        onSelectionApplied: () => {
          // The connection gate outranks the selection's own chrome: reconnecting,
          // or a leader that has not named a unit, keeps the composer shut.
          setComposerState(composerEnabled, composerPlaceholder);
          modelSurface?.onShownUnitChanged();
        },
        // The leader's `onStatus` frame is separate and a fresh join may not have
        // it yet, so a replay still carrying a streaming message is how this
        // follower learns the turn is live.
        onSnapshotRendered: (messages) => {
          chat.controller.setProcessing(messages.some((message) => message.isStreaming));
        },
        // The pill is `wc-follower-model-surface.ts`'s — its catalog is the
        // leader's `models.list`, not this page's provider settings.
        ownsModelPill: true,
        takeAttachments: () => attachStage.take(),
      };
      return { client: workUnits, host: followerChatHost };
    },
  });
  const chat = mounted.chat;
  const controller = chat.controller;

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
  // Transient: the leader stopped answering pings but the channel is still
  // open, so it is working, not gone (see `data-channel-keepalive.ts`). This is
  // the whole reason a stall must not read as a disconnect — the connection is
  // fine and recovers by itself, so the placeholder says "busy", not "lost".
  const LEADER_BUSY = 'The leader is busy — hang on…';
  /**
   * The unit this follower is READING.
   *
   * The shell's own selection answers for a unit the roster describes; this
   * survives a disconnect, which the shell's does not need to — it is what we
   * ask the NEXT leader for (`getSelectedScoopJid` feeds `requestSnapshot`),
   * not what we are allowed to send to.
   */
  let shownUnit: string | null = null;
  /**
   * The unit on screen right now: the shell's own selection when the roster
   * describes it, else the guest thread this follower was pinned to.
   *
   * The shell is asked FIRST because a tab click lands there before it lands
   * here — `attachWcChat` selects the summary, and the listener below only
   * records what to ask the next leader for.
   */
  const shownUnitId = (): string | null => boot.getSelected()?.id ?? shownUnit;

  /**
   * A jid we can actually address, or `null`. An empty or missing
   * `activeScoopJid` is a leader that could not name a unit, not a unit called
   * `''` — and treating it as one enabled the composer for a send the handle
   * then dropped as "No scoop selected".
   */
  const usableUnitId = (jid: string | null | undefined): string | null =>
    jid && jid.length > 0 ? jid : null;
  /**
   * Has THIS connection named a unit yet? A reconnect is a fresh bootstrap and
   * the leader may have dropped the unit we were viewing, so the composer must
   * not reopen on the previous session's answer.
   *
   * {@link shownUnit} deliberately SURVIVES a disconnect: it is what we ask
   * the new leader for, not what we are allowed to send to. The two are
   * different questions, and conflating them either loses the viewed unit
   * across a reconnect or reopens the composer on a unit that is gone.
   */
  let unitConfirmedThisSession = false;
  /**
   * The unit a send is addressed to. The shell's own copy first; the client's
   * is the leader's answer (`scoops.list`'s active jid, or the unit it last
   * mirrored), which is what lands first on a fresh join.
   */
  const addressableUnitId = (): string | null =>
    unitConfirmedThisSession ? usableUnitId(shownUnitId() ?? workUnits.selectedUnitId) : null;

  /**
   * The shown unit is a scoop, so the composer band is unmounted (#2312).
   *
   * Read off the shell's own selection, which `attachWcChat` applies through
   * the SAME `isReadOnlyUnit` rule the leader uses. A unit the roster does not
   * describe — a biscotto seat, never sent `scoops.list` — is not selected at
   * all and stays WRITABLE: the control on a guest's message is the
   * leader-side review gate, not this chrome.
   */
  const composerReadOnly = (): boolean => {
    const unit = boot.getSelected();
    return unit ? isReadOnlyUnit(unit) : false;
  };
  /** Last connection-driven composer state, replayed after a selection change. */
  let composerEnabled = false;
  let composerPlaceholder = CONNECTING;
  const setComposerState = (enabled: boolean, placeholder: string): void => {
    composerEnabled = enabled;
    composerPlaceholder = placeholder;
    // Connected is not the same as addressable. `activateFollowerSync` installs
    // the chat agent and reports the connection BEFORE it asks for the first
    // snapshot, so there is a window where the leader has not named a unit yet
    // — and a send names its unit (#2382). Submitting in that window would let
    // the controller render the message and clear the input for a send that
    // goes nowhere, so the box stays shut (and still says "connecting") until
    // the first roster or snapshot lands, which is a few frames later.
    const live = enabled && addressableUnitId() !== null;
    boot.refs.inputCard.setAttribute('placeholder', enabled && !live ? CONNECTING : placeholder);
    // A read-only selection outranks the connection state: reconnecting while
    // a scoop is selected must not hand back a composer for it.
    if (live && !composerReadOnly()) boot.refs.inputCard.removeAttribute('disabled');
    else boot.refs.inputCard.setAttribute('disabled', '');
  };
  setComposerState(false, CONNECTING);

  // Drive the floatbar status beacon from tray runtime statuses.
  installFloatbarStatus(boot.refs.floatbar, { floatKind });

  // Mirror the follower tray status into `localStorage`, matching what
  // `wc-tray.ts` does for the kernel-backed floats. Without this the
  // `/join/<token>` mount — the float most people actually run — keeps its
  // connection history (attach attempts, last attach code, reconnects, last
  // error) in module scope only, so a disconnect leaves nothing behind to
  // diagnose from. Seed on boot, then track every transition.
  subscribeToFollowerTrayRuntimeStatus((status) => {
    try {
      window.localStorage.setItem(FOLLOWER_STATUS_STORAGE_KEY, JSON.stringify(status));
    } catch {
      // A full/blocked localStorage must never break the connection UX.
    }
  });
  try {
    window.localStorage.setItem(
      FOLLOWER_STATUS_STORAGE_KEY,
      JSON.stringify(getFollowerTrayRuntimeStatus())
    );
  } catch {
    // Same — telemetry is best-effort.
  }

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

  // Submit, stop and the avatar's local gaze channels are `attachWcChat`'s —
  // the same listeners the leader installs (#2382 D2b). The follower's stop
  // button had no listener at all until PR A precisely because this file
  // owned its own composer.

  const sprinkleZone = new WcSprinkleZone(boot.refs);
  const sprinkleCallbacks = sprinkleZone.callbacks();

  /**
   * Show the unit the leader named, or one the user clicked.
   *
   * A unit the ROSTER DESCRIBES goes through the shell's own `selectScoop` —
   * the same call the leader's tab click makes (#2382 D2b), which applies the
   * chrome, asks for the snapshot and re-points the transcript.
   *
   * A unit it does NOT describe is a biscotto seat: pinned to one thread and
   * deliberately never sent `scoops.list`, so there is no summary to select
   * and no chrome to apply (the protocol says as much —
   * `WorkUnitSnapshot.summary` is optional). Its transcript is rendered
   * directly and the composer stays writable, because the control on a
   * guest's message is the leader-side review gate, not this chrome.
   */
  const showUnit = (jid: string | null): void => {
    shownUnit = jid;
    if (!jid) return;
    const unit = workUnits.currentUnits().find((candidate) => candidate.id === jid);
    if (unit) boot.selectScoop(unit);
    else {
      boot.watchUnit(jid);
      setComposerState(composerEnabled, composerPlaceholder);
    }
  };

  /**
   * Drop everything that describes the connection that just ended: the client's
   * mirrored unit (so the next session's first snapshot is not judged against
   * a unit that may be gone) and the "this session named a unit" flag. The
   * viewed jid itself stays — see {@link unitConfirmedThisSession}.
   */
  const forgetSessionSelection = (): void => {
    unitConfirmedThisSession = false;
    workUnits.resetSelection();
  };
  boot.refs.switcher.connection = 'disconnected';

  let follower!: ReturnType<typeof startPageFollowerTray>;

  // A follower mounts no permissions surface at boot (nothing here needs one).
  // A delegated OAuth login does, so install it on first use and keep it.
  let permissionsSurface: SliccPermissions | null = null;
  const ensureFollowerPermissionsSurface = (): SliccPermissions | null => {
    if (!permissionsSurface) {
      permissionsSurface = installLeaderPermissionsSurface({ runtimeMode })?.element ?? null;
    }
    return permissionsSurface;
  };

  // Browser rail: list every tab in the tray and let the user pull one here.
  // A float with a real CDP surface gets a state-carrying teleport; the
  // ui-only side panel and cherry degrade to window.open inside the click.
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
    // The shown unit's own model, from the roster the leader sends (#2382 PR
    // C). The catalog stays with the surface; only the identity comes from here.
    getUnits: () => workUnits.currentUnits(),
    setModel: (unitId, model) => {
      void workUnits.setModel(unitId, model).catch(() => undefined);
    },
    getSync: () => follower.currentSync,
    getSelectedScoopJid: () => shownUnitId(),
    modelPickerEnabled: features.modelPicker,
    getLockedEffortLevel: () => localStorage.getItem('slicc_locked_effort_level'),
  });

  // A roster push can carry a model this follower has no `model.state` for
  // (the leader broadcasts `scoops.list` on an interval, and per-unit models
  // ride it), so the pill re-reads whenever the roster moves.
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
      // #1915: the leader's kernel can't prompt a human. When the user is
      // driving from here, the interactive OAuth hop runs here too. Cherry and
      // the ui-only side panel are excluded — a cross-origin iframe cannot
      // reliably own a provider popup — and omitting the handler is what keeps
      // `capabilities.oauthPopup` off for them.
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
      // The TRANSCRIPT is no longer read off this frame — `watchUnit` renders
      // it from the client protocol (#2382), the same subscription the leader
      // mount uses. What is left here is the selection bookkeeping the frame
      // also carries: the leader names the unit it is mirroring, and on a
      // fresh join that is how this follower first learns which one it has.
      onSnapshot: (_messages, scoopJid) => {
        unitConfirmedThisSession = true;
        // First unit of the session: `showUnit` re-evaluates the composer,
        // which stayed shut while there was nothing to address.
        showUnit(usableUnitId(scoopJid));
      },
      // Real signatures: onUserMessage(text, messageId, scoopJid, attachments?)
      // and WcChatController.addUserMessage(text, attachments?) - match wc-tray.ts:97.
      onUserMessage: (text, _messageId, _scoopJid, attachments) =>
        controller.addUserMessage(text, attachments),
      // A biscotto's messages are reviewed before they reach the cone. Without
      // this the guest's message simply never appears — it is only echoed back
      // once the leader broadcasts an APPROVED one — which reads as the app
      // having silently dropped it. These notes are local synthetic lines; the
      // approved message itself still arrives through `onUserMessage`.
      onBiscottoMessageState: (_messageId, state) => {
        switch (state) {
          case 'pending':
            controller.addAssistantMessage('_Sent for review — waiting for the host._');
            break;
          case 'rejected':
            controller.addAssistantMessage('_The host did not forward that message._');
            break;
          case 'unanswered':
            // Deliberately distinct from `rejected`: nobody refused this, so
            // rephrasing may well work once someone is at the keyboard.
            controller.addAssistantMessage(
              '_No one reviewed that message in time, so it was not forwarded._'
            );
            break;
          case 'approved':
            // The real message arrives via the leader's broadcast; a note here
            // would double up.
            break;
        }
      },
      onStatus: (status, scoopJid) => {
        if (shouldApplyFollowerStatus(scoopJid, shownUnitId())) {
          controller.setProcessing(status === 'processing');
        }
      },
      setChatAgent: (agent) => {
        // Send and stop are the shared handle's, over the client protocol,
        // which NAMES the unit instead of relying on whatever the leader last
        // mirrored to us (#2382). What arrives here is the transport's EVENT
        // stream — a NEW handle on every reconnect — so the listeners the
        // chat wiring registered are re-attached to it. Binding them to the
        // first handle would leave the face and the streaming text frozen
        // after the first reconnect.
        detachAgentEvents?.();
        detachAgentEvents = agent.onEvent((event) => {
          for (const listener of agentEventListeners) listener(event);
        });
      },
      // The leader decided this follower's human should answer a sudo prompt —
      // it is headless (hosted / cloud), or the user is driving from here
      // (#2062). Same dialog the leader would show; "Always" is withheld
      // because the leader only honours it from biometric-gated followers.
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
            // Leader-derived identity first: `scoopName` names the requesting
            // unit, but a directed request (a biscotto's message) is asked on
            // behalf of a thread by someone who is not that thread.
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
      // A stall keeps the composer usable-looking but disabled, so a message
      // typed while the leader is catching up can't be silently dropped. No
      // cherry host event: the host contract is connected/disconnected, and a
      // stall is neither.
      onLeaderStalled: (stalled) => {
        setComposerState(!stalled, stalled ? LEADER_BUSY : CONNECTED);
      },
      onGaveUp: (lastError) => {
        log.error('follower gave up reaching the leader', { error: lastError });
        boot.refs.switcher.connection = 'disconnected';
        forgetSessionSelection();
        setComposerState(false, GAVE_UP);
        modelSurface?.reset();
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
        // Either frame can be the first of a session, so neither may be the
        // only door out of the un-addressable window.
        unitConfirmedThisSession = true;
        // The roster lands AFTER the adapter has folded it in, so `showUnit`
        // can find the summary for the unit the leader named. A leader sends
        // the initial transcript ahead of this frame, so the re-point takes
        // the adapter's cached snapshot — for a fresh join that is the only
        // one that unit will get.
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

  // Freezer new-chat: the side panel enables `history: true`, so the freezer
  // (including its `slicc-freezer-new` control) renders in the follower shell.
  // A follower has no cone / VFS to run `runNewSessionFreeze` itself; forward
  // the action to the leader, which owns the archive + `clearAllMessages` and
  // then broadcasts the cleared snapshot back so this follower's chat updates.
  for (const action of ['save', 'skip', 'erase'] as const) {
    boot.refs.freezer.addEventListener(`new-chat-${action}`, () => {
      follower.currentSync?.requestNewSession(action);
    });
  }
  // Parity with the leader (wc-live): under agentic memory the memory decision
  // is the background curator's, so the follower's affordance must also reduce
  // to two outcomes — a forwarded `skip` would quick-freeze on the leader with
  // no curator and no `memoryPending` marker, silently losing the memory pass.
  if (isFeatureEnabled('agentic-memory')) {
    boot.refs.freezer.querySelector('slicc-freezer-new')?.setAttribute('no-skip', '');
  }

  // The tab click itself is `attachWcChat`'s (#2382 D2b) — it selects the
  // summary, which asks for the snapshot and re-points the transcript. What is
  // left here is the follower's own bookkeeping: the unit it will ask the NEXT
  // leader for.
  boot.refs.switcher.addEventListener('slicc-scoop-select', (event) => {
    const scoopJid = (event as CustomEvent<{ key?: string }>).detail?.key;
    if (scoopJid) shownUnit = scoopJid;
  });

  if (isCherry && prelude.cherryTransport) {
    prelude.cherryTransport.onHostEvent = (name, detail) =>
      follower.currentSync?.sendCherryHostEvent(name, detail);
    // Wire host-initiated export requests to the follower tray export path.
    // The verified Blob from FollowerSyncManager is returned directly — no
    // rebuild or rehash; only the phase is forwarded (no filename/sha256/size).
    // requestId is used by CherryHostTransport for envelope routing, not here.
    // sessionId selects the target session:
    //   - omitted (undefined) or the literal string 'active' → active selector
    //   - non-empty, non-whitespace string other than 'active' → frozen selector
    //   - empty string or whitespace-only → reject; never starts a tray export
    prelude.cherryTransport.onExportRequest = (_requestId, sessionId, signal, onProgress) => {
      const sync = follower.currentSync;
      if (!sync) return Promise.reject(new TranscriptExportError('transfer-aborted'));
      const selector = resolveExportSelector(sessionId);
      if (!selector) return Promise.reject(new TranscriptExportError('session-not-found'));
      return sync.requestTranscriptExport(selector, signal, onProgress);
    };
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
  // Task 8: add "Export transcript" to the follower avatar menu.
  // Experimental features are deliberately excluded: the centrally gated
  // dialog currently has no user-toggleable flags, so this menu stays minimal.
  // "Bring leader to front" is extension-side-panel-only: the pinned leader tab
  // lives in exactly one window, and only that host can focus it (see
  // `isExtensionSidePanel`).
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
