import type { TrayTargetEntry } from '../../scoops/tray-sync-protocol.js';
import type { BootStageLogger } from '../boot/types.js';
import type { WcShellRefs } from './wc-shell.js';

const TAB_TELEPORT_MIN_PROTOCOL_VERSION = 6;

interface TabOverlayLike extends HTMLElement {
  tabs: Array<{ id: string; title?: string; url?: string; screenshot?: string; active?: boolean }>;
  show(): void;
  hide(): void;
}

export interface FollowerBrowserSync {
  requestTabTeleport(sourceTargetId: string): Promise<string>;
  getLeaderProtocolVersion(): number | undefined;
}

export interface WireWcFollowerBrowserDeps {
  refs: WcShellRefs;

  getSync: () => FollowerBrowserSync | null;

  getTargets: () => TrayTargetEntry[];

  hasCdpBrowser: () => boolean;
  window: Pick<Window, 'open'>;
  log: BootStageLogger;
}

export interface WcFollowerBrowserHandle {
  overlay: HTMLElement;
  refresh(): void;
}

export function wireWcFollowerBrowser(deps: WireWcFollowerBrowserDeps): WcFollowerBrowserHandle {
  const { refs, getSync, getTargets, hasCdpBrowser, log } = deps;

  if (refs.overlaySurfaces.has('browser')) {
    return { overlay: document.createElement('slicc-tab-overlay'), refresh: () => {} };
  }

  const overlay = document.createElement('slicc-tab-overlay') as TabOverlayLike;
  overlay.setAttribute('heading', 'Browser · tabs in this tray');

  overlay.setAttribute('no-peek', '');
  document.body.append(overlay);

  const refresh = (): void => {
    overlay.tabs = getTargets().map((target) => ({
      id: target.targetId,
      title: target.title || target.url || target.targetId,
      url: target.url,
    }));
  };

  refs.overlaySurfaces.add('browser');

  refs.dock.addEventListener('slicc-dock-select', (event) => {
    if ((event as CustomEvent<{ id?: string }>).detail?.id !== 'browser') return;
    refresh();
    overlay.show();
    (refs.dock as HTMLElement & { collapse?: () => void }).collapse?.();
  });

  overlay.addEventListener('tab-activate', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail.id;
    const sync = getSync();
    const leaderVersion = sync?.getLeaderProtocolVersion() ?? 0;
    const canTeleport =
      !!sync && hasCdpBrowser() && leaderVersion >= TAB_TELEPORT_MIN_PROTOCOL_VERSION;

    if (!canTeleport) {
      const url = overlay.tabs.find((tab) => tab.id === id)?.url;
      if (!url) {
        log.warn('WC follower browser: no URL for tab', { id });
        return;
      }
      const opened = deps.window.open(url, '_blank', 'noopener');
      if (!opened) log.warn('WC follower browser: window.open was blocked', { id });
      overlay.hide();
      return;
    }

    void sync
      .requestTabTeleport(id)
      .then((targetId) => {
        log.info('WC follower browser: leader teleported a tab here', { source: id, targetId });
        overlay.hide();
      })
      .catch((err) => {
        log.error('WC follower browser: tab teleport failed', err);
      });
  });

  return { overlay, refresh };
}
