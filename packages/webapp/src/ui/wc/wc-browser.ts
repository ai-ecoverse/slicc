import { isSliccAppUrl } from '@slicc/shared-ts';
import type { TabDescriptor } from '@slicc/webcomponents';
import type { BrowserAPI } from '../../cdp/browser-api.js';
import { teleportTabOneWay } from '../../scoops/tray-leader/tab-teleport.js';
import type { BootStageLogger } from '../boot/types.js';
import { bindComputerOverlay, mergeOverlayTabs, parseComputerOverlayId } from './wc-computers.js';
import type { WcShellRefs } from './wc-shell.js';

const PEEK_MS = 5000;

interface TabOverlayLike extends HTMLElement {
  tabs: TabDescriptor[];
  show(): void;
  hide(): void;
}

export interface WireWcBrowserDeps {
  refs: WcShellRefs;

  browser: BrowserAPI;
  log: BootStageLogger;

  thumbWidth?: number;
}

interface PeekDeps {
  browser: BrowserAPI;
  log: BootStageLogger;

  activate(id: string): Promise<boolean>;

  agentTarget(): string | null;
}

function createPeek(deps: PeekDeps): (id: string) => Promise<void> {
  const { browser, log } = deps;

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
          await browser.bringTabToFront(self);
          if (previous && previous !== self) await browser.selectTab(previous);
        } catch (err) {
          log.error('WC browser overlay: peek return failed', err);
        }
      })();
    }, PEEK_MS);
  };
}

export interface WcBrowserHandle {
  overlay: HTMLElement;
  refresh(): Promise<void>;
}

export function wireWcBrowser(deps: WireWcBrowserDeps): WcBrowserHandle {
  const { refs, browser, log } = deps;
  const overlay = document.createElement('slicc-tab-overlay') as TabOverlayLike;
  overlay.setAttribute('heading', 'Browser · tabs & computers');
  document.body.append(overlay);
  bindComputerOverlay(overlay, log);

  let refreshSeq = 0;

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
      overlay.tabs = mergeOverlayTabs([]);
      return;
    }
    if (seq !== refreshSeq) return;

    const selfOrigins = location?.origin ? [location.origin] : undefined;
    pages = pages.filter((p) => !isSliccAppUrl(p.url ?? '', { selfOrigins }));
    overlay.tabs = mergeOverlayTabs(
      pages.map((p) => ({
        id: p.targetId,
        title: p.title || p.url || p.targetId,
        url: p.url,
      }))
    );

    for (const p of pages) {
      if (seq !== refreshSeq || !overlay.hasAttribute('open')) return;
      try {
        const shot = await browser.withTab(p.targetId, (page) =>
          page.screenshot({
            format: 'jpeg',
            quality: 72,

            maxWidth: deps.thumbWidth ?? Math.round(560 * Math.min(devicePixelRatio || 1, 2)),

            foregroundFallback: false,
          })
        );
        if (seq !== refreshSeq) return;
        overlay.tabs = overlay.tabs.map((t) =>
          t.id === p.targetId ? { ...t, screenshot: `data:image/jpeg;base64,${shot}` } : t
        );
      } catch (err) {
        log.warn('WC browser overlay: thumbnail failed', { target: p.targetId, err });
      }
    }
  };

  refs.overlaySurfaces.add('browser');

  refs.dock.addEventListener('slicc-dock-select', (event) => {
    if ((event as CustomEvent<{ id?: string }>).detail?.id !== 'browser') return;
    void refresh();

    (refs.dock as HTMLElement & { collapse?: () => void }).collapse?.();
  });

  const activate = async (id: string): Promise<boolean> => {
    try {
      if (id.includes(':')) {
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
      await browser.bringTabToFront(id);
      overlay.hide();
      return true;
    } catch (err) {
      log.error('WC browser overlay: tab activate failed', err);
      return false;
    }
  };

  overlay.addEventListener('tab-activate', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail.id;
    if (parseComputerOverlayId(id)) return;
    void activate(id);
  });

  const peek = createPeek({ browser, log, activate, agentTarget: () => agentTarget });

  overlay.addEventListener('tab-peek', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail.id;

    if (parseComputerOverlayId(id)) return;

    if (id.includes(':')) {
      void activate(id);
      return;
    }
    void peek(id).catch((err) => log.error('WC browser overlay: peek failed', err));
  });

  overlay.addEventListener('tab-close', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail.id;
    if (parseComputerOverlayId(id)) return;
    void browser
      .closePage(id)
      .then(() => refresh())
      .catch((err) => log.error('WC browser overlay: tab close failed', err));
  });

  return { overlay, refresh };
}
