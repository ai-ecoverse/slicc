import type { Command, SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import type { ProcessManager } from '../../kernel/process-manager.js';
import type { JshProcessConfig } from '../jsh-executor.js';
import type { ScriptCatalog } from '../script-catalog.js';
import { createAfplayCommand, createChimeCommand } from './afplay-command.js';
import { createAgentCommand } from './agent-command.js';
import { createBashBuiltinCommands } from './bash-builtins-command.js';
import { createBiomeCommand } from './biome-command.js';
import { createBiscottoCommand } from './biscotto-command.js';
import type { CherryRuntimeRegistry } from './cherry-emit-command.js';
import { createCherryEmitCommand } from './cherry-emit-command.js';
import {
  createClipboardAutoCommand,
  createPbcopyCommand,
  createPbpasteCommand,
} from './clipboard-commands.js';
import { createCmpCommand } from './cmp-command.js';
import { createComputerCommand } from './computer-command.js';
import { createConvertCommand } from './convert-command.js';
import { createCostCommand } from './cost-command.js';
import { type CrontaskCommandOptions, createCrontaskCommand } from './crontask-command.js';
import { createCurlwrightCommand } from './curlwright-command.js';
import { createDfCommand, createDiskutilCommand } from './df-command.js';
import { createDiCommand } from './di-command.js';
import { createDigCommand } from './dig-command.js';
import { createDiscoverCommand } from './discover-command.js';
import { createEsbuildCommand } from './esbuild-command.js';
import { createEsptoolCommand } from './esptool-command.js';
import { createFfmpegCommand } from './ffmpeg-command.js';
import { createFfprobeCommand } from './ffprobe-command.js';
import { createFsWatchCommand } from './fswatch-command.js';
import { createGelatiereCommand } from './gelatiere-command.js';
import { createHearCommand } from './hear-command.js';
import { createCommandsCommand } from './help-command.js';
import { createHfCommand } from './hf-command.js';
import { createHidCommand } from './hid-command.js';
import { createHostCommand } from './host-command.js';
import { createIdCommand, createWhoamiCommand } from './id-command.js';
import type { ImgcatCommandOptions } from './imgcat-command.js';
import { createImgcatCommand } from './imgcat-command.js';
import { createIpkCommand } from './ipk-command.js';
import { createIpxCommand } from './ipx-command.js';
import { createJshdCommand } from './jshd-command.js';
import { createKillCommand } from './kill-command.js';
import { createLayoutCommand } from './layout-command.js';
import { createLocalLlmCommand } from './local-llm-command.js';
import { createManCommand } from './man-command.js';
import { createMcpCommand } from './mcp-command.js';
import { createMeminfoCommand } from './meminfo-command.js';
import { createMemoryCommand } from './memory-command.js';
import { createMktempCommand } from './mktemp-command.js';
import { createModelsCommand } from './models-command.js';
import { createNodeCommand } from './node-command.js';
import { createNukeCommand } from './nuke-command.js';
import { createOAuthDomainCommand } from './oauth-domain-command.js';
import { createOAuthTokenCommand } from './oauth-token-command.js';
import { createOpenCommand } from './open-command.js';
import { createPatchCommand } from './patch-command.js';
import { createPdftkCommand } from './pdftk-command.js';
import { createPdftoppmCommand } from './pdftoppm-command.js';
import { createPdftotextCommand } from './pdftotext-command.js';
import { wireTeleportSelectionFromShim } from './playwright/teleport-follower-shim.js';
import { createPlaywrightCommand, PLAYWRIGHT_COMMAND_NAMES } from './playwright-command.js';
import { createPluginCommand } from './plugin-command.js';
import { createPsCommand } from './ps-command.js';
import { createPython3LikeCommand } from './python-command.js';
import { createRgCommand } from './rg-command.js';
import { createRsyncCommand } from './rsync-command.js';
import { createSayCommand } from './say-command.js';
import { createScreencaptureCommand } from './screencapture-command.js';
import { createSecretCommand, type SecretCommandDeps } from './secret-command.js';
import { createSerialCommand } from './serial-command.js';
import { createServeCommand } from './serve-command.js';
import { createSessionCommand } from './session-command.js';
import { createSliccCommand } from './slicc-command.js';
import { createSliccFsCleanupCommand } from './slicc-fs-cleanup-command.js';
import { createSprinkleCommand } from './sprinkle-command.js';
import { createSqliteCommand } from './sqlite-command.js';
import { createSshCommand } from './ssh-command.js';
import { createSudoCommand, type SudoCommandOptions } from './sudo-command.js';
import {
  createRmCommand,
  createRmdirCommand,
  createStatCommand,
} from './symlink-aware-file-commands.js';
import { createTarCommand } from './tar-command.js';
import { createTestCommand } from './test-command.js';
import { createThemeCommand } from './theme-command.js';
import { createTscCommand } from './tsc-command.js';
import { createUnameCommand } from './uname-command.js';
import { createUnlinkCommand } from './unlink-command.js';
import { createUnzipCommand } from './unzip-command.js';
import { createUpgradeCommand } from './upgrade-command.js';
import { createUptimeCommand } from './uptime-command.js';
import { createUsbCommand } from './usb-command.js';
import { createV86Command } from './v86-command.js';
import { createWebhookCommand, type WebhookCommandOptions } from './webhook-command.js';
import { createWebsocatCommand } from './websocat-command.js';
import { createWfProgressCommand } from './wf-progress-command.js';
import { createWhichCommand } from './which-command.js';
import { createWorkflowCommand } from './workflow-command.js';
import { createXxdCommand } from './xxd-command.js';
import { createZipCommand } from './zip-command.js';

export type {
  ImgcatCommandOptions as SupplementalCommandOptions,
  MediaPreviewItem,
} from './imgcat-command.js';

type BrowserAPI = NonNullable<Parameters<typeof createServeCommand>[0]>;

export interface SupplementalCommandsConfig extends ImgcatCommandOptions {
  getJshCommands?: () => Promise<string[]>;

  getWorkflowCommands?: () => Promise<string[]>;

  syncScriptCommands?: () => void | Promise<void>;

  getStaticBuiltins?: () => string[];

  getScriptRegisteredNames?: () => string[];

  fs?: VirtualFS;

  fetch?: SecureFetch;

  scriptCatalog?: ScriptCatalog;

  browserAPI?: BrowserAPI;

  getParentJid?: () => string | undefined;

  isScoop?: () => boolean;

  processManager?: ProcessManager;

  cherryRuntimeRegistry?: CherryRuntimeRegistry;

  sudoCommand?: SudoCommandOptions;

  setEnv?: (name: string, value: string) => void;

  unsetEnv?: (name: string) => void;

  webhook?: WebhookCommandOptions;

  crontask?: CrontaskCommandOptions;

  buildProcessConfig?: (runEnv?: ReadonlyMap<string, string>) => JshProcessConfig | undefined;
}

function secretCommandDeps(options: SupplementalCommandsConfig): SecretCommandDeps {
  return {
    setEnv: options.setEnv,
    unsetEnv: options.unsetEnv,
    broker: options.sudoCommand?.broker,
  };
}

function packageManagerCommands(options: SupplementalCommandsConfig): Command[] {
  const { fs, fetch } = options;
  if (!fs || !fetch) return [];
  const ipkDeps = {
    fs,
    fetch,
    scriptCatalog: options.scriptCatalog,
    syncScriptCommands: options.syncScriptCommands,
  };
  return [
    createIpkCommand('ipk', ipkDeps),
    createIpkCommand('npm', ipkDeps),
    createIpkCommand('i', ipkDeps),
    createIpxCommand('ipx', { fs, fetch }),
    createIpxCommand('npx', { fs, fetch }),
    createDiCommand('di', { fs, fetch }),
    createDiCommand('uv', { fs, fetch }),
    createUpgradeCommand({ fs, fetch }),
  ];
}

export function createSupplementalCommands(options: SupplementalCommandsConfig = {}): Command[] {
  const commands: Command[] = [
    createCommandsCommand({
      getJshCommands: options.getJshCommands,
      getWorkflowCommands: options.getWorkflowCommands,
    }),
    createHostCommand(),
    createSshCommand(),
    createSliccCommand(),
    createServeCommand(options.browserAPI, options.fs),
    createOpenCommand(options.browserAPI),
    createCurlwrightCommand(options.browserAPI),
    createImgcatCommand(options),
    createZipCommand(),
    createUnzipCommand(),
    createTarCommand(),
    createRmCommand(),
    createRmdirCommand(),
    createStatCommand(),
    createCmpCommand(),
    createXxdCommand(),
    createSqliteCommand('sqlite3'),
    createSqliteCommand('sqllite'),
    createTscCommand(),
    createTestCommand(),
    createEsbuildCommand(),
    createBiomeCommand(),
    createNodeCommand({ buildProcessConfig: options.buildProcessConfig }),
    createNodeCommand({ buildProcessConfig: options.buildProcessConfig }, 'jsh'),
    createPython3LikeCommand('python3', { buildProcessConfig: options.buildProcessConfig }),
    createPython3LikeCommand('python', { buildProcessConfig: options.buildProcessConfig }),
    ...packageManagerCommands(options),
    ...(options.fs ? [createGelatiereCommand({ fs: options.fs })] : []),
    ...(options.fs ? [createMemoryCommand({ fs: options.fs })] : []),
    ...(options.fetch ? [createHfCommand({ fetch: options.fetch })] : []),
    createFfmpegCommand(),
    createFfprobeCommand(),
    createWebhookCommand(options.webhook),
    createWebsocatCommand(),
    createCrontaskCommand(options.crontask),
    createMcpCommand({ fs: options.fs, scriptCatalog: options.scriptCatalog }),
    createPluginCommand({ fs: options.fs, fetch: options.fetch }),
    createFsWatchCommand(),
    createSprinkleCommand(),
    createPatchCommand(),
    createPdftkCommand('pdftk'),
    createPdftkCommand('pdf'),

    createBiscottoCommand('biscotto'),
    createBiscottoCommand('biscotti'),
    createPdftoppmCommand('pdftoppm'),

    createPdftoppmCommand('pdftocairo'),
    createPdftotextCommand('pdftotext'),
    createConvertCommand('convert'),
    createConvertCommand('magick'),
    createWhichCommand({
      fs: options.fs,
      scriptCatalog: options.scriptCatalog,
      getStaticBuiltins: options.getStaticBuiltins,
      getScriptRegisteredNames: options.getScriptRegisteredNames,
    }),
    createThemeCommand(),
    createUnameCommand(),
    createIdCommand(),

    createWhoamiCommand(),
    createUnlinkCommand(),
    createMktempCommand(),

    createRgCommand(),
    createManCommand(),
    createDigCommand(),
    createOAuthTokenCommand(),
    createOAuthDomainCommand(),
    createLocalLlmCommand(),

    createSecretCommand(secretCommandDeps(options)),
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
    createUptimeCommand({ processManager: options.processManager }),
    createKillCommand({ processManager: options.processManager }),
    createJshdCommand({
      processManager: options.processManager,
      scriptCatalog: options.scriptCatalog,
    }),

    ...createBashBuiltinCommands(),
    createMeminfoCommand(),
    createLayoutCommand(),
    createUsbCommand(),
    createHidCommand(),
    createSerialCommand(),
    createV86Command({ processManager: options.processManager }),
    createComputerCommand({
      processManager: options.processManager,
      browser: options.browserAPI,
      sudoBroker: options.sudoCommand?.broker,
    }),
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
    createSessionCommand(),
  ];

  if (options.fs) {
    wireTeleportSelectionFromShim();
    commands.push(
      ...PLAYWRIGHT_COMMAND_NAMES.map((name) =>
        createPlaywrightCommand(name, options.browserAPI, options.fs!, {
          isScoop: options.isScoop,
        })
      )
    );
  }

  return commands;
}
