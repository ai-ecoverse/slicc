/**
 * Detached-popout mutual exclusion for the extension float — the WC-shell
 * successor of the deleted `boot/setup-extension-detached.ts` +
 * `detached-active.ts` pair. The service worker is the lock coordinator:
 * a detached tab claims the lock with `detached-claim`, the SW broadcasts
 * `detached-active`, and every non-detached surface (side panel,
 * non-detached `index.html` tabs) yields — close if possible, lock the
 * client send chokepoint, and show a non-dismissible overlay.
 *
 * Spec: docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md
 */

import { isExtensionMessage } from '../../kernel/messages.js';
import type { OffscreenClient } from '../offscreen-client.js';

const OVERLAY_ID = 'slicc-detached-overlay';

export function wireWcDetached(opts: { client: OffscreenClient; isDetachedSelf: boolean }): void {
  const { client, isDetachedSelf } = opts;

  chrome.runtime.onMessage.addListener((msg) => {
    if (!isExtensionMessage(msg)) return false;
    if (msg.source !== 'service-worker') return false;
    if ((msg.payload as { type?: string }).type !== 'detached-active') return false;
    // The detached tab itself is the lock holder — it never yields.
    if (isDetachedSelf) return false;
    enterWcDetachedActiveState(client);
    return false;
  });

  if (isDetachedSelf) {
    // Claim (or re-claim after Ctrl-R) the SW lock. A rejection is Chrome's
    // normal cold start — the SW reconciles the lock on boot anyway.
    void chrome.runtime
      .sendMessage({ source: 'panel', payload: { type: 'detached-claim' } })
      .catch(() => undefined);
  }
}

/** Ask the service worker to open (or focus) the detached popout tab. */
export function requestDetachedPopout(): void {
  void chrome.runtime
    .sendMessage({ source: 'panel', payload: { type: 'detached-popout-request' } })
    .catch((err) => {
      console.warn('[slicc] detached-popout-request failed', err);
    });
}

/**
 * Three independent yield layers, in order: `window.close()` is the happy
 * path but Chrome may no-op it; `setLocked(true)` flips the
 * `OffscreenClient.send()` chokepoint BEFORE anything yields to the event
 * loop so no user action can slip through; the overlay is the visible
 * fallback with the only escape being a user-initiated close.
 */
export function enterWcDetachedActiveState(client: OffscreenClient): void {
  try {
    window.close();
  } catch {
    // Some Chrome configurations refuse scripted close — layers 2+3 cover it.
  }
  client.setLocked(true);
  showDetachedActiveOverlay();
}

function showDetachedActiveOverlay(): void {
  if (document.getElementById(OVERLAY_ID)) return;
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;' +
    'background:var(--canvas,#fff);color:var(--ink,#111);font:14px/1.5 var(--ui,system-ui)';
  const title = document.createElement('strong');
  title.textContent = 'SLICC is open in a detached window';
  const detail = document.createElement('span');
  detail.textContent = 'This panel yields while the detached window is active.';
  const close = document.createElement('button');
  close.textContent = 'Close this window';
  close.style.cssText =
    'margin-top:8px;padding:8px 16px;border:none;border-radius:999px;cursor:pointer;' +
    'background:var(--ink,#111);color:var(--canvas,#fff);font:600 13px var(--ui,system-ui)';
  close.addEventListener('click', () => window.close());
  overlay.append(title, detail, close);
  document.body.appendChild(overlay);
}
