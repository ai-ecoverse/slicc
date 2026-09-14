import { isFeatureEnabled } from '../../core/feature-flags.js';
import { isExtensionRealm } from '../../core/runtime-env.js';
import { getFollowerTrayRuntimeStatus } from '../../scoops/tray-follower-status.js';
import { getLeaderTrayRuntimeStatus } from '../../scoops/tray-leader.js';
import {
  DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
  DEFAULT_STAGING_TRAY_WORKER_BASE_URL,
  resolveTrayWorkerBaseUrl,
} from '../../scoops/tray-runtime-config.js';
import {
  getConnectedFollowersWithFallback,
  getTrayResetter,
} from '../../shell/supplemental-commands/host-command.js';
import type { WorkUnitClient, WorkUnitSummary } from '../../work-unit/client/types.js';
import { parseQualifiedModelId } from '../../work-unit/record.js';
import type { BootStageLogger } from '../boot/types.js';
import { copyTextToClipboard } from '../clipboard.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { GroupedModels } from '../provider-settings.js';
import type { SyncDialogTabId } from '../sync-dialog-model.js';
import { computeTrayMenuModel } from '../tray-join-url.js';
import {
  notifyLeaderLocalModelStateChanged,
  notifyLeaderModelCatalogChanged,
} from './leader-model-events.js';
import type { WcShellRefs } from './wc-shell.js';
import type { ShortcutHandles } from './wc-shortcuts.js';
import { rootForSelection } from './wc-unit-context.js';

export interface MetaModel {
  name: string;
  provider?: string;

  id: string;
}

export interface NavIdentity {
  name: string;
  avatarUrl?: string;
  provider?: string;
}

export function accountIdentity(
  accounts: readonly { providerId: string; userName?: string; userAvatar?: string }[]
): NavIdentity | null {
  const withAvatar = accounts.find((a) => a.userAvatar && a.userName);
  const withName = withAvatar ?? accounts.find((a) => a.userName);
  if (!withName?.userName) return null;
  return {
    name: withName.userName,
    avatarUrl: withName.userAvatar,
    provider: withName.providerId,
  };
}

export function modelListForMeta(groups: readonly GroupedModels[]): MetaModel[] {
  return groups.flatMap((group) =>
    group.models.map((model) => ({
      name: model.name ?? model.id,
      provider: group.providerName,
      id: `${group.providerId}:${model.id}`,
    }))
  );
}

function applyModelPillFromCurrentModel(
  composerMeta: Element,
  resolveCurrentModel: () => { name?: string; id: string },
  resolveQualifiedId?: () => string
): void {
  try {
    const model = resolveCurrentModel();
    composerMeta.setAttribute('model', model.name ?? model.id);
    if (resolveQualifiedId) {
      (composerMeta as HTMLElement & { selectedModelId?: string | null }).selectedModelId =
        resolveQualifiedId();
    }
  } catch {}
}

export interface WcNavDeps {
  refs: WcShellRefs;
  client: OffscreenClient;

  workUnits: Pick<WorkUnitClient, 'setModel'>;

  getUnits(): readonly WorkUnitSummary[];
  log: BootStageLogger;

  onExportTranscript?: () => Promise<void>;

  shortcuts?: Pick<ShortcutHandles, 'showHelp' | 'setAction' | 'trigger' | 'setTrigger'>;

  persistKeyboardTrigger?: (trigger: import('./wc-shortcuts.js').KeyboardTrigger) => Promise<void>;
}

function standardMenuItems(
  exportInFlight: boolean,
  hasShortcuts: boolean
): NonNullable<WcShellRefs['avatarMenu']['items']> {
  const items: NonNullable<WcShellRefs['avatarMenu']['items']> = [
    { id: 'settings', label: 'Account settings…', icon: 'settings' },
    { id: 'theme', label: 'Theme settings…', icon: 'palette' },
    ...(hasShortcuts
      ? [{ id: 'shortcuts', label: 'Keyboard mode', icon: 'keyboard' } as const]
      : []),
    {
      id: 'export-transcript',
      label: 'Export transcript',
      icon: 'download',
      disabled: exportInFlight || undefined,
    },
  ];
  if (isFeatureEnabled('experimental-settings')) {
    items.push({
      id: 'experimental-settings',
      label: 'Experimental features…',
      icon: 'flask-conical',
    });
  }
  return items;
}

function buildRefreshModels(
  composerMeta: HTMLElement,
  getAllAvailableModels: () => readonly GroupedModels[]
): () => void {
  return () => {
    (composerMeta as HTMLElement & { models?: unknown }).models = modelListForMeta(
      getAllAvailableModels()
    );
    notifyLeaderModelCatalogChanged();
  };
}

function buildRefreshModelPill(
  composerMeta: HTMLElement,
  resolveCurrentModel: () => { name?: string; id: string },
  getSelectedProvider: () => string
): () => void {
  return () =>
    applyModelPillFromCurrentModel(composerMeta, resolveCurrentModel, () => {
      const model = resolveCurrentModel();
      return `${getSelectedProvider()}:${model.id}`;
    });
}

function buildApplyIdentity(
  refs: WcShellRefs,
  getAccounts: () => readonly { providerId: string; userName?: string; userAvatar?: string }[],
  isExtension: boolean
): () => void {
  return () => {
    const identity = accountIdentity(getAccounts());
    const avatar = refs.avatarMenu.querySelector('slicc-avatar');

    const send = refs.inputCard.querySelector('slicc-send-button');
    if (identity) {
      avatar?.removeAttribute('initials');
      avatar?.setAttribute('name', identity.name);
      if (identity.avatarUrl) {
        avatar?.setAttribute('src', identity.avatarUrl);
        send?.setAttribute('src', identity.avatarUrl);
      }
      refs.avatarMenu.user = { name: identity.name, provider: identity.provider };
      return;
    }

    avatar?.removeAttribute('name');
    avatar?.removeAttribute('src');
    avatar?.removeAttribute('initials');
    send?.removeAttribute('src');
    refs.avatarMenu.user = {
      name: 'SLICC',
      provider: isExtension ? 'extension' : 'standalone',
    };
  };
}

export async function wireWcNav(deps: WcNavDeps): Promise<void> {
  const { refs, client, log, onExportTranscript } = deps;
  const { getAllAvailableModels, getAccounts, getSelectedProvider, resolveCurrentModel } =
    await import('../provider-settings.js');

  const refreshModels = buildRefreshModels(refs.composerMeta, getAllAvailableModels);
  const refreshModelPill = buildRefreshModelPill(
    refs.composerMeta,
    resolveCurrentModel,
    getSelectedProvider
  );
  refreshModels();

  let pendingReplayMessageId: string | null = null;
  await wireModelPicker(refs, client, deps.workUnits, deps.getUnits, () => {
    const id = pendingReplayMessageId;
    pendingReplayMessageId = null;
    if (id == null) return;
    refs.thread?.dispatchEvent(
      new CustomEvent('slicc-error-retry', {
        detail: { messageId: id },
        bubbles: true,
        composed: true,
      })
    );
  });

  const isExtension = isExtensionRealm();
  const applyIdentity = buildApplyIdentity(refs, getAccounts, isExtension);
  applyIdentity();
  const trayMenuItems = (): NonNullable<typeof refs.avatarMenu.items> => {
    if (isExtension) return [];
    const model = computeTrayMenuModel(
      getLeaderTrayRuntimeStatus(),
      getFollowerTrayRuntimeStatus()
    );
    const items: NonNullable<typeof refs.avatarMenu.items> = [{ kind: 'separator' }];
    if (model.kind === 'leader-offer') {
      items.push({ id: 'tray-enable', label: model.label, icon: 'radio' });
    } else if (model.kind === 'leader-copy') {
      items.push({ id: 'tray-copy', label: 'Copy tray join URL', icon: 'link' });
      items.push({
        id: 'tray-stop',
        label: 'Stop multi-browser sync',
        icon: 'square',
        danger: true,
      });
    } else if (model.kind === 'leader-pending') {
      items.push({ kind: 'caption', label: model.caption });
      items.push({
        id: 'tray-stop',
        label: 'Stop multi-browser sync',
        icon: 'square',
        danger: true,
      });
    } else {
      items.push({ kind: 'caption', label: model.caption });
      items.push({
        id: 'tray-stop',
        label: 'Disconnect from leader',
        icon: 'unplug',
        danger: true,
      });
    }
    return items;
  };

  const isDetachedSelf = new URLSearchParams(window.location.search).has('detached');
  const popoutItems = (): NonNullable<typeof refs.avatarMenu.items> =>
    isExtension && !isDetachedSelf
      ? [{ id: 'popout', label: 'Pop out into a tab', icon: 'external-link' }]
      : [];

  let exportInFlight = false;
  const syncMenuItems = (): void => {
    refs.avatarMenu.items = [
      ...standardMenuItems(exportInFlight, !!deps.shortcuts),
      ...popoutItems(),
      ...trayMenuItems(),
    ];
  };
  syncMenuItems();

  refs.avatarMenu.addEventListener('slicc-avatar-menu-toggle', (event) => {
    if ((event as CustomEvent<{ open?: boolean }>).detail?.open) syncMenuItems();
  });
  const openSettings = buildOpenSettings(log, refreshModels, applyIdentity, () =>
    client.updateModel()
  );

  deps.shortcuts?.setAction('accounts', openSettings);
  const openTheme = buildOpenTheme(log, themeKeyboardOpts(deps));
  const openExperimental = buildOpenExperimental(log);
  wireFollowersSegment(refs, log);

  refs.avatarMenu.addEventListener('slicc-avatar-action', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (id && handleTrayActionId(id, log)) {
      syncMenuItems();
      return;
    }
    if (id === 'popout') {
      import('./wc-detached.js')
        .then(({ requestDetachedPopout }) => requestDetachedPopout())
        .catch((err) => log.error('detached popout request failed', err));
      return;
    }
    if (id === 'shortcuts') deps.shortcuts?.showHelp();
    if (id === 'settings') openSettings();
    if (id === 'theme') openTheme();
    if (id === 'experimental-settings') openExperimental();
    if (id === 'export-transcript' && onExportTranscript) {
      exportInFlight = true;
      syncMenuItems();
      void onExportTranscript().finally(() => {
        exportInFlight = false;
        syncMenuItems();
      });
    }
  });

  refs.composerMeta.addEventListener('add-ai', openSettings);

  wireOpenSettingsSurfaces(refs, openSettings);

  wireChangeModelEvent({
    refs,
    log,
    openSettings,
    setPendingReplayMessageId: (id) => {
      pendingReplayMessageId = id;
    },
  });

  await wireLoginEvent({ refs, log, openSettings, refreshModels, applyIdentity, client });

  await wireAccountsChangedResync({ refreshModels, refreshModelPill, applyIdentity, client });
}

function buildOpenSettings(
  log: BootStageLogger,
  refreshModels: () => void,
  applyIdentity: () => void,
  updateModel: () => void
): () => void {
  return () => {
    import('./wc-settings.js')
      .then(({ showWcSettings }) => showWcSettings(log))
      .then(() => {
        refreshModels();
        applyIdentity();
        updateModel();
      })
      .catch((err) => log.error('WC settings dialog failed', err));
  };
}

function buildOpenTheme(
  log: BootStageLogger,
  keyboard?: {
    getTrigger: () => import('./wc-shortcuts.js').KeyboardTrigger;
    setTrigger: (trigger: import('./wc-shortcuts.js').KeyboardTrigger) => void;
    persistTrigger?: (trigger: import('./wc-shortcuts.js').KeyboardTrigger) => Promise<void>;
  }
): () => void {
  return () => {
    import('./wc-settings.js')
      .then(({ showThemeSettings }) =>
        showThemeSettings(
          log,
          keyboard
            ? {
                getTrigger: keyboard.getTrigger,
                setTrigger: keyboard.setTrigger,
                persistTrigger: keyboard.persistTrigger,
              }
            : undefined
        )
      )
      .catch((err) => log.error('Theme settings dialog failed', err));
  };
}

function themeKeyboardOpts(deps: WcNavDeps): Parameters<typeof buildOpenTheme>[1] {
  const shortcuts = deps.shortcuts;
  if (!shortcuts) return undefined;
  return {
    getTrigger: () => shortcuts.trigger(),
    setTrigger: (trigger) => shortcuts.setTrigger(trigger),
    persistTrigger: deps.persistKeyboardTrigger,
  };
}

function buildOpenExperimental(log: BootStageLogger): () => void {
  return () => {
    import('./wc-settings.js')
      .then(({ showExperimentalSettings }) => showExperimentalSettings(log))
      .catch((err) => log.error('Experimental settings dialog failed', err));
  };
}

function wireFollowersSegment(refs: WcShellRefs, log: BootStageLogger): void {
  refs.floatbar.addEventListener('slicc-followers-click', () => {
    openSyncDialog(log, { copy: false, initialTab: 'status' });
  });
}

function openSyncDialog(
  log: BootStageLogger,
  opts: { copy: boolean; initialTab?: SyncDialogTabId }
): void {
  const joinUrl = getLeaderTrayRuntimeStatus().session?.joinUrl;
  if (!joinUrl) return;
  if (opts.copy) void copyTextToClipboard(joinUrl).catch(() => undefined);
  void import('../legacy-styles.js')
    .then(({ loadLegacyDialogStyles }) => loadLegacyDialogStyles())
    .then(async () => {
      const { showSyncEnabledDialog } = await import('../sync-dialog.js');
      showSyncEnabledDialog({
        joinUrl,
        copied: opts.copy,
        initialTab: opts.initialTab,
        followers: getConnectedFollowersWithFallback(),
        onReset: getTrayResetter() ?? null,
      });
    })
    .catch((err) => log.error('sync dialog failed', err));
}

function handleTrayActionId(id: string, log: BootStageLogger): boolean {
  if (id === 'tray-enable') {
    void resolveTrayWorkerBaseUrl({
      locationHref: window.location.href,
      storage: window.localStorage,
      envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
      defaultWorkerBaseUrl: __DEV__
        ? DEFAULT_STAGING_TRAY_WORKER_BASE_URL
        : DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
    }).then((workerBaseUrl) => {
      if (!workerBaseUrl) return log.error('tray enable: no worker base URL resolvable');
      window.dispatchEvent(new CustomEvent('slicc:tray-leave', { detail: { workerBaseUrl } }));
    });
    return true;
  }
  if (id === 'tray-copy') {
    openSyncDialog(log, { copy: true });
    return true;
  }
  if (id === 'tray-stop') {
    window.dispatchEvent(new CustomEvent('slicc:tray-leave', { detail: { workerBaseUrl: null } }));
    return true;
  }
  return false;
}

function wireOpenSettingsSurfaces(refs: WcShellRefs, openSettings: () => void): void {
  refs.thread?.addEventListener('slicc-error-open-settings', openSettings);
  window.addEventListener('slicc:open-settings-from-panel', () => openSettings());
}

function wireChangeModelEvent(opts: {
  refs: WcShellRefs;
  log: BootStageLogger;
  openSettings(): void;
  setPendingReplayMessageId(id: string | null): void;
}): void {
  const { refs, log, openSettings, setPendingReplayMessageId } = opts;
  refs.thread?.addEventListener('slicc-error-change-model', (event) => {
    setPendingReplayMessageId(
      (event as CustomEvent<{ messageId?: string | null }>).detail?.messageId ?? null
    );
    const meta = refs.composerMeta as HTMLElement & { openMenu?: () => void };
    const models = (meta as HTMLElement & { models?: unknown[] }).models;
    if (Array.isArray(models) && models.length === 0) {
      openSettings();
      return;
    }
    try {
      meta.openMenu?.();
    } catch (err) {
      log.error('opening composer model picker failed', err);
    }
  });
}

async function wireLoginEvent(opts: {
  refs: WcShellRefs;
  log: BootStageLogger;
  openSettings(): void;
  refreshModels(): void;
  applyIdentity(): void;
  client: OffscreenClient;
}): Promise<void> {
  const { refs, log, openSettings, refreshModels, applyIdentity, client } = opts;
  const { getSelectedProvider, getProviderConfig, reloginOAuthAccount } = await import(
    '../provider-settings.js'
  );
  refs.thread?.addEventListener('slicc-error-login', () => {
    const provider = getSelectedProvider();
    const config = provider ? getProviderConfig(provider) : null;
    if (!config || (!config.onOAuthLogin && !config.onOAuthLoginIntercepted)) {
      openSettings();
      return;
    }
    void reloginOAuthAccount(config, () => {
      refreshModels();
      applyIdentity();
      client.updateModel();
    }).catch((err) => log.error('re-login from error card failed', err));
  });
}

async function wireModelPicker(
  refs: WcShellRefs,
  client: OffscreenClient,
  workUnits: Pick<WorkUnitClient, 'setModel'>,
  getUnits: () => readonly WorkUnitSummary[],
  onAfterModelChange?: () => void
): Promise<void> {
  const { resolveModelById, resolveCurrentModel, setSelectedModelId } = await import(
    '../provider-settings.js'
  );

  const bareModelId = (id: string): string => {
    const idx = id.indexOf(':');
    return idx > 0 ? id.slice(idx + 1) : id;
  };
  const applyThinkingCapability = (modelId?: string): void => {
    try {
      const model = modelId ? resolveModelById(bareModelId(modelId)) : resolveCurrentModel();
      refs.composerMeta.toggleAttribute(
        'no-thinking',
        (model as { reasoning?: boolean }).reasoning !== true
      );
    } catch {}
  };
  applyThinkingCapability();
  refs.composerMeta.addEventListener('model-change', (event) => {
    const detail = (event as CustomEvent<{ id?: string; source?: string }>).detail;
    const id = detail?.id;
    if (!id) return;

    if (detail?.source === 'follower') return;

    setSelectedModelId(id);
    applyThinkingCapability(id);
    void applyModelPickToSelectedCone(client, workUnits, getUnits(), id);

    onAfterModelChange?.();
  });
}

export async function applyModelPickToSelectedCone(
  client: Pick<OffscreenClient, 'selectedScoopJid'>,
  workUnits: Pick<WorkUnitClient, 'setModel'>,
  units: readonly WorkUnitSummary[],
  qualified: string,
  notify: () => void = notifyLeaderLocalModelStateChanged
): Promise<boolean> {
  const model = parseQualifiedModelId(qualified);
  if (!model) return false;
  const selectedJid = client.selectedScoopJid;
  const root = rootForSelection(units, selectedJid ? { id: selectedJid } : null);
  if (!root) return false;

  const applied = await workUnits.setModel(root.id, model);

  if (applied) notify();
  return applied === true;
}

async function wireAccountsChangedResync(opts: {
  refreshModels(): void;

  refreshModelPill(): void;
  applyIdentity(): void;
  client: OffscreenClient;
}): Promise<void> {
  const { refreshModels, refreshModelPill, applyIdentity, client } = opts;
  const { getAccounts, getProviderConfig } = await import('../provider-settings.js');
  window.addEventListener('slicc:accounts-changed', () => {
    refreshModels();
    refreshModelPill();
    applyIdentity();
    client.updateModel();
    for (const account of getAccounts()) {
      const fetchCatalog = getProviderConfig(account.providerId)?.refreshModels;
      if (!fetchCatalog) continue;
      void fetchCatalog()
        .then(() => {
          refreshModels();
          refreshModelPill();
          client.updateModel();
        })
        .catch(() => undefined);
    }
  });
}
