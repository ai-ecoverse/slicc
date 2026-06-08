/**
 * `setup-extension-follower-sprinkle.ts` — wires the side-panel side of
 * the follower-sprinkle controller. The WebRTC follower lives in the
 * offscreen document; this side runs the DOM-bound sprinkle renderer
 * and shares layout callbacks with the local `SprinkleManager` so
 * leader-pushed sprinkles surface in the same rail as local ones.
 *
 * Extracted verbatim from `mainExtension`.
 */

import type { Layout } from '../layout.js';
import type { BootStageLogger } from './types.js';

export interface ExtensionFollowerSprinkleDeps {
  layout: Layout;
  log: BootStageLogger;
}

export async function setupExtensionFollowerSprinkle(
  deps: ExtensionFollowerSprinkleDeps
): Promise<void> {
  const { layout, log } = deps;
  const { PanelFollowerSprinkleProxy } = await import(
    '../../../../chrome-extension/src/follower-sprinkle-bridge.js'
  );
  const { SprinkleFollowerController } = await import('../sprinkle-follower-controller.js');
  const sender = {
    send(envelope: { source: 'panel'; payload: unknown }): void {
      chrome.runtime.sendMessage(envelope).catch((err: unknown) => {
        // "Receiving end does not exist" is expected when no offscreen is
        // awake. Anything else (context invalidated, message size, …) is
        // a real bug — log at `error` since prod default level is ERROR.
        const msg = err instanceof Error ? err.message : String(err);
        if (/receiving end does not exist/i.test(msg)) return;
        log.error('Panel → offscreen sendMessage failed', { error: msg });
      });
    },
  };
  const subscriber = {
    onMessage(handler: (envelope: { source: string; payload: unknown }) => void): () => void {
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
  let controller: InstanceType<typeof SprinkleFollowerController> | null = null;
  const proxy = new PanelFollowerSprinkleProxy(sender, subscriber, {
    onSprinklesList: (sprinkles) => void controller?.updateAvailable(sprinkles),
    onSprinkleUpdate: (name, data) => controller?.handleSprinkleUpdate(name, data),
  });
  controller = new SprinkleFollowerController({
    sync: proxy,
    addSprinkle: (name, title, element, zone, opts) =>
      layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined, opts),
    removeSprinkle: (name) => layout.removeSprinkle(name),
  });
}
