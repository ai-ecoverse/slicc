import { isSliccAppUrl } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import type { MessageAttachment } from '../core/attachments.js';
import { ThrottledErrorTracker } from '../scoops/throttled-error-tracker.js';
import { setFollowerTrayRuntimeStatus } from '../scoops/tray-follower-status.js';
import {
  FollowerSyncManager,
  type FollowerSyncManagerOptions,
} from '../scoops/tray-follower-sync.js';
import type { ScoopSummary, SprinkleSummary } from '../scoops/tray-sync-protocol.js';
import {
  CHERRY_RUNTIME_TAG,
  type RemoteTargetInfo,
  type TraySyncCapabilities,
} from '../scoops/tray-sync-protocol.js';
import {
  type FollowerAutoReconnectHandle,
  type FollowerTrayConnection,
  startFollowerWithAutoReconnect,
  type TrayPeerConnectionFactory,
} from '../scoops/tray-webrtc.js';
import { canonicalRuntimeId } from './runtime-identity.js';
import { SprinkleFollowerController } from './sprinkle-follower-controller.js';
import type { SprinkleAddOptions } from './sprinkle-manager.js';
import type { AgentHandle, ChatMessage } from './types.js';

const log = createLogger('page-follower-tray');

export { CHERRY_RUNTIME_TAG } from '../scoops/tray-sync-protocol.js';

function resetFollowerRuntimeStatus(): void {
  setFollowerTrayRuntimeStatus({
    state: 'inactive',
    joinUrl: null,
    trayId: null,
    error: null,
    lastPingTime: null,
    reconnectAttempts: 0,
    attachAttempts: 0,
    lastAttachCode: null,
    connectingSince: null,
    lastError: null,
  });
}

function activateFollowerSync(
  options: Pick<
    StartPageFollowerTrayOptions,
    | 'browserAPI'
    | 'setChatAgent'
    | 'onForwardingToggle'
    | 'onConnectionChange'
    | 'getSelectedScoopJid'
  >,
  sync: FollowerSyncManager
): void {
  options.browserAPI.setTrayTargetProvider(sync);
  options.setChatAgent(sync);
  options.onForwardingToggle?.(true);
  options.onConnectionChange?.(true);
  sync.requestSnapshot(options.getSelectedScoopJid?.() ?? undefined);
}

export function helloCapabilitiesForRuntime(
  runtime: string | undefined,
  canHostOAuthPopup = false
): TraySyncCapabilities | undefined {
  if (runtime === CHERRY_RUNTIME_TAG) return undefined;
  return { browser: true, ...(canHostOAuthPopup ? { oauthPopup: true } : {}) };
}

export function buildAdvertisedTargets(
  pages: { targetId: string; title: string; url: string }[],
  runtime: string
): RemoteTargetInfo[] {
  const selfOrigins =
    typeof location !== 'undefined' && location.origin ? [location.origin] : undefined;
  const advertisable = pages.filter((p) => !isSliccAppUrl(p.url, { selfOrigins }));
  if (runtime !== CHERRY_RUNTIME_TAG) {
    return advertisable.map((p) => ({
      targetId: p.targetId,
      title: p.title,
      url: p.url,
      kind: 'browser' as const,
      capabilities: { navigate: true, network: true, screenshot: true },
    }));
  }
  return advertisable.map((p) => ({
    targetId: p.targetId,
    title: p.title,
    url: p.url,
    kind: 'cherry' as const,
    capabilities: { navigate: true, network: false, screenshot: true },
  }));
}

export interface StartPageFollowerTrayOptions {
  joinUrl: string;

  runtime?: string;

  advertisesCdpTargets?: boolean;

  onTargetsUpdated?: (targets: import('../scoops/tray-sync-protocol.js').TrayTargetEntry[]) => void;

  onOAuthPopupRequest?: (url: string, signal: AbortSignal) => Promise<string | null>;

  onSnapshot: (messages: ChatMessage[], scoopJid: string) => void;

  onUserMessage: (
    text: string,
    messageId: string,
    scoopJid: string,
    attachments?: MessageAttachment[]
  ) => void;

  onStatus: (scoopStatus: string, scoopJid?: string) => void;

  onCherrySliccEvent?: (name: string, detail?: unknown) => void;

  onScoopsList?: (scoops: ScoopSummary[], activeScoopJid: string) => void;

  onModelsList?: FollowerSyncManagerOptions['onModelsList'];

  onModelState?: FollowerSyncManagerOptions['onModelState'];

  onSudoApprovalRequest?: FollowerSyncManagerOptions['onSudoApprovalRequest'];

  onBiscottoMessageState?: FollowerSyncManagerOptions['onBiscottoMessageState'];

  setChatAgent: (agent: AgentHandle) => void;

  browserAPI: BrowserAPI;

  onForwardingToggle?: (enabled: boolean) => void;

  onConnectionChange?: (connected: boolean) => void;

  getSelectedScoopJid?: () => string | null;

  onLeaderStalled?: (stalled: boolean) => void;

  onGaveUp?: (lastError: unknown) => void;

  onJoinUrlChanged?: (newJoinUrl: string) => void;

  addSprinkle?: (
    name: string,
    title: string,
    element: HTMLElement,
    zone?: string,
    options?: SprinkleAddOptions
  ) => void;

  removeSprinkle?: (name: string) => void;

  onSprinklesList?: (sprinkles: SprinkleSummary[]) => void;

  onOpen?: (path: string) => void;

  onSelectScoop?: (target: string) => boolean | Promise<boolean>;

  _fetchImpl?: typeof fetch;

  _peerConnectionFactory?: TrayPeerConnectionFactory;

  _refreshIntervalMs?: number;

  _sleep?: (ms: number) => Promise<void>;
}

export interface PageFollowerTrayHandle {
  stop(): void;

  readonly currentSync: FollowerSyncManager | null;
}

export function applyFollowerLeaderTheme(themeJson: string | null): void {
  void import('./theme-engine.js')
    .then(
      ({ importTheme, saveCustomTheme, setActiveTheme, clearActiveTheme, applyThemeOverrides }) => {
        if (!themeJson) {
          clearActiveTheme();
        } else {
          const theme = importTheme(themeJson);
          saveCustomTheme(theme);
          setActiveTheme(theme.id);
        }
        applyThemeOverrides();
      }
    )
    .catch((err) => log.error('Failed to apply leader theme', { err }));
}

export function startPageFollowerTray(
  options: StartPageFollowerTrayOptions
): PageFollowerTrayHandle {
  const refreshIntervalMs = options._refreshIntervalMs ?? 5000;

  let activeSync: FollowerSyncManager | null = null;
  let activeSprinkleController: SprinkleFollowerController | null = null;
  let targetRefreshInterval: ReturnType<typeof setInterval> | null = null;
  let reconnectHandle: FollowerAutoReconnectHandle | null = null;

  const detachSync = (emitDisconnect = true): void => {
    if (targetRefreshInterval) {
      clearInterval(targetRefreshInterval);
      targetRefreshInterval = null;
    }
    if (activeSprinkleController) {
      activeSprinkleController.dispose();
      activeSprinkleController = null;
    }
    if (!activeSync) return;
    options.onForwardingToggle?.(false);
    if (emitDisconnect) options.onConnectionChange?.(false);
    options.browserAPI.setTrayTargetProvider(null);
    activeSync.close();
    activeSync = null;
  };

  const wireFollowerSync = (connection: FollowerTrayConnection): void => {
    detachSync();
    const runtimeId = canonicalRuntimeId(connection.bootstrapId);

    let sprinkleController: SprinkleFollowerController | null = null;

    const sync = new FollowerSyncManager(connection.channel, {
      browserTransport: options.browserAPI.getTransport(),
      browserAPI: options.browserAPI,
      helloCapabilities: helloCapabilitiesForRuntime(
        options.runtime,
        !!options.onOAuthPopupRequest
      ),
      onOAuthPopupRequest: options.onOAuthPopupRequest,
      onSnapshot: options.onSnapshot,
      onUserMessage: options.onUserMessage,
      onStatus: options.onStatus,
      onCherrySliccEvent: options.onCherrySliccEvent,
      onTargetsUpdated: options.onTargetsUpdated,
      onScoopsList: options.onScoopsList,
      onModelsList: options.onModelsList,
      onModelState: options.onModelState,
      onThemeApply: applyFollowerLeaderTheme,
      onSudoApprovalRequest: options.onSudoApprovalRequest,
      onBiscottoMessageState: options.onBiscottoMessageState,
      selfRuntimeId: runtimeId,
      onTargetsChanged: () => void refreshTargets(),
      onSprinklesList: (sprinkles) => {
        options.onSprinklesList?.(sprinkles);
        void sprinkleController?.updateAvailable(sprinkles);
      },
      onSprinkleUpdate: (name, data) => sprinkleController?.handleSprinkleUpdate(name, data),
      onSprinkleReloaded: (name) => void sprinkleController?.handleSprinkleReloaded(name),
      onLeaderStalled: (stalled) => options.onLeaderStalled?.(stalled),
      onDisconnect: (reason) => {
        log.warn('Follower sync disconnected', { reason });
        detachSync();
      },
    });

    if (options.addSprinkle && options.removeSprinkle) {
      sprinkleController = new SprinkleFollowerController({
        sync,
        addSprinkle: options.addSprinkle,
        removeSprinkle: options.removeSprinkle,
        open: options.onOpen,
        selectScoop: options.onSelectScoop,
      });
      activeSprinkleController = sprinkleController;
    }

    const cdpThrottle = new ThrottledErrorTracker(log, {
      failureMessage: 'Follower CDP target listing failed (best-effort, throttled)',
      recoveryMessage: 'Follower CDP target listing recovered (stable for debounce window)',
    });
    const refreshTargets = async (): Promise<void> => {
      if (options.advertisesCdpTargets === false) return;
      let pages: Awaited<ReturnType<typeof options.browserAPI.listPages>>;
      try {
        pages = await options.browserAPI.listPages();
      } catch (err) {
        cdpThrottle.reportFailure(err);
        return;
      }

      if (activeSync !== sync) return;
      cdpThrottle.reportSuccess();
      try {
        sync.advertiseTargets(
          buildAdvertisedTargets(pages, options.runtime ?? 'slicc-standalone'),
          runtimeId
        );
      } catch (err) {
        log.error('Follower target advertisement broadcast failed (sync.advertiseTargets threw)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    activeSync = sync;
    activateFollowerSync(options, sync);

    if (options.advertisesCdpTargets !== false) {
      targetRefreshInterval = setInterval(() => void refreshTargets(), refreshIntervalMs);
      void refreshTargets();
    }

    log.info('Follower sync wired', { trayId: connection.trayId });
  };

  reconnectHandle = startFollowerWithAutoReconnect(
    {
      joinUrl: options.joinUrl,
      runtime: options.runtime ?? 'slicc-standalone',
      fetchImpl: options._fetchImpl,
      peerConnectionFactory: options._peerConnectionFactory,
      sleep: options._sleep,
      onJoinUrlChanged: options.onJoinUrlChanged,
    },
    {
      onConnected: wireFollowerSync,
      onReconnecting: (attempt) => {
        log.info('Follower reconnecting', { attempt });
      },
      onGaveUp: (lastError) => {
        log.warn('Follower reconnect gave up', { lastError });
        detachSync(false);
        options.onGaveUp?.(lastError);
      },
      sleep: options._sleep,
    }
  );

  return {
    stop() {
      detachSync();
      reconnectHandle?.cancel();
      reconnectHandle = null;

      resetFollowerRuntimeStatus();
    },
    get currentSync() {
      return activeSync;
    },
  };
}
