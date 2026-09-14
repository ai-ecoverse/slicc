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

  wireWcDetached({ client, isDetachedSelf: isDetached });

  const { setupSudoExtension } = await import('../boot/setup-sudo.js');
  await setupSudoExtension({ log });
  client.requestState();
  log.info('WC extension shell connected to offscreen engine');
}
