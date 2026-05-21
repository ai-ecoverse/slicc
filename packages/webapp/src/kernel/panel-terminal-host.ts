/**
 * `createPanelTerminalHost` — single source of truth for the
 * panel-driven `TerminalSessionHost` wiring.
 *
 * Both the standalone DedicatedWorker (`kernel-worker.ts`) and the
 * extension offscreen document (`chrome-extension/src/offscreen.ts`)
 * stand up a `TerminalSessionHost` so the panel's
 * `RemoteTerminalView` can drive shell sessions in the kernel-side
 * realm. Without a shared factory, the two floats can drift —
 * e.g. one wires `processManager` and the other doesn't, breaking
 * `ps` / `kill` / `/proc` parity.
 *
 * The factory pins both `TerminalSessionHost.processManager` and the
 * per-session `WasmShellHeadless` PM ref to the same instance, so
 * panel-typed commands and the agent's bash tool calls always hit
 * the same process table.
 */

import { TerminalSessionHost } from './terminal-session-host.js';
import type { TerminalSessionHostOptions } from './terminal-session-host.js';
import { WasmShellHeadless } from '../shell/wasm-shell-headless.js';
import type { MediaPreviewItem } from '../shell/supplemental-commands/imgcat-command.js';
import type { TerminalMediaPreviewMsg, TerminalSessionId } from '../shell/terminal-protocol.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import type { ProcessManager } from './process-manager.js';
import type {
  ExtensionMessage,
  OffscreenToPanelMessage,
} from '../../../chrome-extension/src/messages.js';
import type { KernelTransport } from './types.js';

export interface PanelTerminalHostOptions {
  /** Same kernel transport the bridge uses. */
  transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>;
  /** The kernel host's shared VFS. */
  fs: VirtualFS;
  /** The kernel host's BrowserAPI for `playwright-cli` / `serve` / `open`. */
  browser: BrowserAPI;
  /** The kernel host's ProcessManager — pinned into BOTH the host AND the shell. */
  processManager: ProcessManager;
  /** Optional logger override. Defaults to `console`. */
  logger?: TerminalSessionHostOptions['logger'];
}

export interface PanelTerminalHostHandle {
  host: TerminalSessionHost;
  /** Stop the host. Idempotent. */
  stop: () => void;
}

class PanelTerminalShell extends WasmShellHeadless {
  constructor(
    private readonly sid: TerminalSessionId,
    private readonly transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>,
    shellOptions: ConstructorParameters<typeof WasmShellHeadless>[0]
  ) {
    super(shellOptions);
  }

  protected override async renderMediaPreview(items: MediaPreviewItem[]): Promise<void> {
    for (const item of items) {
      let binary = '';
      const bytes = item.bytes;
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      this.transport.send({
        type: 'terminal-media-preview',
        sid: this.sid,
        path: item.path,
        mediaType: item.mimeType,
        data: btoa(binary),
      } satisfies TerminalMediaPreviewMsg as unknown as OffscreenToPanelMessage);
    }
  }
}

export function createPanelTerminalHost(
  options: PanelTerminalHostOptions
): PanelTerminalHostHandle {
  const { transport, fs, browser, processManager } = options;
  const logger = options.logger ?? console;
  const host = new TerminalSessionHost({
    transport,
    processManager,
    createShell: (sid, opts) =>
      new PanelTerminalShell(sid, transport, {
        fs,
        cwd: opts.cwd,
        env: opts.env,
        browserAPI: browser,
        processManager,
        processOwner: { kind: 'system' },
      }),
    logger,
  });
  const stop = host.start();
  return { host, stop };
}
