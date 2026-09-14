import type { SprinkleSendTarget } from '../shell/sprinkle-manager-handle.js';
import type { SprinkleManager } from './sprinkle-manager.js';

export async function handleSprinkleOp(
  sprinkleManager: SprinkleManager,
  id: unknown,
  op: string,
  name: string,
  data: unknown,
  target?: SprinkleSendTarget
): Promise<void> {
  try {
    let result: unknown;
    switch (op) {
      case 'list':
        await sprinkleManager.refresh();
        result = sprinkleManager.available();
        break;
      case 'opened':
        result = sprinkleManager.opened();
        break;
      case 'refresh':
        await sprinkleManager.refresh();
        result = sprinkleManager.available().length;
        break;
      case 'open':
        await sprinkleManager.open(name);
        result = true;
        break;
      case 'close':
        sprinkleManager.close(name);
        result = true;
        break;
      case 'send':
        result = sprinkleManager.sendToSprinkle(name, data, target);
        break;
      case 'reload':
        await sprinkleManager.reload(name);
        result = true;
        break;
      case 'openNewAutoOpen':
        await sprinkleManager.openNewAutoOpenSprinkles();
        result = true;
        break;
    }
    (
      chrome.runtime.sendMessage({
        source: 'panel',
        payload: { type: 'sprinkle-op-response', id, result },
      }) as Promise<unknown>
    ).catch(() => {});
  } catch (err) {
    (
      chrome.runtime.sendMessage({
        source: 'panel',
        payload: {
          type: 'sprinkle-op-response',
          id,
          error: err instanceof Error ? err.message : String(err),
        },
      }) as Promise<unknown>
    ).catch(() => {});
  }
}
