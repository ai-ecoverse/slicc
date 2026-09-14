import type { CommandContext } from 'just-bash';
import { ProcessManager, type ProcessOwner } from '../kernel/process-manager.js';
import { createDefaultRealmFactory } from '../kernel/realm/realm-factory.js';
import { createInProcessJsRealmFactory } from '../kernel/realm/realm-inprocess.js';
import type { RealmFactory } from '../kernel/realm/realm-runner.js';
import { runInRealm } from '../kernel/realm/realm-runner.js';
import { isSyncFsBridgeEnabled } from '../kernel/realm/sync-fs-enabled.js';
import { stdinAsLatin1 } from './just-bash-compat.js';
import { resolveProviderEnvSeed } from './provider-env-seed.js';

export interface JshResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface JshProcessConfig {
  processManager: ProcessManager;
  owner: ProcessOwner;
  getParentPid?: () => number | undefined;
}

export interface JshExecutorOptions {
  realmFactory?: RealmFactory;
}

export async function executeJshFile(
  scriptPath: string,
  args: string[],
  ctx: CommandContext,
  pmConfig?: JshProcessConfig,
  options: JshExecutorOptions = {}
): Promise<JshResult> {
  if (!(await ctx.fs.exists(scriptPath))) {
    return {
      stdout: '',
      stderr: `jsh: cannot find script '${scriptPath}'\n`,
      exitCode: 127,
    };
  }
  const code = await ctx.fs.readFile(scriptPath);
  const argv = ['node', scriptPath, ...args];
  return executeJsCode(code, argv, ctx, pmConfig, { ...options, filename: scriptPath });
}

export async function executeJsCode(
  code: string,
  argv: string[],
  ctx: CommandContext,
  pmConfig?: JshProcessConfig,
  options: JshExecutorOptions & { filename?: string } = {}
): Promise<JshResult> {
  const realmFactory = options.realmFactory ?? pickDefaultRealmFactory();

  const pm = pmConfig?.processManager ?? lookupGlobalPm() ?? lazyEphemeralPm();
  const owner: ProcessOwner = pmConfig?.owner ?? { kind: 'system' };
  const filename = options.filename ?? argv[1] ?? '<eval>';

  const providerEnv = owner.kind === 'scoop' ? {} : await resolveProviderEnvSeed();

  const result = await runInRealm({
    pm,
    realmFactory,
    owner,
    kind: 'js',
    code,
    argv,
    env: { ...providerEnv, ...Object.fromEntries(ctx.env.entries()) },
    cwd: ctx.cwd,
    filename,

    stdin: stdinAsLatin1(ctx.stdin),
    ctx,
    ppid: pmConfig?.getParentPid?.(),

    syncFsBridgeEnabled: isSyncFsBridgeEnabled(),
  });
  return result;
}

function pickDefaultRealmFactory(): RealmFactory {
  if (typeof Worker !== 'undefined' || typeof document !== 'undefined') {
    return createDefaultRealmFactory();
  }
  return createInProcessJsRealmFactory();
}

let EphemeralPm: ProcessManager | null = null;
function lazyEphemeralPm(): ProcessManager {
  if (!EphemeralPm) {
    EphemeralPm = new ProcessManager();
  }
  return EphemeralPm;
}

function lookupGlobalPm(): ProcessManager | null {
  const g = globalThis as { __slicc_pm?: unknown };
  const pm = g.__slicc_pm;
  if (
    pm &&
    typeof pm === 'object' &&
    typeof (pm as { spawn?: unknown }).spawn === 'function' &&
    typeof (pm as { onSignal?: unknown }).onSignal === 'function'
  ) {
    return pm as ProcessManager;
  }
  return null;
}

export type { ProcessManager } from '../kernel/process-manager.js';
