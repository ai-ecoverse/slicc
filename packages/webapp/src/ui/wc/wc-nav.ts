/**
 * Nav-level wiring for the live WC shell: the composer's model picker (fed
 * from the provider registry, persisted via the `selected-model` key), the
 * avatar menu (account settings via the provider-settings dialog — reused
 * until a WC-native settings panel exists), and the multi-browser tray
 * section (enable / copy join URL / stop / disconnect).
 */

import { getFollowerTrayRuntimeStatus } from '../../scoops/tray-follower-status.js';
import { getLeaderTrayRuntimeStatus } from '../../scoops/tray-leader.js';
import {
  DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
  DEFAULT_STAGING_TRAY_WORKER_BASE_URL,
  resolveTrayWorkerBaseUrl,
} from '../../scoops/tray-runtime-config.js';
import type { BootStageLogger } from '../boot/types.js';
import { copyTextToClipboard } from '../clipboard.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { GroupedModels } from '../provider-settings.js';
import { computeTrayMenuModel } from '../tray-join-url.js';
import type { WcShellRefs } from './wc-shell.js';

export interface MetaModel {
  name: string;
  provider?: string;
  /**
   * Provider-qualified model id (`providerId:modelId`). The picker echoes it
   * back on `model-change` so the handler persists the correct provider —
   * disambiguates models offered by multiple providers (e.g. `claude-opus-4-8`
   * under both adobe and github-copilot).
   */
  id: string;
}

/** The user identity to surface in the nav avatar + menu header. */
export interface NavIdentity {
  name: string;
  avatarUrl?: string;
  provider?: string;
}

/** Pick the richest identity from the connected accounts (name/avatar). */
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

/** Flatten provider-grouped models into the composer-meta picker shape. */
export function modelListForMeta(groups: readonly GroupedModels[]): MetaModel[] {
  return groups.flatMap((group) =>
    group.models.map((model) => ({
      name: model.name ?? model.id,
      provider: group.providerName,
      id: `${group.providerId}:${model.id}`,
    }))
  );
}

export interface WcNavDeps {
  refs: WcShellRefs;
  client: OffscreenClient;
  log: BootStageLogger;
}

export async function wireWcNav(deps: WcNavDeps): Promise<void> {
  const { refs, client, log } = deps;
  const { getAllAvailableModels, getAccounts } = await import('../provider-settings.js');

  const refreshModels = (): void => {
    (refs.composerMeta as HTMLElement & { models?: unknown }).models = modelListForMeta(
      getAllAvailableModels()
    );
  };
  refreshModels();
  await wireModelPicker(refs, client);

  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  const applyIdentity = (): void => {
    const identity = accountIdentity(getAccounts());
    const avatar = refs.avatarMenu.querySelector('slicc-avatar');
    // The send button paints the user's face as its circular ground — same
    // identity source as the nav avatar.
    const send = refs.inputCard.querySelector('slicc-send-button');
    if (identity) {
      avatar?.removeAttribute('initials');
      avatar?.setAttribute('name', identity.name);
      if (identity.avatarUrl) {
        avatar?.setAttribute('src', identity.avatarUrl);
        send?.setAttribute('src', identity.avatarUrl);
      }
      refs.avatarMenu.user = { name: identity.name, provider: identity.provider };
    } else {
      // Signed out: clear the avatar's identity so it shows the `?` placeholder
      // instead of an initial derived from a placeholder name.
      avatar?.removeAttribute('name');
      avatar?.removeAttribute('src');
      avatar?.removeAttribute('initials');
      send?.removeAttribute('src');
      refs.avatarMenu.user = {
        name: 'SLICC',
        provider: isExtension ? 'extension' : 'standalone',
      };
    }
  };
  applyIdentity();
  const trayMenuItems = (): NonNullable<typeof refs.avatarMenu.items> => {
    // Tray runs page-side only in standalone; the extension leader lives in
    // the offscreen document and keeps its own controls.
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
  // Pop out (extension side panel only): the detached tab IS the popout, so
  // it never offers one.
  const isDetachedSelf = new URLSearchParams(window.location.search).has('detached');
  const popoutItems = (): NonNullable<typeof refs.avatarMenu.items> =>
    isExtension && !isDetachedSelf
      ? [{ id: 'popout', label: 'Pop out into a tab', icon: 'external-link' }]
      : [];
  const syncMenuItems = (): void => {
    refs.avatarMenu.items = [
      { id: 'settings', label: 'Account settings…', icon: 'settings' },
      ...popoutItems(),
      ...trayMenuItems(),
    ];
  };
  syncMenuItems();
  // Tray state changes while the page lives — recompute on every open.
  refs.avatarMenu.addEventListener('slicc-avatar-menu-toggle', (event) => {
    if ((event as CustomEvent<{ open?: boolean }>).detail?.open) syncMenuItems();
  });
  const handleTrayAction = (id: string): boolean => {
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
      const joinUrl = getLeaderTrayRuntimeStatus().session?.joinUrl;
      if (joinUrl) {
        void copyTextToClipboard(joinUrl).catch(() => undefined);
        void import('../legacy-styles.js')
          .then(({ loadLegacyDialogStyles }) => loadLegacyDialogStyles())
          .then(async () => {
            const { showSyncEnabledDialog } = await import('../sync-dialog.js');
            showSyncEnabledDialog({ joinUrl, copied: true });
          })
          .catch((err) => log.error('sync dialog failed', err));
      }
      return true;
    }
    if (id === 'tray-stop') {
      window.dispatchEvent(
        new CustomEvent('slicc:tray-leave', { detail: { workerBaseUrl: null } })
      );
      return true;
    }
    return false;
  };

  // The WC-native settings surface (slicc-dialog chrome). The legacy
  // provider-settings dialog survives only for the onboarding-only
  // flows (connect surface, tray join).
  const openSettings = (): void => {
    import('./wc-settings.js')
      .then(({ showWcSettings }) => showWcSettings(log))
      .then(() => {
        refreshModels();
        applyIdentity();
        client.updateModel();
      })
      .catch((err) => log.error('WC settings dialog failed', err));
  };

  refs.avatarMenu.addEventListener('slicc-avatar-action', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (id && handleTrayAction(id)) {
      syncMenuItems();
      return;
    }
    if (id === 'popout') {
      import('./wc-detached.js')
        .then(({ requestDetachedPopout }) => requestDetachedPopout())
        .catch((err) => log.error('detached popout request failed', err));
      return;
    }
    if (id === 'settings') openSettings();
  });

  // No connected accounts → the model pill reads "Add AI" and clicking it
  // routes straight into account settings.
  refs.composerMeta.addEventListener('add-ai', openSettings);

  wireAccountsChangedResync({ refreshModels, applyIdentity, client });
}

/**
 * Model pick + capability reflection: picking a model persists the global
 * default (legacy `selected-model` key) and tells the worker to re-resolve,
 * and the active model's reasoning capability toggles `no-thinking` on the
 * composer so the thinking-effort pill only shows for a model that supports it.
 */
async function wireModelPicker(refs: WcShellRefs, client: OffscreenClient): Promise<void> {
  const { resolveModelById, resolveCurrentModel, setSelectedModelId } = await import(
    '../provider-settings.js'
  );
  /**
   * Strip the `providerId:` prefix before consulting `resolveModelById`,
   * which expects the bare model id (the provider is sourced from
   * `getSelectedProvider()` internally).
   */
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
    } catch {
      // Capability is decorative; never block on resolution.
    }
  };
  applyThinkingCapability();
  refs.composerMeta.addEventListener('model-change', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (!id) return;
    // Route through `setSelectedModelId` so the `providerId:` prefix is
    // guaranteed even if the picker ever hands us a bare id.
    setSelectedModelId(id);
    applyThinkingCapability(id);
    client.updateModel();
  });
}

/**
 * Re-sync the moment accounts change — an OAuth callback landing while the
 * settings dialog is still open, a shell `oauth-token` add, a removal. A
 * provider with a dynamic catalog (getModelIds) fetches it asynchronously:
 * kick its refreshModels and sync again when the catalog lands, so the
 * picker fills without a hard reload.
 */
async function wireAccountsChangedResync(opts: {
  refreshModels(): void;
  applyIdentity(): void;
  client: OffscreenClient;
}): Promise<void> {
  const { refreshModels, applyIdentity, client } = opts;
  const { getAccounts, getProviderConfig } = await import('../provider-settings.js');
  window.addEventListener('slicc:accounts-changed', () => {
    refreshModels();
    applyIdentity();
    client.updateModel();
    for (const account of getAccounts()) {
      const fetchCatalog = getProviderConfig(account.providerId)?.refreshModels;
      if (!fetchCatalog) continue;
      void fetchCatalog()
        .then(() => {
          refreshModels();
          client.updateModel();
        })
        .catch(() => undefined);
    }
  });
}
