/**
 * `setup-standalone-sprinkle.ts` — constructs the page-side
 * `SprinkleManager` for the standalone-worker float, publishes it on
 * `globalThis.__slicc_sprinkleManager`, wires the trusted-dip
 * `slicc.exec()` / `slicc.agent()` bridge through `setDipExecHandler`,
 * and installs the panel-RPC channel handler so worker-side shell
 * commands can drive the manager.
 *
 * Extracted verbatim from `mainStandaloneWorker` (~main.ts:620–742).
 * `sprinkleFs` selection (memory-mode page `localFs` vs. the
 * page→worker `RemoteSprinkleVfs`) keeps `.shtml` discovery + sprinkle
 * writes pointed at real files under `slicc_opfs_vfs=opfs`.
 */

import type { VirtualFS } from '../../fs/index.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import { createRemoteSprinkleVfs } from '../../kernel/remote-sprinkle-vfs.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import { setDipExecHandler } from '../dip.js';
import type { Layout } from '../layout.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { SprinkleManager } from '../sprinkle-manager.js';
import { createSprinkleExecHandler } from './setup-sprinkle-exec.js';

export interface StandaloneSprinkleDeps {
  client: OffscreenClient;
  layout: Layout;
  localFs: VirtualFS;
  panelReadVfs: LocalVfsClient;
  writableFs: WritableVfsClient;
  useRpcVfs: boolean;
  instanceId: string;
  inlineSprinkles: ReadonlySet<string>;
  interceptWelcomeLick(event: LickEvent): boolean;
}

export interface StandaloneSprinkleHandle {
  sprinkleManager: InstanceType<typeof SprinkleManager>;
  stopSprinkleHandler(): void;
}

export async function setupStandaloneSprinkle(
  deps: StandaloneSprinkleDeps
): Promise<StandaloneSprinkleHandle> {
  const {
    client,
    layout,
    localFs,
    panelReadVfs,
    writableFs,
    useRpcVfs,
    instanceId,
    inlineSprinkles,
    interceptWelcomeLick,
  } = deps;
  const { SprinkleManager } = await import('../sprinkle-manager.js');
  const { installSprinkleManagerHandlerOverChannel } = await import(
    '../../scoops/sprinkle-bridge-channel.js'
  );
  const sprinkleFs = useRpcVfs
    ? createRemoteSprinkleVfs({ reader: panelReadVfs, writer: writableFs })
    : localFs;
  let sprinkleManager!: InstanceType<typeof SprinkleManager>;
  sprinkleManager = new SprinkleManager(
    sprinkleFs,
    async (event: LickEvent) => {
      if (event.type === 'sprinkle') {
        if (interceptWelcomeLick(event)) {
          if ((event.body as Record<string, unknown> | null)?.action === 'shortcut-migrate') {
            sprinkleManager.close('welcome');
          }
          return;
        }
        if (event.sprinkleName) {
          client.sendSprinkleLick(event.sprinkleName, event.body, event.targetScoop);
        }
      }
    },
    {
      addSprinkle: (name, title, element, zone, options) =>
        layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined, options),
      removeSprinkle: (name) => layout.removeSprinkle(name),
      minimizeSprinkle: (name) => layout.minimizeSprinkle(name),
      registerSprinkle: (name, title, opts) =>
        layout.registerSprinkle(
          name,
          title,
          opts?.icon,
          opts?.zone as 'primary' | 'drawer' | undefined
        ),
      unregisterSprinkle: (name) => layout.unregisterSprinkle(name),
      closeSprinkleContent: (name) => layout.closeSprinkleContent(name),
    },
    () => {
      const cone = client.getScoops().find((s) => s.isCone);
      if (cone) client.stopScoop(cone.jid);
    },
    {
      onAttachImage: (base64, name, mimeType) =>
        layout.panels.chat.addImageAttachment(base64, name, mimeType),
      inlineSprinkles,
      execHandler: createSprinkleExecHandler(client),
    }
  );
  (window as unknown as Record<string, unknown>).__slicc_sprinkleManager = sprinkleManager;
  setDipExecHandler(createSprinkleExecHandler(client));
  const stopSprinkleHandler = installSprinkleManagerHandlerOverChannel(sprinkleManager, {
    instanceId,
  });
  return { sprinkleManager, stopSprinkleHandler };
}
