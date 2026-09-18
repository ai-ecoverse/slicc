import type { IFileSystem } from 'just-bash';
import { emptyPolicy, type SudoersPolicy } from '../../../base/sudoers.js';
import type { VirtualFS } from '../../../fs/index.js';
import { createSudoFs } from '../../../fs/sudo-fs.js';
import type { ProcessManager } from '../../../kernel/process-manager.js';
import type { RealmFactory } from '../../../kernel/realm/realm-runner.js';
import type { SudoBroker } from '../../../sudo/types.js';
import { AlmostBashShellHeadless } from '../../almost-bash-shell-headless.js';
import { VfsAdapter } from '../../vfs-adapter.js';
import { createJshdKernelContext, type JshdExecBridge } from './context.js';
import { listUnitRecords } from './store.js';
import { installJshdSupervisor, type JshdLickSink } from './supervisor.js';
import type { JshdUnitRecord } from './types.js';

const FAIL_CLOSED_BROKER: SudoBroker = {
  requestApproval: async () => ({ decision: 'deny' }),
};

export interface JshdSudoGate {
  broker: SudoBroker;
  getPolicy: () => SudoersPolicy;
}

export interface RestoreJshdDeps {
  fs: VirtualFS;
  processManager: ProcessManager;
  lickManager?: JshdLickSink;
  realmFactory?: RealmFactory;

  sudo?: JshdSudoGate;
}

export async function restoreEnabledJshdUnits(deps: RestoreJshdDeps): Promise<string[]> {
  const gatedFs = gateJshdFs(deps.fs, deps.sudo);
  const adapter = new VfsAdapter(gatedFs);
  const shell = new AlmostBashShellHeadless({
    fs: gatedFs,
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
    ...(deps.realmFactory ? { realmFactory: deps.realmFactory } : {}),
    buildContext: (record) => contextFor(adapter, record, bridge),
  });
  const records = (await listUnitRecords(deps.fs)).filter((record) => record.enabled);
  if (records.length === 0) return [];
  const started: string[] = [];
  for (const record of records) {
    try {
      await supervisor.start(record);
      started.push(record.name);
    } catch {}
  }
  return started;
}

export function contextFor(fs: IFileSystem, record: JshdUnitRecord, bridge: JshdExecBridge) {
  return createJshdKernelContext(fs, record, bridge);
}

function gateJshdFs(fs: VirtualFS, sudo?: JshdSudoGate): VirtualFS {
  return createSudoFs(fs, {
    broker: sudo?.broker ?? FAIL_CLOSED_BROKER,
    getPolicy: sudo?.getPolicy ?? emptyPolicy,
    defaultDisposition: 'allow',
  });
}
