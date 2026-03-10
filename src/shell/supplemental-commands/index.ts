import type { Command } from 'just-bash';
import { createCommandsCommand } from './help-command.js';
import { createConvertCommand } from './convert-command.js';
import {
  createImgcatCommand,
} from './imgcat-command.js';
import type { ImgcatCommandOptions } from './imgcat-command.js';
import { createNodeCommand } from './node-command.js';
import { createOpenCommand } from './open-command.js';
import { createPdftkCommand } from './pdftk-command.js';
import { createPlaywrightCommand } from './playwright-command.js';
import { createPython3LikeCommand } from './python-command.js';
import { createSqliteCommand } from './sqlite-command.js';
import { createUnzipCommand } from './unzip-command.js';
import { createWebhookCommand } from './webhook-command.js';
import { createCrontaskCommand } from './crontask-command.js';
import { createZipCommand } from './zip-command.js';
import type { BrowserAPI } from '../../cdp/index.js';
import type { VirtualFS } from '../../fs/index.js';
export type {
  ImgcatCommandOptions as SupplementalCommandOptions,
  MediaPreviewItem,
} from './imgcat-command.js';

export interface SupplementalCommandsConfig extends ImgcatCommandOptions {
  browserAPI?: BrowserAPI;
  vfs?: VirtualFS;
}

export function createSupplementalCommands(options: SupplementalCommandsConfig = {}): Command[] {
  const commands: Command[] = [
    createCommandsCommand(),
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
  ];

  if (options.browserAPI && options.vfs) {
    commands.push(
      createPlaywrightCommand('playwright-cli', options.browserAPI, options.vfs),
      createPlaywrightCommand('playwright', options.browserAPI, options.vfs),
      createPlaywrightCommand('puppeteer', options.browserAPI, options.vfs),
    );
  }

  return commands;
}
