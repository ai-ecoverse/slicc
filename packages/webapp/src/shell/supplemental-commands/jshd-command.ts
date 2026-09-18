import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { ProcessManager } from '../../kernel/process-manager.js';
import type { RealmFactory } from '../../kernel/realm/realm-runner.js';
import type { ScriptCatalog } from '../script-catalog.js';

export interface JshdCommandOptions {
  processManager?: ProcessManager;
  scriptCatalog?: ScriptCatalog;
  realmFactory?: RealmFactory;
}

export function createJshdCommand(options: JshdCommandOptions = {}): Command {
  return defineCommand('jshd', async (args, ctx) => {
    const { runJshd } = await import('./jshd/run.js');
    return runJshd(args, ctx, options);
  });
}
