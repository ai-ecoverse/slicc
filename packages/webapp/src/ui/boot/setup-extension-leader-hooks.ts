/**
 * `setup-extension-leader-hooks.ts` — stands up the production
 * chrome.runtime transports and hands them to the shared
 * `createExtensionLeaderHooks` helper. Disposes hooks on unload to
 * mirror `host.dispose()` in `offscreen.ts`.
 *
 * Extracted verbatim from `mainExtension`.
 */

import type {
  PanelMessageSender,
  PanelMessageSubscriber,
} from '../../../../chrome-extension/src/bridge-transport.js';
import type { ChatPanel } from '../chat-panel.js';
import {
  createExtensionLeaderHooks,
  type ExtensionLeaderHooksHandle,
} from '../extension-leader-hooks.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { SprinkleManager } from '../sprinkle-manager.js';
import type { BootStageLogger } from './types.js';

export interface ExtensionLeaderHooksDeps {
  sprinkleManager: SprinkleManager;
  client: OffscreenClient;
  chat: ChatPanel;
  log: BootStageLogger;
}

export function setupExtensionLeaderHooks(
  deps: ExtensionLeaderHooksDeps
): ExtensionLeaderHooksHandle {
  const sender: PanelMessageSender = {
    send(envelope) {
      chrome.runtime.sendMessage(envelope).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/receiving end does not exist/i.test(msg)) return;
        deps.log.error('Panel → offscreen sendMessage failed (leader)', { error: msg });
      });
    },
  };
  const subscriber: PanelMessageSubscriber = {
    onMessage(handler) {
      const listener = (msg: unknown): boolean => {
        if (!msg || typeof msg !== 'object' || !('source' in msg) || !('payload' in msg)) {
          return false;
        }
        handler(msg as { source: string; payload: unknown });
        return false;
      };
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.onMessage.removeListener(listener);
    },
  };
  const hooks = createExtensionLeaderHooks({
    sender,
    subscriber,
    sprinkleManager: deps.sprinkleManager,
    client: deps.client,
    chat: deps.chat,
    log: deps.log,
  });
  window.addEventListener('beforeunload', () => hooks.dispose(), { once: true });
  return hooks;
}
