/**
 * `setup-standalone-finalize.ts` — tail of the standalone-worker boot:
 * mounts the panel terminal as a `RemoteTerminalView` backed by the
 * worker's `TerminalSessionHost`, installs the nuke-reload listener,
 * wires the page-side `beforeunload` cleanup that disposes every
 * runtime resource the boot owns, runs the optional UI fixture, kicks
 * off telemetry, and schedules background enrichment of pending-frozen
 * sessions.
 *
 * Extracted verbatim from `mainStandaloneWorker` (~main.ts:1414–1474).
 * The tail ordering is load-bearing: the remote-terminal mount must
 * run AFTER `host.ready` (the worker's `TerminalSessionHost` is
 * instantiated at the tail of `boot()`), and the background-enrichment
 * call uses `writableFs` so the OPFS leader lands the rename + index
 * update on the worker-owned canonical OPFS.
 */

import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';
import type { Layout } from '../layout.js';
import { scheduleBackgroundEnrichment } from '../new-session.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { initTelemetry } from '../telemetry.js';
import { isUIFixtureRequested, loadUIFixtureIntoChat } from './setup-ui-fixture.js';
import type { BootStageLogger } from './types.js';

export interface StandaloneFinalizeDeps {
  client: OffscreenClient;
  layout: Layout;
  writableFs: WritableVfsClient;
  /** True iff `slicc_opfs_vfs === 'opfs'`. */
  useRpcVfs: boolean;
  /** OPFS cross-tab leader election result. */
  opfsLeader: { isLeader: boolean };
  /** Stop hook for the page→worker localStorage interceptor. */
  stopStorageSync(): void;
  /** Stop hook for the sprinkle channel handler. */
  stopSprinkleHandler(): void;
  /** Releases the kernel-host (worker termination + bridge teardown). */
  hostDispose(): void;
  /** Page-level `window`. */
  window: Window;
  log: BootStageLogger;
}

export async function setupStandaloneFinalize(deps: StandaloneFinalizeDeps): Promise<void> {
  const {
    client,
    layout,
    writableFs,
    useRpcVfs,
    opfsLeader,
    stopStorageSync,
    stopSprinkleHandler,
    hostDispose,
    window: win,
    log,
  } = deps;

  const { RemoteTerminalView } = await import('../../kernel/remote-terminal-view.js');
  const { fetchSecretEnvVars: fetchSecretEnvVarsForPanel } = await import(
    '../../core/secret-env.js'
  );
  const panelSecretEnv = await fetchSecretEnvVarsForPanel();
  const remoteTerminal = new RemoteTerminalView({
    client,
    cwd: '/',
    env: Object.keys(panelSecretEnv).length > 0 ? panelSecretEnv : undefined,
  });
  void layout.panels.terminal.mountRemoteShell(remoteTerminal).catch((err) => {
    log.error('Failed to mount remote terminal view', err);
  });

  const { installNukeReloadListener } = await import(
    '../../shell/supplemental-commands/nuke-command.js'
  );
  const stopNukeListener = installNukeReloadListener();

  win.addEventListener(
    'beforeunload',
    () => {
      stopStorageSync();
      stopSprinkleHandler();
      stopNukeListener();
      remoteTerminal.dispose();
      hostDispose();
    },
    { once: true }
  );

  if (isUIFixtureRequested()) {
    await loadUIFixtureIntoChat(layout.panels.chat);
  }
  initTelemetry().catch(() => {});

  scheduleBackgroundEnrichment(writableFs, { isWriter: !useRpcVfs || opfsLeader.isLeader });

  log.info('Standalone kernel-worker UI ready');
}
