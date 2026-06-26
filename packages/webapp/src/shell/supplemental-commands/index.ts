import type { Command, SecureFetch } from 'just-bash';
import type { BrowserAPI } from '../../cdp/index.js';
import type { VirtualFS } from '../../fs/index.js';
import type { ProcessManager } from '../../kernel/process-manager.js';
import type { JshProcessConfig } from '../jsh-executor.js';
import type { ScriptCatalog } from '../script-catalog.js';
import { createAfplayCommand, createChimeCommand } from './afplay-command.js';
import { createAgentCommand } from './agent-command.js';
import { createBiomeCommand } from './biome-command.js';
import type { CherryRuntimeRegistry } from './cherry-emit-command.js';
import { createCherryEmitCommand } from './cherry-emit-command.js';
import {
  createClipboardAutoCommand,
  createPbcopyCommand,
  createPbpasteCommand,
} from './clipboard-commands.js';
import { createConvertCommand } from './convert-command.js';
import { createCostCommand } from './cost-command.js';
import { createCrontaskCommand } from './crontask-command.js';
import { createDfCommand, createDiskutilCommand } from './df-command.js';
import { createDiCommand } from './di-command.js';
import { createDigCommand } from './dig-command.js';
import { createDiscoverCommand } from './discover-command.js';
import { createEsbuildCommand } from './esbuild-command.js';
import { createEsptoolCommand } from './esptool-command.js';
import { createFfmpegCommand } from './ffmpeg-command.js';
import { createFsWatchCommand } from './fswatch-command.js';
import { createHearCommand } from './hear-command.js';
import { createCommandsCommand } from './help-command.js';
import { createHfCommand } from './hf-command.js';
import { createHidCommand } from './hid-command.js';
import { createHostCommand } from './host-command.js';
import type { ImgcatCommandOptions } from './imgcat-command.js';
import { createImgcatCommand } from './imgcat-command.js';
import { createIpkCommand } from './ipk-command.js';
import { createIpxCommand } from './ipx-command.js';
import { createKillCommand } from './kill-command.js';
import { createLocalLlmCommand } from './local-llm-command.js';
import { createManCommand } from './man-command.js';
import { createMcpCommand } from './mcp-command.js';
import { createModelsCommand } from './models-command.js';
import { createNodeCommand } from './node-command.js';
import { createNukeCommand } from './nuke-command.js';
import { createOAuthDomainCommand } from './oauth-domain-command.js';
import { createOAuthTokenCommand } from './oauth-token-command.js';
import { createOpenCommand } from './open-command.js';
import { createPdftkCommand } from './pdftk-command.js';
import { createPlaywrightCommand, PLAYWRIGHT_COMMAND_NAMES } from './playwright-command.js';
import { createPsCommand } from './ps-command.js';
import { createPython3LikeCommand } from './python-command.js';
import { createRsyncCommand } from './rsync-command.js';
import { createSayCommand } from './say-command.js';
import { createScreencaptureCommand } from './screencapture-command.js';
import { createSecretCommand } from './secret-command.js';
import { createSerialCommand } from './serial-command.js';
import { createServeCommand } from './serve-command.js';
import { createSliccFsCleanupCommand } from './slicc-fs-cleanup-command.js';
import { createSprinkleCommand } from './sprinkle-command.js';
import { createSqliteCommand } from './sqlite-command.js';
import { createSudoCommand, type SudoCommandOptions } from './sudo-command.js';
import { createTestCommand } from './test-command.js';
import { createThemeCommand } from './theme-command.js';
import { createTscCommand } from './tsc-command.js';
import { createUnameCommand } from './uname-command.js';
import { createUnzipCommand } from './unzip-command.js';
import { createUsbCommand } from './usb-command.js';
import { createWebhookCommand } from './webhook-command.js';
import { createWebsocatCommand } from './websocat-command.js';
import { createWfProgressCommand } from './wf-progress-command.js';
import { createWhichCommand } from './which-command.js';
import { createWorkflowCommand } from './workflow-command.js';
import { createZipCommand } from './zip-command.js';

export type {
  ImgcatCommandOptions as SupplementalCommandOptions,
  MediaPreviewItem,
} from './imgcat-command.js';

export interface SupplementalCommandsConfig extends ImgcatCommandOptions {
  /** Function that returns discovered .jsh command names (for `commands` listing). */
  getJshCommands?: () => Promise<string[]>;
  /** Discovered workflow command names (for `commands`/`which`). */
  getWorkflowCommands?: () => Promise<string[]>;
  /** Re-run script-command registration (jsh + workflows) after a `workflow save`. */
  syncScriptCommands?: () => void | Promise<void>;
  /** Built-in command names (excludes dynamically-registered .jsh/workflow names). */
  getStaticBuiltins?: () => string[];
  /** VirtualFS instance for .jsh discovery, `which`, and playwright-cli session files. */
  fs?: VirtualFS;
  /**
   * Proxied/secure fetch used by network-bound commands (currently `ipk`/`npm`).
   * `AlmostBashShellHeadless` injects `createProxiedFetch()`; when omitted, the
   * registry-backed `ipk` commands are not registered.
   */
  fetch?: SecureFetch;
  /** Shared script discovery service for `.jsh`/`.bsh` lookup. */
  scriptCatalog?: ScriptCatalog;
  /** Browser automation backend for playwright-cli aliases. Optional so aliases stay discoverable even without browser support. */
  browserAPI?: BrowserAPI;
  /**
   * Returns the JID of the scoop whose shell is about to run a command,
   * when that shell lives inside a scoop context. Used by the `agent`
   * command to forward the parent's jid to the AgentBridge for model
   * inheritance. Returns `undefined` when the shell has no scoop owner
   * (the terminal panel's standalone AlmostBashShell).
   */
  getParentJid?: () => string | undefined;
  /**
   * Process manager threaded into `ps` / `kill`. When omitted,
   * those commands fall back to `globalThis.__slicc_pm`
   * (published by `createKernelHost`). Tests prefer DI; production
   * works with either.
   */
  processManager?: ProcessManager;
  /** Leader-side cherry runtime registry. Absent outside leader contexts. */
  cherryRuntimeRegistry?: CherryRuntimeRegistry;
  /**
   * Hooks for the explicit `sudo <cmd...>` command. Includes the broker, the
   * persist-grant sink, and the one-shot bypass that lets `sudo` run the
   * inner command without re-firing the transparent `Cmnd` gate. Absent in
   * environments without sudo support — `sudo` then prints a clean
   * "not configured" message.
   */
  sudoCommand?: SudoCommandOptions;
  /**
   * Optional hook that writes a `name=value` pair into the owning shell's live
   * env. Threaded into `createSecretCommand` so a successful `secret set`
   * injects the masked value into `$NAME` for the next command in the same
   * shell session (LLM-context parity with container-loaded secrets).
   */
  setEnv?: (name: string, value: string) => void;
  /**
   * Builds the process-tracking config (PM, owner, parent pid) for the
   * realm-backed `node` / `python` commands so their `kind:'jsh'`/`'py'`
   * realm child spawns parented to the active shell pid. Mirrors how `.jsh`
   * scripts resolve parentage via `AlmostBashShellHeadless.buildJshProcessConfig`.
   * Returns `undefined` on floats with no wired ProcessManager (the realm
   * then falls back to the global PM / an ephemeral PM, parented to pid 1).
   */
  buildProcessConfig?: () => JshProcessConfig | undefined;
}

export function createSupplementalCommands(options: SupplementalCommandsConfig = {}): Command[] {
  const commands: Command[] = [
    createCommandsCommand({
      getJshCommands: options.getJshCommands,
      getWorkflowCommands: options.getWorkflowCommands,
    }),
    createHostCommand(),
    createServeCommand(options.browserAPI, options.fs),
    createOpenCommand(),
    createImgcatCommand(options),
    createZipCommand(),
    createUnzipCommand(),
    createSqliteCommand('sqlite3'),
    createSqliteCommand('sqllite'),
    createTscCommand(),
    createTestCommand(),
    createEsbuildCommand(),
    createBiomeCommand(),
    createNodeCommand({ buildProcessConfig: options.buildProcessConfig }),
    createPython3LikeCommand('python3', { buildProcessConfig: options.buildProcessConfig }),
    createPython3LikeCommand('python', { buildProcessConfig: options.buildProcessConfig }),
    ...(options.fs && options.fetch
      ? [
          createIpkCommand('ipk', { fs: options.fs, fetch: options.fetch }),
          createIpkCommand('npm', { fs: options.fs, fetch: options.fetch }),
          createIpkCommand('i', { fs: options.fs, fetch: options.fetch }),
          createIpxCommand('ipx', { fs: options.fs, fetch: options.fetch }),
          createIpxCommand('npx', { fs: options.fs, fetch: options.fetch }),
          createDiCommand('di', { fs: options.fs, fetch: options.fetch }),
          createDiCommand('uv', { fs: options.fs, fetch: options.fetch }),
        ]
      : []),
    ...(options.fetch ? [createHfCommand({ fetch: options.fetch })] : []),
    createFfmpegCommand(),
    createWebhookCommand(),
    createWebsocatCommand(),
    createCrontaskCommand(),
    createMcpCommand({ fs: options.fs, scriptCatalog: options.scriptCatalog }),
    createFsWatchCommand(),
    createSprinkleCommand(),
    createPdftkCommand('pdftk'),
    createPdftkCommand('pdf'),
    createConvertCommand('convert'),
    createConvertCommand('magick'),
    createWhichCommand({
      fs: options.fs,
      scriptCatalog: options.scriptCatalog,
      getStaticBuiltins: options.getStaticBuiltins,
    }),
    createThemeCommand(),
    createUnameCommand(),
    createManCommand(),
    createDigCommand(),
    createOAuthTokenCommand(),
    createOAuthDomainCommand(),
    createLocalLlmCommand(),
    createSecretCommand({ setEnv: options.setEnv }),
    createRsyncCommand({ fs: options.fs }),
    createScreencaptureCommand(),
    createPbcopyCommand(),
    createPbpasteCommand(),
    createClipboardAutoCommand('xclip'),
    createClipboardAutoCommand('xsel'),
    createSayCommand(),
    createHearCommand(),
    createAfplayCommand(),
    createChimeCommand(),
    createModelsCommand(options.fs),
    createCostCommand(),
    createNukeCommand(),
    createAgentCommand({ getParentJid: options.getParentJid }),
    createDiscoverCommand(),
    createPsCommand({ processManager: options.processManager }),
    createKillCommand({ processManager: options.processManager }),
    createUsbCommand(),
    createHidCommand(),
    createSerialCommand(),
    createEsptoolCommand(),
    createCherryEmitCommand({ registry: options.cherryRuntimeRegistry }),
    createSliccFsCleanupCommand(),
    createDfCommand({ fs: options.fs }),
    createDiskutilCommand({ fs: options.fs }),
    createSudoCommand(options.sudoCommand),
    createWorkflowCommand({
      getParentJid: options.getParentJid,
      syncScriptCommands: options.syncScriptCommands,
    }),
    createWfProgressCommand(),
  ];

  if (options.fs) {
    commands.push(
      ...PLAYWRIGHT_COMMAND_NAMES.map((name) =>
        createPlaywrightCommand(name, options.browserAPI, options.fs!)
      )
    );
  }

  return commands;
}
