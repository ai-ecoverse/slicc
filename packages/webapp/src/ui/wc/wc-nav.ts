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
      id: model.id,
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
  const { getAllAvailableModels, showProviderSettings } = await import('../provider-settings.js');

  const refreshModels = (): void => {
    (refs.composerMeta as HTMLElement & { models?: unknown }).models = modelListForMeta(
      getAllAvailableModels()
    );
  };
  refreshModels();

  // Picking a model persists the global default (the legacy `selected-model`
  // key) and tells the worker to re-resolve — same flow as the legacy header.
  refs.composerMeta.addEventListener('model-change', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (!id) return;
    localStorage.setItem('selected-model', id);
    client.updateModel();
  });

  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  const { getAccounts } = await import('../provider-settings.js');
  const applyIdentity = (): void => {
    const identity = accountIdentity(getAccounts());
    const avatar = refs.avatarMenu.querySelector('slicc-avatar');
    if (identity) {
      avatar?.setAttribute('name', identity.name);
      if (identity.avatarUrl) avatar?.setAttribute('src', identity.avatarUrl);
      refs.avatarMenu.user = { name: identity.name, provider: identity.provider };
    } else {
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
  const syncMenuItems = (): void => {
    refs.avatarMenu.items = [
      { id: 'settings', label: 'Account settings…', icon: 'settings' },
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

  refs.avatarMenu.addEventListener('slicc-avatar-action', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (id && handleTrayAction(id)) {
      syncMenuItems();
      return;
    }
    if (id === 'settings') {
      // The settings dialog needs its (scoped) chrome; loaded on demand so
      // the WC shell stays free of the broader legacy sheets.
      import('../legacy-styles.js')
        .then(({ loadLegacyDialogStyles }) => loadLegacyDialogStyles())
        .then(() => showProviderSettings())
        .then(() => {
          refreshModels();
          applyIdentity();
          client.updateModel();
        })
        .catch((err) => log.error('WC settings dialog failed', err));
    }
  });
}
