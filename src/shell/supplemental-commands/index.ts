import type { Command } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { createCommandsCommand } from './help-command.js';
import { createConvertCommand } from './convert-command.js';
import {
  createImgcatCommand,
} from './imgcat-command.js';
import type { ImgcatCommandOptions } from './imgcat-command.js';
import { createNodeCommand } from './node-command.js';
import { createOpenCommand } from './open-command.js';
import { createPdftkCommand } from './pdftk-command.js';
import { createPlaywrightCommand, PLAYWRIGHT_COMMAND_NAMES } from './playwright-command.js';
import { createPython3LikeCommand } from './python-command.js';
import { createServeCommand } from './serve-command.js';
import { createSqliteCommand } from './sqlite-command.js';
import { createUnameCommand } from './uname-command.js';
import { createUnzipCommand } from './unzip-command.js';
import { createWebhookCommand } from './webhook-command.js';
import { createCrontaskCommand } from './crontask-command.js';
import { createWhichCommand } from './which-command.js';
import { createZipCommand } from './zip-command.js';
import type { BrowserAPI } from '../../cdp/index.js';
export type {
  ImgcatCommandOptions as SupplementalCommandOptions,
  MediaPreviewItem,
} from './imgcat-command.js';

export interface SupplementalCommandsConfig extends ImgcatCommandOptions {
  /** Function that returns discovered .jsh command names (for `commands` listing). */
  getJshCommands?: () => Promise<string[]>;
  /** VirtualFS instance for .jsh discovery, `which`, and playwright-cli session files. */
  fs?: VirtualFS;
  /** Browser automation backend for playwright-cli aliases. Optional so aliases stay discoverable even without browser support. */
  browserAPI?: BrowserAPI;
}

export function createSupplementalCommands(options: SupplementalCommandsConfig = {}): Command[] {
  const commands: Command[] = [
    createCommandsCommand({ getJshCommands: options.getJshCommands }),
    createServeCommand(),
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
    createCrontaskCommand(),
    createPdftkCommand('pdftk'),
    createPdftkCommand('pdf'),
    createConvertCommand('convert'),
    createConvertCommand('magick'),
    createWhichCommand(options.fs),
    createUnameCommand(),
  ];

  if (options.fs) {
    commands.push(
      ...PLAYWRIGHT_COMMAND_NAMES.map((name) => createPlaywrightCommand(name, options.browserAPI, options.fs!)),
    );
  }

  return commands;
}
