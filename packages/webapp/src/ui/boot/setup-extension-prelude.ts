/**
 * `setup-extension-prelude.ts` — early-boot VFS + supporting wiring
 * shared between the side panel and the detached popout. Combines:
 *   - panel-VFS construction (OPFS guard + memory backend under OPFS)
 *   - mount-table recovery against the panel-side VFS
 *   - preview-vfs `BroadcastChannel` responder
 *   - skill-drop install (with toast)
 *   - panel terminal session-costs provider (offscreen IPC)
 *
 * Extracted from `mainExtension` so the orchestrator function stays
 * under the per-function cap. Behavior is byte-identical to the inline
 * blocks it replaces.
 */

import type { VirtualFS } from '../../fs/index.js';
import { recoverMounts } from '../../fs/mount-recovery.js';
import { getAllMountEntries } from '../../fs/mount-table-store.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import type { Layout } from '../layout.js';
import { installPreviewVfsResponder } from '../preview-vfs-responder.js';
import { createSkillDropToast, setupSkillDrop } from './setup-skill-drop.js';
import type { BootStageLogger } from './types.js';

export interface ExtensionPreludeSetupDeps {
  layout: Layout;
  log: BootStageLogger;
}

export interface ExtensionPreludeHandle {
  localFs: VirtualFS;
  useRpcVfs: boolean;
  /** Mutable reader pointer used by the preview-vfs `BroadcastChannel`
   *  responder; the caller may rewrite it after the kernel client is up. */
  previewVfsReader: { current: LocalVfsClient };
}

export async function setupExtensionPrelude(
  deps: ExtensionPreludeSetupDeps
): Promise<ExtensionPreludeHandle> {
  const { layout, log } = deps;
  const { VirtualFS, resolveVfsBackendFromEnv } = await import('../../fs/index.js');
  const { warnIfPanelVfsConstructionUnderOpfs } = await import('../panel-vfs-guard.js');

  // The offscreen document is the sole VFS constructor under
  // `slicc_opfs_vfs === 'opfs'`. Emit a startup warning before the
  // panel runs its own `VirtualFS.create` so the convention violation
  // surfaces in dev/QA — no runtime block, since the LFS-shadow +
  // mount-table-recovery paths still rely on the panel-side instance
  // with the flag off.
  const panelBackend = resolveVfsBackendFromEnv();
  warnIfPanelVfsConstructionUnderOpfs(panelBackend, log);
  const useRpcVfs = panelBackend === 'opfs';

  // Under `slicc_opfs_vfs === 'opfs'` force the page-side VFS to the
  // InMemory backend so it no longer races the worker for OPFS handles.
  // The worker is the canonical OPFS owner; the page keeps an in-process
  // shadow only for legacy consumers (mount-recovery, attachment writer,
  // memory-panel reads). The page shadow no longer persists across reloads.
  const localFs = await VirtualFS.create({
    dbName: 'slicc-fs',
    ...(useRpcVfs ? { backend: 'memory' as const } : {}),
  });
  if (!useRpcVfs) {
    layout.panels.fileBrowser.setFs(localFs);
    log.info('File browser wired to shared VFS (local IndexedDB)');
  }

  // Restore persisted mounts on the panel-side VFS — the side panel
  // and the offscreen each have their own VirtualFS instance and must
  // rebuild their own in-memory mount table on boot.
  void getAllMountEntries()
    .then(async (entries) => {
      if (entries.length === 0) return;
      const { needsRecovery } = await recoverMounts(entries, localFs, log);
      if (needsRecovery.length === 0) return;
      log.warn('Some mounts could not be recovered in the panel VFS', {
        count: needsRecovery.length,
        paths: needsRecovery.map((r) => r.path),
      });
    })
    .catch((err) => log.warn('Failed to restore persisted mounts in panel VFS', err));

  // Preview SW file-read responder. The reader pointer is held in a
  // box so the caller can rewire it to the worker VFS once the kernel
  // client is up.
  const previewVfsReader: { current: LocalVfsClient } = { current: localFs };
  installPreviewVfsResponder({
    channel: new BroadcastChannel('preview-vfs'),
    getReader: () => previewVfsReader.current,
    logger: log,
  });

  // Skill drag-and-drop install + chat-attachment forwarding.
  setupSkillDrop({
    fs: localFs,
    onNotice: createSkillDropToast(),
    onInstalled: async () => {
      await layout.panels.fileBrowser.refresh();
    },
    onAttachFiles: (files) => layout.panels.chat.addAttachmentsFromFiles(files),
  });

  // Register session costs provider for the panel's terminal shell.
  // The offscreen document owns the orchestrator, so we request cost
  // data via chrome.runtime.
  const { registerSessionCostsProvider } = await import(
    '../../shell/supplemental-commands/cost-command.js'
  );
  registerSessionCostsProvider(
    () =>
      new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { source: 'panel' as const, payload: { type: 'get-session-costs' } },
          (response: unknown) => {
            if (chrome.runtime.lastError || !(response as { ok?: boolean })?.ok) {
              resolve([]);
              return;
            }
            resolve(((response as { costs?: unknown[] }).costs as []) ?? []);
          }
        );
      })
  );

  return { localFs, useRpcVfs, previewVfsReader };
}
