/**
 * `setup-extension-finalize.ts` — tail of the extension boot path:
 * panel-side `.shtml` watcher install, legacy welcome marker migration,
 * nuke-reload listener, optional UI fixture, telemetry kick-off, and
 * background enrichment of pending-frozen sessions.
 *
 * Extracted verbatim from `mainExtension`.
 */

import type { VirtualFS } from '../../fs/index.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';
import type { ChatPanel } from '../chat-panel.js';
import type { Layout } from '../layout.js';
import { scheduleBackgroundEnrichment } from '../new-session.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { SprinkleManager } from '../sprinkle-manager.js';
import { initTelemetry } from '../telemetry.js';
import { isUIFixtureRequested, loadUIFixtureIntoChat } from './setup-ui-fixture.js';
import type { BootStageLogger } from './types.js';

export interface ExtensionFinalizeDeps {
  client: OffscreenClient;
  layout: Layout;
  chat: ChatPanel;
  sprinkleManager: SprinkleManager;
  localFs: VirtualFS;
  writableFs: WritableVfsClient;
  log: BootStageLogger;
}

export async function setupExtensionFinalize(deps: ExtensionFinalizeDeps): Promise<void> {
  const { client, layout, sprinkleManager, localFs, writableFs, log } = deps;
  // Auto-surface newly-added .shtml files in the rail. The panel's
  // `localFs` doesn't have the orchestrator's watcher (that lives in
  // offscreen), so attach a fresh one to catch panel-side writes
  // (e.g. skill drag-and-drop installs). Offscreen-side writes are
  // relayed separately from `offscreen.ts` via the sprinkle proxy.
  if (!localFs.getWatcher()) {
    const { FsWatcher } = await import('../../fs/index.js');
    localFs.setWatcher(new FsWatcher());
  }
  const panelWatcher = localFs.getWatcher();
  if (panelWatcher) sprinkleManager.setupWatcher(panelWatcher);

  // Migrate legacy localStorage flag to VFS marker.
  if (!(await localFs.exists('/shared/.welcomed')) && localStorage.getItem('slicc-welcomed')) {
    await localFs.writeFile('/shared/.welcomed', '1').catch(() => {});
    localStorage.removeItem('slicc-welcomed');
  }

  // Request state from offscreen — retries automatically until ready.
  client.requestState();
  log.info('Extension UI connected to offscreen agent engine');

  // Page-side handler for nuke-reload broadcasts. The offscreen shell
  // can't reload the side panel directly; nuke broadcasts a reload
  // request and the panel listens.
  const { installNukeReloadListener } = await import(
    '../../shell/supplemental-commands/nuke-command.js'
  );
  installNukeReloadListener();

  // `?ui-fixture=1` — same design-time override as the CLI path, but run
  // last so the normal extension boot has populated the sidebar before
  // we overwrite the chat view.
  if (isUIFixtureRequested()) {
    await loadUIFixtureIntoChat(layout.panels.chat);
  }

  // Initialize operational telemetry (fire-and-forget).
  initTelemetry().catch(() => {});

  // Background enrichment of pending-frozen sessions. Each impatient
  // double-click on the new-session button leaves a `pendingEnrichment`
  // entry in `/sessions/index.json`; this pass re-runs the LLM calls
  // and rewrites the archive title + appends the extracted memories
  // to `/workspace/CLAUDE.md`. Deferred behind `requestIdleCallback`
  // so a slow enrichment never blocks first paint. Routes through
  // `writableFs` so under `slicc_opfs_vfs=opfs` the rename + index
  // update lands on the worker-owned OPFS via the `WritableVfsClient`.
  // Flag off: `writableFs === localFs` (byte-identical baseline).
  scheduleBackgroundEnrichment(writableFs);
}
