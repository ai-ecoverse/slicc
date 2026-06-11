/**
 * Nav-level wiring for the live WC shell: the composer's model picker (fed
 * from the provider registry, persisted via the legacy `selected-model` key)
 * and the avatar menu (account settings via the legacy provider-settings
 * dialog — reused until a WC-native settings panel exists — plus an escape
 * hatch back to the legacy UI).
 */

import type { BootStageLogger } from '../boot/types.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { GroupedModels } from '../provider-settings.js';
import { isWcUiPinned, setWcUiPinned } from './wc-flag.js';
import type { WcShellRefs } from './wc-shell.js';

export interface MetaModel {
  name: string;
  provider?: string;
  id: string;
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
  /** Navigation hook (tests inject a fake; defaults to a location change). */
  navigate?: (url: string) => void;
}

/** Strip the WC flag from the current URL — the legacy-UI escape hatch. */
export function legacyUiUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('ui');
  return url.toString();
}

export async function wireWcNav(deps: WcNavDeps): Promise<void> {
  const { refs, client, log } = deps;
  const navigate = deps.navigate ?? ((url: string) => window.location.assign(url));
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
  refs.avatarMenu.user = {
    name: 'SLICC',
    provider: isExtension ? 'extension · wc' : 'standalone · wc',
  };
  const syncMenuItems = (): void => {
    refs.avatarMenu.items = [
      { id: 'settings', label: 'Account settings…', icon: 'settings' },
      ...(isExtension
        ? [
            {
              id: 'pin-sidepanel',
              label: isWcUiPinned(localStorage)
                ? 'Unpin WC UI from side panel'
                : 'Pin WC UI in side panel',
              icon: 'pin',
            },
          ]
        : []),
      { kind: 'separator' as const },
      { id: 'legacy-ui', label: 'Open legacy UI', icon: 'panel-left' },
    ];
  };
  syncMenuItems();
  refs.avatarMenu.addEventListener('slicc-avatar-action', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (id === 'pin-sidepanel') {
      setWcUiPinned(localStorage, !isWcUiPinned(localStorage));
      syncMenuItems();
      return;
    }
    if (id === 'settings') {
      // The legacy dialog needs its (scoped) chrome; loaded on demand so the
      // WC shell stays free of the colliding legacy sheets.
      import('../legacy-styles.js')
        .then(({ loadLegacyDialogStyles }) => loadLegacyDialogStyles())
        .then(() => showProviderSettings())
        .then(() => {
          refreshModels();
          client.updateModel();
        })
        .catch((err) => log.error('WC settings dialog failed', err));
      return;
    }
    if (id === 'legacy-ui') {
      // In the pinned side panel the URL carries no flag — unpin so the
      // reload (and every future panel open) boots the legacy UI.
      if (isExtension) setWcUiPinned(localStorage, false);
      navigate(legacyUiUrl(window.location.href));
    }
  });
}
