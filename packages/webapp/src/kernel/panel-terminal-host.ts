import type { BrowserAPI } from '../cdp/browser-api.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import { getLeaderStatusWithFallback } from '../scoops/tray-leader.js';
import {
  AlmostBashShellHeadless,
  type HeadlessShellOptions,
} from '../shell/almost-bash-shell-headless.js';
import type { MediaPreviewItem } from '../shell/supplemental-commands/imgcat-command.js';
import type { TerminalMediaPreviewMsg, TerminalSessionId } from '../shell/terminal-protocol.js';
import type { SudoManager } from '../sudo/sudo-manager.js';
import type { ExtensionMessage, OffscreenToPanelMessage } from './messages.js';
import type { ProcessManager } from './process-manager.js';
import type { TerminalSessionHostOptions } from './terminal-session-host.js';
import { TerminalSessionHost } from './terminal-session-host.js';
import type { KernelTransport } from './types.js';

export interface PanelTerminalHostOptions {
  transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>;

  fs: VirtualFS;

  browser: BrowserAPI;

  processManager: ProcessManager;

  sudoManager?: SudoManager | null;

  webhook?: HeadlessShellOptions['webhook'];

  crontask?: HeadlessShellOptions['crontask'];

  logger?: TerminalSessionHostOptions['logger'];
}

export interface PanelTerminalHostHandle {
  host: TerminalSessionHost;

  stop: () => void;
}

class PanelTerminalShell extends AlmostBashShellHeadless {
  constructor(
    private readonly sid: TerminalSessionId,
    private readonly transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>,
    shellOptions: ConstructorParameters<typeof AlmostBashShellHeadless>[0]
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
      const msg: TerminalMediaPreviewMsg = {
        type: 'terminal-media-preview',
        sid: this.sid,
        path: item.path,
        mediaType: item.mimeType,
        data: btoa(binary),
      };
      this.transport.send(msg as OffscreenToPanelMessage);
    }
  }
}

export const PANEL_TERMINAL_EXECUTION_LIMITS = {
  maxExecutionTimeMs: Number.POSITIVE_INFINITY,
  maxCommandCount: Number.POSITIVE_INFINITY,
  maxLoopIterations: Number.POSITIVE_INFINITY,
  maxParserTokens: Number.POSITIVE_INFINITY,
  maxParseIterations: Number.POSITIVE_INFINITY,
} as const;

export function createPanelTerminalHost(
  options: PanelTerminalHostOptions
): PanelTerminalHostHandle {
  const { transport, fs, browser, processManager, sudoManager } = options;
  const logger = options.logger ?? console;

  const shellSudo = sudoManager?.getShellConfig({ transparentGating: false });
  const host = new TerminalSessionHost({
    transport,
    processManager,
    createShell: (sid, opts) =>
      new PanelTerminalShell(sid, transport, {
        fs,
        cwd: opts.cwd,
        env: opts.env,
        browserAPI: browser,
        webhook: {
          hasLocalNodeServer: options.webhook?.hasLocalNodeServer ?? (() => false),
          getLeaderStatus: options.webhook?.getLeaderStatus ?? getLeaderStatusWithFallback,
        },
        crontask: options.crontask,
        processManager,
        processOwner: { kind: 'system' },
        sudo: shellSudo,
        executionLimits: PANEL_TERMINAL_EXECUTION_LIMITS,
      }),
    logger,
  });
  const stop = host.start();
  return { host, stop };
}
