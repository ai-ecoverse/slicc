/**
 * Extension-float boot for the WC shell, currently the detached popout
 * (`?detached=1&ui=wc`): the same prepared shell as standalone, attached to
 * the offscreen agent engine through an `OffscreenClient` over the default
 * `chrome.runtime` transport instead of a spawned kernel worker. The agent,
 * shell, and VFS live in the offscreen document; this page is UI-only.
 */

import type { BootStageLogger } from '../boot/types.js';
import { OffscreenClient } from '../offscreen-client.js';
import { wireWcDetached } from './wc-detached.js';
import { attachWcClient, createWcLiveCallbacks, prepareWcShell } from './wc-live.js';

export async function mountWcUiExtension(
  app: HTMLElement,
  log: BootStageLogger,
  isDetached = false
): Promise<void> {
  const boot = prepareWcShell(app, 'extension · wc');
  const client = new OffscreenClient(createWcLiveCallbacks(boot.wiring));
  attachWcClient(boot, client, log);
  // Detached-popout mutual exclusion: a detached tab claims the SW lock,
  // every other surface yields on the `detached-active` broadcast.
  wireWcDetached({ client, isDetachedSelf: isDetached });
  // Sudo approvals: the side-panel realm answers the offscreen broker.
  const { setupSudoExtension } = await import('../boot/setup-sudo.js');
  await setupSudoExtension({ log });
  client.requestState();
  log.info('WC extension shell connected to offscreen engine');
}
