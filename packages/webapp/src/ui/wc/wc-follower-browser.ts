/**
 * Follower-side browser rail: the dock globe opens the same
 * `<slicc-tab-overlay>` the leader uses, populated from the leader's
 * `targets.registry` broadcast (every tab in the tray, wherever it lives).
 *
 * Activating a card means "open that tab in front of ME". A follower with a
 * real CDP surface asks the leader to teleport it here with cookies + web
 * storage; a follower without one (ui-only side panel, cherry) falls back to
 * a plain `window.open` issued INSIDE the click handler, so the user
 * activation that lets it through the popup blocker is still live.
 */

import type { TrayTargetEntry } from '../../scoops/tray-sync-protocol.js';
import type { BootStageLogger } from '../boot/types.js';
import type { WcShellRefs } from './wc-shell.js';

/** Minimum leader protocol version that understands `tab.teleport.request`. */
const TAB_TELEPORT_MIN_PROTOCOL_VERSION = 6;

/** The overlay's structural surface (typed loosely — composed BY TAG). */
interface TabOverlayLike extends HTMLElement {
  tabs: Array<{ id: string; title?: string; url?: string; screenshot?: string; active?: boolean }>;
  show(): void;
  hide(): void;
}

/** The slice of `FollowerSyncManager` this module needs. */
export interface FollowerBrowserSync {
  requestTabTeleport(sourceTargetId: string): Promise<string>;
  getLeaderProtocolVersion(): number | undefined;
}

export interface WireWcFollowerBrowserDeps {
  refs: WcShellRefs;
  /** Live accessor — the sync instance is replaced on every reconnect. */
  getSync: () => FollowerBrowserSync | null;
  /** Latest `targets.registry` payload from the leader. */
  getTargets: () => TrayTargetEntry[];
  /** False for ui-only / cherry floats that cannot host a teleported tab. */
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

  // A leader-capable float that JOINS a tray keeps its own tab switcher
  // (`wireWcBrowser`) wired from boot, and that one already opens tabs locally
  // — which is the right destination here, since "in front of me" means this
  // machine either way. Mounting a second overlay would give the globe two
  // listeners and two full-screen surfaces racing on one click. First claim
  // wins; only floats with no switcher of their own (the dedicated follower
  // mount, cherry, the extension side panel) reach the wiring below.
  if (refs.overlaySurfaces.has('browser')) {
    return { overlay: document.createElement('slicc-tab-overlay'), refresh: () => {} };
  }

  const overlay = document.createElement('slicc-tab-overlay') as TabOverlayLike;
  overlay.setAttribute('heading', 'Browser · tabs in this tray');
  // No peeking here: these tabs belong to the LEADER's browser, and activating
  // one pulls a copy to this float for good. There is nowhere to come back
  // from, so the affordance must not be offered rather than quietly meaning
  // something else than it says.
  overlay.setAttribute('no-peek', '');
  document.body.append(overlay);

  // No thumbnails: a follower cannot originate federated CDP, so cards keep
  // the component's globe placeholder.
  const refresh = (): void => {
    overlay.tabs = getTargets().map((target) => ({
      id: target.targetId,
      title: target.title || target.url || target.targetId,
      url: target.url,
    }));
  };

  // Claim the surface so the shell (and the panelized dock rail) stop opening
  // a placeholder pane behind this overlay.
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
      // Degraded path — MUST stay synchronous inside the click so the popup
      // blocker sees a live user activation.
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
        // Keep the overlay open so the user sees the tap did not take effect.
        log.error('WC follower browser: tab teleport failed', err);
      });
  });

  return { overlay, refresh };
}
