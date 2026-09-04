/**
 * Extension-float boot for the WC shell, currently the detached popout
 * (`?detached=1&ui=wc`): the same prepared shell as standalone, attached to
 * the offscreen agent engine through an `OffscreenClient` over the default
 * `chrome.runtime` transport instead of a spawned kernel worker. The agent,
 * shell, and VFS live in the offscreen document; this page is UI-only.
 */

import type { BootStageLogger } from '../boot/types.js';
import { OffscreenClient } from '../offscreen-client.js';
import { createLeaderChatHost } from './wc-chat-host.js';
import { wireWcDetached } from './wc-detached.js';
import { attachWcWorkbench } from './wc-live.js';
import { createWcLiveCallbacks, ensureWorkUnitClient } from './wc-live-callbacks.js';
import { mountWcShell } from './wc-mount.js';

export async function bootExtensionFloat(
  app: HTMLElement,
  log: BootStageLogger,
  isDetached = false
): Promise<void> {
  let client!: OffscreenClient;
  // The same mount every float uses (#2382 D2b): this one's transport is an
  // `OffscreenClient` over the default `chrome.runtime` port — the agent, the
  // shell and the VFS all live in the offscreen document — and it opens the
  // same workbench a spawned-kernel leader does.
  await mountWcShell(app, log, {
    floatKind: 'extension',
    connect: (boot) => {
      client = new OffscreenClient(createWcLiveCallbacks(boot.wiring));
      const host = createLeaderChatHost(client);
      return {
        client: ensureWorkUnitClient(boot.wiring),
        host,
        workbench: (mounted, chat) => {
          attachWcWorkbench(mounted, client, chat, host, log);
        },
      };
    },
  });
  // Detached-popout mutual exclusion: a detached tab claims the SW lock,
  // every other surface yields on the `detached-active` broadcast.
  wireWcDetached({ client, isDetachedSelf: isDetached });
  // Sudo approvals: the side-panel realm answers the offscreen broker.
  const { setupSudoExtension } = await import('../boot/setup-sudo.js');
  await setupSudoExtension({ log });
  client.requestState();
  log.info('WC extension shell connected to offscreen engine');
}
