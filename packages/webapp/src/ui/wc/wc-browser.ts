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

import { isSliccAppUrl } from '@slicc/shared-ts';
import type { BrowserAPI } from '../../cdp/browser-api.js';
import { teleportTabOneWay } from '../../scoops/tray-leader/tab-teleport.js';
import type { BootStageLogger } from '../boot/types.js';
import type { WcShellRefs } from './wc-shell.js';

/**
 * How long a peeked tab stays in front before SLICC comes back.
 *
 * Long enough to read a page, short enough that it never feels like a switch
 * you have to undo — the whole point of the gesture is that you do not have to
 * find your way back.
 */
const PEEK_MS = 5000;

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

/** What {@link createPeek} needs from the wiring around it. */
interface PeekDeps {
  browser: BrowserAPI;
  log: BootStageLogger;
  /** The going half — the same switch `tab-activate` performs. */
  activate(id: string): Promise<boolean>;
  /** The page the agent was driving before the switcher opened. */
  agentTarget(): string | null;
}

/**
 * Show a tab, then come back.
 *
 * A peek is a switch that undoes itself, so the going half IS `activate` —
 * and the reason that reports success is here: a peek that never left must
 * not schedule a trip home.
 *
 * Coming back has two steps that must not be confused. `bringToFront` on
 * SLICC's own target is what the USER sees; re-attaching whatever page the
 * AGENT was driving is what keeps the gesture out of its way, and is
 * invisible because attaching does not foreground. Only SLICC itself is
 * excluded from that restore — including when the agent was already on the
 * peeked tab, where skipping it would leave the agent driving SLICC's UI.
 */
function createPeek(deps: PeekDeps): (id: string) => Promise<void> {
  const { browser, log } = deps;

  /**
   * Which target is SLICC itself — the tab a peek comes back to.
   *
   * Resolved fresh per peek rather than remembered: a target id that has since
   * closed would strand the user in the tab they peeked. `location.href` is
   * the exact answer when it is there; a second SLICC tab on our own origin is
   * the near-enough fallback, since coming back to the wrong SLICC beats not
   * coming back at all. Never throws — not knowing the way home degrades the
   * peek to a plain switch, it does not stop the switch.
   */
  const findSelfTarget = async (): Promise<string | null> => {
    try {
      const pages = await browser.listAllTargets();
      const exact = pages.find((p) => p.url === location.href);
      if (exact) return exact.targetId;
      const selfOrigins = location?.origin ? [location.origin] : undefined;
      return pages.find((p) => isSliccAppUrl(p.url ?? '', { selfOrigins }))?.targetId ?? null;
    } catch (err) {
      log.warn('WC browser overlay: could not resolve the SLICC tab', err);
      return null;
    }
  };

  /** The pending return, so a second peek replaces the first rather than stacking. */
  let timer: ReturnType<typeof setTimeout> | null = null;

  return async (id: string): Promise<void> => {
    const previous = deps.agentTarget();
    const self = await findSelfTarget();
    if (!(await deps.activate(id))) return;
    if (!self) {
      log.warn('WC browser overlay: peek cannot find the SLICC tab; staying put', { target: id });
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void (async () => {
        try {
          await browser.attachToPage(self);
          await browser.bringToFront();
          if (previous && previous !== self) await browser.attachToPage(previous);
        } catch (err) {
          log.error('WC browser overlay: peek return failed', err);
        }
      })();
    }, PEEK_MS);
  };
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
  /**
   * The page the AGENT was driving before the switcher opened.
   *
   * Captured here because the thumbnail loop below attaches to every tab in
   * turn: by the time a peek runs, `getAttachedTargetId()` is whichever card
   * was captured last, and restoring that would silently re-point the agent
   * at a tab the user merely looked at. Only taken while the overlay is shut,
   * so a refresh triggered from inside it (closing a tab) cannot overwrite the
   * real answer with a thumbnail's.
   */
  let agentTarget: string | null = null;
  const refresh = async (): Promise<void> => {
    if (!overlay.hasAttribute('open')) agentTarget = browser.getAttachedTargetId();
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
    // Hide SLICC's own app tabs — ours and any federated peer's. They are the
    // window you are looking at, not somewhere to go, and their URLs carry a
    // bridge capability. Filtering here also covers a peer running an older
    // build that still advertises its shell.
    const selfOrigins = location?.origin ? [location.origin] : undefined;
    pages = pages.filter((p) => !isSliccAppUrl(p.url ?? '', { selfOrigins }));
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
          quality: 72,
          // Cards are `minmax(220px, 1fr)` and stretch well past that in a
          // wide window, so a 480px capture was being upscaled — the reason
          // thumbnails looked soft. Capture at device resolution for the
          // widest realistic card instead of CSS pixels.
          maxWidth: deps.thumbWidth ?? Math.round(560 * Math.min(devicePixelRatio || 1, 2)),
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

  /**
   * Switch to a tab for good: attach, foreground, and get out of the way.
   *
   * Shared with peek, whose going half is this exact action — and the reason
   * it REPORTS success rather than swallowing failure silently: a peek that
   * never left must not schedule a trip home.
   */
  const activate = async (id: string): Promise<boolean> => {
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
        return true;
      }
      await browser.attachToPage(id);
      await browser.bringToFront();
      overlay.hide();
      return true;
    } catch (err) {
      // Keep the overlay open so the user sees the tap did not take effect.
      log.error('WC browser overlay: tab activate failed', err);
      return false;
    }
  };

  overlay.addEventListener('tab-activate', (event) => {
    void activate((event as CustomEvent<{ id: string }>).detail.id);
  });

  const peek = createPeek({ browser, log, activate, agentTarget: () => agentTarget });

  overlay.addEventListener('tab-peek', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail.id;
    // A follower's tab is not somewhere this browser can go and come back
    // from — activating it pulls a COPY here (`teleportTabOneWay`), which is
    // not a visit at all. Let the ordinary path teleport it instead.
    if (id.includes(':')) {
      void activate(id);
      return;
    }
    void peek(id).catch((err) => log.error('WC browser overlay: peek failed', err));
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
