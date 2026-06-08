/**
 * `setup-extension-writable-vfs.ts` — under `slicc_opfs_vfs=opfs`,
 * routes the file-browser reads AND the preview-vfs BroadcastChannel
 * responder through the offscreen's `VfsRpcHost` instead of touching
 * OPFS from the panel. Also constructs a `RemoteWritableVfsClient` for
 * panel-side writers (session freezer, pending-enrichment).
 *
 * The extension is a singleton writer (one offscreen document), so we
 * do not gate on an OPFS leader election here — the panel is always the
 * canonical writer relative to the offscreen.
 *
 * Extracted verbatim from `mainExtension`.
 */

import type { VirtualFS } from '../../fs/index.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';
import type { Layout } from '../layout.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { BootStageLogger } from './types.js';

export interface ExtensionWritableVfsSetupDeps {
  client: OffscreenClient;
  layout: Layout;
  localFs: VirtualFS;
  useRpcVfs: boolean;
  log: BootStageLogger;
}

export interface ExtensionWritableVfsHandle {
  writableFs: WritableVfsClient;
  /** When `useRpcVfs`, the remote VFS reader used by the preview SW;
   *  otherwise `null` (caller keeps the local-VFS responder it wired
   *  earlier). */
  previewVfsReader: LocalVfsClient | null;
}

export async function setupExtensionWritableVfs(
  deps: ExtensionWritableVfsSetupDeps
): Promise<ExtensionWritableVfsHandle> {
  const { client, layout, localFs, useRpcVfs, log } = deps;
  if (!useRpcVfs) {
    return { writableFs: localFs, previewVfsReader: null };
  }
  const { createRemoteVfsClient } = await import('../../kernel/remote-vfs-client.js');
  const { createRemoteWritableVfsClient } = await import('../../kernel/writable-vfs-client.js');
  const remoteVfs = createRemoteVfsClient({ transport: client.getTransport() });
  const remoteWritableVfs = createRemoteWritableVfsClient({ transport: client.getTransport() });
  layout.panels.fileBrowser.setFs(remoteVfs);
  log.info('File browser + preview-vfs wired to worker VFS RPC');
  return { writableFs: remoteWritableVfs, previewVfsReader: remoteVfs };
}
