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
import { createPython3LikeCommand } from './python-command.js';
import { createSqliteCommand } from './sqlite-command.js';
import { createUnzipCommand } from './unzip-command.js';
import { createWebhookCommand } from './webhook-command.js';
import { createCrontaskCommand } from './crontask-command.js';
import { createZipCommand } from './zip-command.js';
export type {
  ImgcatCommandOptions as SupplementalCommandOptions,
  MediaPreviewItem,
} from './imgcat-command.js';

export function createSupplementalCommands(options: ImgcatCommandOptions = {}): Command[] {
  return [
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
}
