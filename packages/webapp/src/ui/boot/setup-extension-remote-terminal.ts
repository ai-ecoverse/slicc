/**
 * `setup-extension-remote-terminal.ts` — mount the panel terminal as a
 * `RemoteTerminalView` backed by the offscreen `TerminalSessionHost`.
 * Keystrokes assemble locally; each committed line dispatches a
 * `terminal-exec` to the offscreen so panel-typed commands share the
 * same `ProcessManager` and `/proc` view as the agent's bash tool.
 *
 * Extracted verbatim from `mainExtension`. The mount is fire-and-forget
 * (the prior code wrapped it in an IIFE) so a slow offscreen reply
 * never blocks the rest of boot.
 */

import type { Layout } from '../layout.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { BootStageLogger } from './types.js';

export interface ExtensionRemoteTerminalSetupDeps {
  client: OffscreenClient;
  layout: Layout;
  log: BootStageLogger;
}

export function setupExtensionRemoteTerminal(deps: ExtensionRemoteTerminalSetupDeps): void {
  const { client, layout, log } = deps;
  void (async () => {
    try {
      const { RemoteTerminalView } = await import('../../kernel/remote-terminal-view.js');
      const { fetchSecretEnvVars } = await import('../../core/secret-env.js');
      const secretEnv = await fetchSecretEnvVars();
      const remoteTerminal = new RemoteTerminalView({
        client,
        cwd: '/',
        env: Object.keys(secretEnv).length > 0 ? secretEnv : undefined,
      });
      await layout.panels.terminal.mountRemoteShell(remoteTerminal);
      window.addEventListener('beforeunload', () => remoteTerminal.dispose(), { once: true });
      log.info('Panel terminal mounted as RemoteTerminalView (offscreen TerminalSessionHost)');
    } catch (err) {
      log.warn('Failed to mount remote terminal view', err);
    }
  })();
}
