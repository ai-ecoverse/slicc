/**
 * Boot restore for enabled jshd units. Invoked from `createKernelHost`
 * after mount recovery has completed and before cone bootstrap, so
 * enabled units are live before the cone's first turn.
 */

import type { IFileSystem } from 'just-bash';
import type { VirtualFS } from '../../../fs/index.js';
import type { ProcessManager } from '../../../kernel/process-manager.js';
import { AlmostBashShellHeadless } from '../../almost-bash-shell-headless.js';
import { VfsAdapter } from '../../vfs-adapter.js';
import { createJshdKernelContext, type JshdExecBridge } from './context.js';
import { listUnitRecords } from './store.js';
import { installJshdSupervisor, type JshdLickSink } from './supervisor.js';
import type { JshdUnitRecord } from './types.js';

export interface RestoreJshdDeps {
  fs: VirtualFS;
  processManager: ProcessManager;
  lickManager?: JshdLickSink;
}

export async function restoreEnabledJshdUnits(deps: RestoreJshdDeps): Promise<string[]> {
  const adapter = new VfsAdapter(deps.fs);
  const shell = new AlmostBashShellHeadless({
    fs: deps.fs,
    cwd: '/workspace',
    processManager: deps.processManager,
    processOwner: { kind: 'jshd' },
  });
  const bridge: JshdExecBridge = {
    exec: (cmd, opts) =>
      shell.getBash().exec(cmd, {
        env: opts?.env ?? shell.getEnv(),
        cwd: opts?.cwd ?? '/workspace',
        args: opts?.args,
        ...(opts?.env !== undefined ? { replaceEnv: true } : {}),
      }),
  };
  const supervisor = installJshdSupervisor({
    fs: deps.fs,
    processManager: deps.processManager,
    lickManager: deps.lickManager,
    buildContext: (record) => contextFor(adapter, record, bridge),
  });
  const records = (await listUnitRecords(deps.fs)).filter((record) => record.enabled);
  if (records.length === 0) return [];
  const started: string[] = [];
  for (const record of records) {
    try {
      await supervisor.start(record);
      started.push(record.name);
    } catch {
      // Best-effort: a missing script or already-running unit must not
      // fail the rest of restore, and must not block boot.
    }
  }
  return started;
}

export function contextFor(fs: IFileSystem, record: JshdUnitRecord, bridge: JshdExecBridge) {
  return createJshdKernelContext(fs, record, bridge);
}
