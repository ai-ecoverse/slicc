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

  refs.avatarMenu.user = { name: 'SLICC', provider: 'standalone · wc' };
  refs.avatarMenu.items = [
    { id: 'settings', label: 'Account settings…', icon: 'settings' },
    { kind: 'separator' },
    { id: 'legacy-ui', label: 'Open legacy UI', icon: 'panel-left' },
  ];
  refs.avatarMenu.addEventListener('slicc-avatar-action', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (id === 'settings') {
      showProviderSettings()
        .then(() => {
          refreshModels();
          client.updateModel();
        })
        .catch((err) => log.error('WC settings dialog failed', err));
      return;
    }
    if (id === 'legacy-ui') navigate(legacyUiUrl(window.location.href));
  });
}
