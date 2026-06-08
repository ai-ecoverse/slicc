/**
 * `setup-extension-detached.ts` — detached-popout activation handler
 * and popout-button wiring extracted from `mainExtension`. The SW
 * broadcasts `detached-active` to side panels and the non-detached
 * `index.html` tab once a detached tab claims the lock; this stage
 * installs the listener that closes those windows when they should
 * yield to the detached tab.
 */

import { isExtensionMessage } from '../../../../chrome-extension/src/messages.js';
import { enterDetachedActiveState } from '../detached-active.js';
import type { Layout } from '../layout.js';
import type { OffscreenClient } from '../offscreen-client.js';

export interface ExtensionDetachedSetupDeps {
  client: OffscreenClient;
  layout: Layout;
  isDetachedSelf: boolean;
}

export function setupExtensionDetached(deps: ExtensionDetachedSetupDeps): void {
  const { client, layout, isDetachedSelf } = deps;

  chrome.runtime.onMessage.addListener((msg) => {
    if (!isExtensionMessage(msg)) return false;
    if (msg.source !== 'service-worker') return false;
    const payloadType = (msg.payload as { type?: string }).type;
    if (payloadType !== 'detached-active') return false;
    if (isDetachedSelf) return false;
    enterDetachedActiveState(client, layout);
    return false;
  });

  if (isDetachedSelf) {
    chrome.runtime
      .sendMessage({ source: 'panel', payload: { type: 'detached-claim' } })
      .catch(() => {
        // SW not ready or no receivers — Chrome's normal cold-start.
        // The claim is also re-emitted on Ctrl-R / reload.
      });
    return;
  }

  layout.setShowPopoutButton(true);
  layout.setPopoutClickHandler(() => {
    chrome.runtime
      .sendMessage({ source: 'panel', payload: { type: 'detached-popout-request' } })
      .catch((err) => {
        // SW unreachable or message rejected — re-enable the button so
        // the user can retry; surface the failure in the dev console.
        console.warn('[slicc] detached-popout-request failed', err);
        layout.resetPopoutButton();
      });
  });
}
