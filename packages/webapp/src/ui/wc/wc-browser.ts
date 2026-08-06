/**
 * Browser · CDP workbench wiring: the dock globe opens the library's
 * full-screen `<slicc-tab-overlay>` with every open tab — the local
 * browser's pages plus any tray follower's (composite
 * `runtimeId:targetId` ids whose CDP traffic rides the federated channel,
 * i.e. the tray's WebRTC data channel) — each card with a live screenshot
 * thumbnail. Activating a local card attaches + foregrounds that tab;
 * activating a follower's card pulls a state-carrying copy to the leader
 * (`teleportTabOneWay`) so it lands in front of THIS user. A card's ✕
 * closes it.
 */

import type { BrowserAPI } from '../../cdp/browser-api.js';
import { teleportTabOneWay } from '../../shell/supplemental-commands/playwright/tab-teleport.js';
import type { BootStageLogger } from '../boot/types.js';
import type { WcShellRefs } from './wc-shell.js';

/** The overlay's structural surface (typed loosely — composed BY TAG). */
interface TabOverlayLike extends HTMLElement {
  tabs: Array<{
    id: string;
    title?: string;
    url?: string;
    screenshot?: string;
    active?: boolean;
  }>;
  show(): void;
  hide(): void;
}

export interface WireWcBrowserDeps {
  refs: WcShellRefs;
  /**
   * The page-side BrowserAPI (the standalone CDP client). When a tray is
   * active the leader sync is installed as its target provider, so
   * `listAllTargets` includes follower tabs and attach/screenshot for the
   * composite ids beams over the WebRTC-backed remote transport.
   */
  browser: BrowserAPI;
  log: BootStageLogger;
  /** Thumbnail width (px); screenshots downscale to this. */
  thumbWidth?: number;
}

/** Handles returned for tests; production callers ignore them. */
export interface WcBrowserHandle {
  overlay: HTMLElement;
  refresh(): Promise<void>;
}

export function wireWcBrowser(deps: WireWcBrowserDeps): WcBrowserHandle {
  const { refs, browser, log } = deps;
  const overlay = document.createElement('slicc-tab-overlay') as TabOverlayLike;
  overlay.setAttribute('heading', 'Browser · open tabs');
  document.body.append(overlay);

  let refreshSeq = 0;
  const refresh = async (): Promise<void> => {
    const seq = ++refreshSeq;
    overlay.show();
    let pages: Awaited<ReturnType<BrowserAPI['listAllTargets']>>;
    try {
      pages = await browser.listAllTargets();
    } catch (err) {
      log.error('WC browser overlay: listing tabs failed', err);
      overlay.tabs = [];
      return;
    }
    if (seq !== refreshSeq) return;
    overlay.tabs = pages.map((p) => ({
      id: p.targetId,
      title: p.title || p.url || p.targetId,
      url: p.url,
    }));
    // Thumbnails land lazily, one tab at a time (each needs an attach; the
    // composite follower ids stream their capture over the WebRTC channel).
    for (const p of pages) {
      if (seq !== refreshSeq || !overlay.hasAttribute('open')) return;
      try {
        await browser.attachToPage(p.targetId);
        const shot = await browser.screenshot({
          format: 'jpeg',
          quality: 55,
          maxWidth: deps.thumbWidth ?? 480,
          // Never wake suspended tabs via bringToFront here — that steals
          // window focus from SLICC; they keep the globe placeholder.
          foregroundFallback: false,
        });
        if (seq !== refreshSeq) return;
        overlay.tabs = overlay.tabs.map((t) =>
          t.id === p.targetId ? { ...t, screenshot: `data:image/jpeg;base64,${shot}` } : t
        );
      } catch (err) {
        // Keep the globe placeholder for tabs that refuse to capture.
        log.warn('WC browser overlay: thumbnail failed', { target: p.targetId, err });
      }
    }
  };

  // Claim the surface so the shell's dock handler stops opening a workbench
  // pane behind this overlay. Claiming HERE (rather than hardcoding 'browser'
  // in the shell) keeps the pane fallback for every float that never reaches
  // this wiring — followers, cherry, extension — and for a leader whose
  // dynamic import of this module fails.
  refs.overlaySurfaces.add('browser');

  refs.dock.addEventListener('slicc-dock-select', (event) => {
    if ((event as CustomEvent<{ id?: string }>).detail?.id !== 'browser') return;
    void refresh();
    // One-shot launcher: the overlay IS the surface. Un-latch the dock (and
    // let the canonical collapse close any open pane + clear the ws param).
    (refs.dock as HTMLElement & { collapse?: () => void }).collapse?.();
  });

  overlay.addEventListener('tab-activate', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail.id;
    void (async () => {
      try {
        if (id.includes(':')) {
          // A follower's tab: focusing it over there wouldn't put it in front
          // of THIS user. Pull a copy to the leader instead — foreground, with
          // cookies + storage teleported (degrades to a bare URL open when the
          // source cannot serve state).
          const result = await teleportTabOneWay(browser, {
            sourceTargetId: id,
            destination: { kind: 'leader' },
          });
          log.info('WC browser overlay: pulled remote tab to leader', {
            source: id,
            target: result.targetId,
            degraded: result.degraded,
          });
          overlay.hide();
          return;
        }
        await browser.attachToPage(id);
        await browser.bringToFront();
        overlay.hide();
      } catch (err) {
        // Keep the overlay open so the user sees the tap did not take effect.
        log.error('WC browser overlay: tab activate failed', err);
      }
    })();
  });

  overlay.addEventListener('tab-close', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail.id;
    void browser
      .closePage(id)
      .then(() => refresh())
      .catch((err) => log.error('WC browser overlay: tab close failed', err));
  });

  return { overlay, refresh };
}
