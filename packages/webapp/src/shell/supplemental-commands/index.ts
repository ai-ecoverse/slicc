import type { Command } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { createCommandsCommand } from './help-command.js';
import { createConvertCommand } from './convert-command.js';
import { createHostCommand } from './host-command.js';
import { createImgcatCommand } from './imgcat-command.js';
import type { ImgcatCommandOptions } from './imgcat-command.js';
import { createNodeCommand } from './node-command.js';
import { createOpenCommand } from './open-command.js';
import { createPdftkCommand } from './pdftk-command.js';
import { createPlaywrightCommand, PLAYWRIGHT_COMMAND_NAMES } from './playwright-command.js';
import { createPython3LikeCommand } from './python-command.js';
import { createServeCommand } from './serve-command.js';
import { createSqliteCommand } from './sqlite-command.js';
import { createUnameCommand } from './uname-command.js';
import { createManCommand } from './man-command.js';
import { createUnzipCommand } from './unzip-command.js';
import { createWebhookCommand } from './webhook-command.js';
import { createWebsocatCommand } from './websocat-command.js';
import { createCrontaskCommand } from './crontask-command.js';
import { createFsWatchCommand } from './fswatch-command.js';
import { createSprinkleCommand } from './sprinkle-command.js';
import { createOAuthTokenCommand } from './oauth-token-command.js';
import { createLocalLlmCommand } from './local-llm-command.js';
import { createSecretCommand } from './secret-command.js';
import { createOAuthDomainCommand } from './oauth-domain-command.js';
import { createRsyncCommand } from './rsync-command.js';
import { createWhichCommand } from './which-command.js';
import { createZipCommand } from './zip-command.js';
import { createScreencaptureCommand } from './screencapture-command.js';
import {
  createPbcopyCommand,
  createPbpasteCommand,
  createClipboardAutoCommand,
} from './clipboard-commands.js';
import { createSayCommand } from './say-command.js';
import { createAfplayCommand, createChimeCommand } from './afplay-command.js';
import { createModelsCommand } from './models-command.js';
import { createCostCommand } from './cost-command.js';
import { createNukeCommand } from './nuke-command.js';
import { createAgentCommand } from './agent-command.js';
import { createPsCommand } from './ps-command.js';
import { createKillCommand } from './kill-command.js';
import type { BrowserAPI } from '../../cdp/index.js';
import type { ScriptCatalog } from '../script-catalog.js';
import type { ProcessManager } from '../../kernel/process-manager.js';
export type {
  ImgcatCommandOptions as SupplementalCommandOptions,
  MediaPreviewItem,
} from './imgcat-command.js';

export interface SupplementalCommandsConfig extends ImgcatCommandOptions {
  /** Function that returns discovered .jsh command names (for `commands` listing). */
  getJshCommands?: () => Promise<string[]>;
  /** VirtualFS instance for .jsh discovery, `which`, and playwright-cli session files. */
  fs?: VirtualFS;
  /** Shared script discovery service for `.jsh`/`.bsh` lookup. */
  scriptCatalog?: ScriptCatalog;
  /** Browser automation backend for playwright-cli aliases. Optional so aliases stay discoverable even without browser support. */
  browserAPI?: BrowserAPI;
  /**
   * Returns the JID of the scoop whose shell is about to run a command,
   * when that shell lives inside a scoop context. Used by the `agent`
   * command to forward the parent's jid to the AgentBridge for model
   * inheritance. Returns `undefined` when the shell has no scoop owner
   * (the terminal panel's standalone WasmShell).
   */
  getParentJid?: () => string | undefined;
  /**
   * Process manager threaded into `ps` / `kill`. When omitted,
   * those commands fall back to `globalThis.__slicc_pm`
   * (published by `createKernelHost`). Tests prefer DI; production
   * works with either.
   */
  processManager?: ProcessManager;
}

export function createSupplementalCommands(options: SupplementalCommandsConfig = {}): Command[] {
  const commands: Command[] = [
    createCommandsCommand({ getJshCommands: options.getJshCommands }),
    createHostCommand(),
    createServeCommand(options.browserAPI, options.fs),
    createOpenCommand(),
    createImgcatCommand(options),
    createZipCommand(),
    createUnzipCommand(),
    createSqliteCommand('sqlite3'),
    createSqliteCommand('sqllite'),
    createNodeCommand(),
    createPython3LikeCommand('python3'),
    createPython3LikeCommand('python'),
    createWebhookCommand(),
    createWebsocatCommand(),
    createCrontaskCommand(),
    createFsWatchCommand(),
    createSprinkleCommand(),
    createPdftkCommand('pdftk'),
    createPdftkCommand('pdf'),
    createConvertCommand('convert'),
    createConvertCommand('magick'),
    createWhichCommand({ fs: options.fs, scriptCatalog: options.scriptCatalog }),
    createUnameCommand(),
    createManCommand(),
    createOAuthTokenCommand(),
    createOAuthDomainCommand(),
    createLocalLlmCommand(),
    createSecretCommand(),
    createRsyncCommand({ fs: options.fs }),
    createScreencaptureCommand(),
    createPbcopyCommand(),
    createPbpasteCommand(),
    createClipboardAutoCommand('xclip'),
    createClipboardAutoCommand('xsel'),
    createSayCommand(),
    createAfplayCommand(),
    createChimeCommand(),
    createModelsCommand(options.fs),
    createCostCommand(),
    createNukeCommand(),
    createAgentCommand({ getParentJid: options.getParentJid }),
    createPsCommand({ processManager: options.processManager }),
    createKillCommand({ processManager: options.processManager }),
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
