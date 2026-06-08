/**
 * `setup-vfs.ts` — boot stage that selects the page-side VFS handles
 * (`localFs`, `panelReadVfs`, `writableFs`) and the OPFS-leader vs
 * shadow branch.
 *
 * Extracted verbatim from `mainStandaloneWorker`
 * (~main.ts:1911–1997 for the pre-client phase and main.ts:2300–2317
 * for the post-client phase). Behavior is unchanged.
 *
 * Two-phase API:
 *
 *   - `setupVfs(deps)` runs BEFORE the kernel-worker client is up.
 *     Creates `localFs`, runs the OPFS cross-tab leader election,
 *     wires the file browser for the non-OPFS path, kicks off the
 *     page-side mount-table recovery, and installs the page-side
 *     `preview-vfs` BroadcastChannel responder. Returns a `VfsHandle`
 *     with `panelReadVfs` and `writableFs` initially pointing at
 *     `localFs`.
 *
 *   - `attachWorkerVfs(deps)` runs AFTER the kernel-worker client is
 *     constructed but BEFORE `await host.ready`. Under
 *     `slicc_opfs_vfs=opfs` it routes file-browser reads + the
 *     preview-vfs responder through the worker's `VfsRpcHost` and
 *     (leader-only) swaps `writableFs` to a `RemoteWritableVfsClient`.
 *     The preview-vfs responder closure reads through the handle, so
 *     this mutation rewires the live responder.
 */

import { resolveVfsBackendFromEnv, VirtualFS } from '../../fs/index.js';
import { recoverMounts } from '../../fs/mount-recovery.js';
import { getAllMountEntries } from '../../fs/mount-table-store.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';
import { installPreviewVfsResponder } from '../preview-vfs-responder.js';
import type { VfsHandle, VfsSetupDeps, VfsWorkerAttachDeps } from './types.js';

/**
 * Pre-client VFS setup. Returns the `VfsHandle` the rest of boot
 * threads forward. Safe to call once per `mainStandaloneWorker` run.
 */
export async function setupVfs(deps: VfsSetupDeps): Promise<VfsHandle> {
  const { layout, log } = deps;

  // With `slicc_opfs_vfs === 'opfs'`, the worker owns the canonical
  // OPFS-backed VFS and panel reads must route through the kernel
  // transport's `VfsRpcHost`. Defer the file-browser wiring until
  // after `client` is available; with the flag off, keep the
  // historical local-VFS path so the LFS shadow still drives the
  // file browser.
  const useRpcVfs = resolveVfsBackendFromEnv() === 'opfs';

  // Local VFS for the file browser + memory panel + preview-vfs fallback.
  // Same IndexedDB as the worker's VFS, so writes from the agent are
  // visible in the file browser without round-tripping the wire.
  //
  // Under `slicc_opfs_vfs === 'opfs'` force the page-side VFS to the
  // InMemory backend so it no longer races the worker for OPFS handles
  // (the worker is the canonical OPFS owner; the page keeps an
  // in-process shadow for legacy consumers like mount-recovery and
  // attachment writer). The page shadow no longer persists across
  // reloads.
  const localFs = await VirtualFS.create({
    dbName: 'slicc-fs',
    ...(useRpcVfs ? { backend: 'memory' as const } : {}),
  });
  if (!useRpcVfs) {
    layout.panels.fileBrowser.setFs(localFs);
  }

  // Under the OPFS flag, run the cross-tab `slicc-opfs-leader`
  // election BEFORE any code path that opens an OPFS handle.
  // `createSyncAccessHandle` is exclusive per file; racing two
  // kernel-workers on the same OPFS tree corrupts the store.
  // First-writer-wins — newer tabs become followers and surface a
  // non-blocking read-only banner. The election + banner +
  // `__slicc_opfs_leader` state surface gives downstream
  // worker-side gating (skipping OPFS open / cross-tab read routing)
  // a single hook.
  let opfsLeader: { isLeader: boolean; dispose: () => void } = {
    isLeader: true,
    dispose: () => {},
  };
  if (useRpcVfs) {
    const { electOpfsLeader } = await import('../opfs-leader-election.js');
    const { showOpfsReadOnlyBanner } = await import('../opfs-readonly-banner.js');
    const result = await electOpfsLeader({ logger: log });
    opfsLeader = { isLeader: result.isLeader, dispose: result.dispose };
    (globalThis as Record<string, unknown>).__slicc_opfs_leader = {
      isLeader: result.isLeader,
      self: result.self,
      leader: result.leader,
    };
    if (result.isLeader) {
      log.info('OPFS leader election: this tab is the writer', { tabId: result.self.tabId });
    } else {
      log.warn('OPFS leader election: another tab is the writer; entering read-only mode', {
        self: result.self.tabId,
        leader: result.leader?.tabId,
      });
      showOpfsReadOnlyBanner({ leaderTabId: result.leader?.tabId });
    }
  }

  // Recover the panel's view of mounts. The worker recovers its own
  // mounts inside `createKernelHost`; this is just the page-side
  // `localFs`'s mount table being repopulated on reload.
  void getAllMountEntries()
    .then(async (entries) => {
      if (entries.length === 0) return;
      const { needsRecovery } = await recoverMounts(entries, localFs, log);
      if (needsRecovery.length === 0) return;
      log.warn('Some mounts could not be recovered in the page VFS', {
        count: needsRecovery.length,
        paths: needsRecovery.map((r) => r.path),
      });
    })
    .catch((err) => log.warn('Failed to restore persisted mounts in page VFS', err));

  // Page-side preview-vfs fallback responder. The worker's responder is
  // the canonical one (lives inside `createKernelHost`); this fires only
  // when the worker hasn't booted yet or when the request resolves
  // against a panel-only mount.
  //
  // The reader is held on the handle so that when
  // `slicc_opfs_vfs === 'opfs'` `attachWorkerVfs()` rewires this
  // responder to the kernel worker's `VfsRpcHost` via the shared
  // transport by mutating `handle.panelReadVfs`. With the flag off,
  // `localFs` stays in place and the path is byte-identical to the
  // local-VFS baseline.
  const previewVfsCh = new BroadcastChannel('preview-vfs');
  const handle: VfsHandle = {
    localFs,
    useRpcVfs,
    opfsLeader,
    previewVfsCh,
    panelReadVfs: localFs as LocalVfsClient,
    writableFs: localFs as WritableVfsClient,
  };
  installPreviewVfsResponder({
    channel: previewVfsCh,
    getReader: () => handle.panelReadVfs,
    logger: log,
  });

  return handle;
}

/**
 * Post-client VFS attachment. Under `slicc_opfs_vfs=opfs` routes
 * file-browser reads + the preview-vfs responder through the worker's
 * `VfsRpcHost`; leader-only swap of `writableFs` to a
 * `RemoteWritableVfsClient`. No-op when the flag is off — the handle
 * already points at `localFs`.
 */
export async function attachWorkerVfs(deps: VfsWorkerAttachDeps): Promise<void> {
  const { handle, client, layout, log } = deps;
  if (!handle.useRpcVfs) return;

  const { createRemoteVfsClient } = await import('../../kernel/remote-vfs-client.js');
  const remoteVfs = createRemoteVfsClient({ transport: client.getTransport() });
  layout.panels.fileBrowser.setFs(remoteVfs);
  handle.panelReadVfs = remoteVfs;
  if (handle.opfsLeader.isLeader) {
    const { createRemoteWritableVfsClient } = await import('../../kernel/writable-vfs-client.js');
    handle.writableFs = createRemoteWritableVfsClient({ transport: client.getTransport() });
    log.info('File browser + preview-vfs + writable freezer wired to worker VFS RPC (leader)');
  } else {
    log.info(
      'File browser + preview-vfs wired to worker VFS RPC (follower; freezer uses LFS shadow)'
    );
  }
}
