/**
 * Playground Bridge — injected into every HTML page served by the preview
 * service worker. Provides `window.slicc` with the same API sprinkles have
 * (lick, on/off, setState/getState, readFile, close) using BroadcastChannel
 * to communicate back to the main SLICC app.
 *
 * This file is built as a self-contained IIFE (zero imports) via esbuild,
 * following the same pattern as preview-sw.ts.
 */

(function () {
  // Derive playground ID from the URL path (strip /preview prefix) + random suffix
  const pathname = location.pathname.replace(/^\/preview/, '') || '/';
  const id = pathname + ':' + Math.random().toString(36).slice(2, 8);

  const CHANNEL_NAME = 'slicc-playground';
  const bc = new BroadcastChannel(CHANNEL_NAME);

  type UpdateCallback = (data: unknown) => void;
  const updateListeners = new Set<UpdateCallback>();

  // Pending readFile requests
  const pendingReads = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>();

  // Pending getState requests
  let pendingGetState: { resolve: (v: unknown) => void } | null = null;

  bc.onmessage = (event: MessageEvent) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    // Only handle messages targeted at this playground
    if (msg.targetId !== id) return;

    switch (msg.type) {
      case 'playground-update':
        for (const cb of updateListeners) {
          try { cb(msg.data); } catch { /* ignore */ }
        }
        break;

      case 'playground-readfile-response': {
        const pending = pendingReads.get(msg.requestId);
        if (pending) {
          pendingReads.delete(msg.requestId);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.content);
        }
        break;
      }

      case 'playground-state-response': {
        if (pendingGetState) {
          const p = pendingGetState;
          pendingGetState = null;
          p.resolve(msg.data ?? null);
        }
        break;
      }
    }
  };

  const slicc = {
    name: pathname,

    lick(event: { action: string; data?: unknown } | string): void {
      const action = typeof event === 'string' ? event : event.action;
      const data = typeof event === 'string' ? undefined : event.data;
      bc.postMessage({ type: 'playground-lick', id, action, data });
    },

    on(event: string, callback: UpdateCallback): void {
      if (event === 'update') updateListeners.add(callback);
    },

    off(event?: string, callback?: UpdateCallback): void {
      if (!event || event === 'update') {
        if (callback) updateListeners.delete(callback);
        else updateListeners.clear();
      }
    },

    setState(data: unknown): void {
      bc.postMessage({ type: 'playground-set-state', id, data });
    },

    getState(): Promise<unknown> {
      return new Promise((resolve) => {
        pendingGetState = { resolve };
        bc.postMessage({ type: 'playground-get-state', id });
        // Timeout after 2s — return null if host doesn't respond
        setTimeout(() => {
          if (pendingGetState) {
            pendingGetState = null;
            resolve(null);
          }
        }, 2000);
      });
    },

    readFile(path: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const requestId = `rf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        pendingReads.set(requestId, { resolve, reject });
        bc.postMessage({ type: 'playground-readfile', id, requestId, path });
        setTimeout(() => {
          if (pendingReads.has(requestId)) {
            pendingReads.delete(requestId);
            reject(new Error('readFile timeout'));
          }
        }, 10000);
      });
    },

    close(): void {
      bc.postMessage({ type: 'playground-close', id });
      bc.close();
    },
  };

  (window as unknown as Record<string, unknown>).slicc = slicc;

  // Announce readiness so the host can register this playground
  bc.postMessage({ type: 'playground-ready', id, path: pathname });
})();
