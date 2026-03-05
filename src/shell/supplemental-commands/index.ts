import type { Command } from 'just-bash';
import { createNodeCommand } from './node-command.js';
import { createOpenCommand } from './open-command.js';
import { createPython3LikeCommand } from './python-command.js';
import { createSqliteCommand } from './sqlite-command.js';
import { createUnzipCommand } from './unzip-command.js';
import { createWebhookCommand } from './webhook-command.js';
import { createZipCommand } from './zip-command.js';

export function createSupplementalCommands(): Command[] {
  return [
    createOpenCommand(),
    createZipCommand(),
    createUnzipCommand(),
    createSqliteCommand('sqlite3'),
    createSqliteCommand('sqllite'),
    createNodeCommand(),
    createPython3LikeCommand('python3'),
    createPython3LikeCommand('python'),
    createWebhookCommand(),
  ];
}
