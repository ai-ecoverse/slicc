/**
 * Boot restore for enabled jshd units. Invoked fire-and-forget from
 * `createKernelHost` after mount recovery is scheduled — never on the
 * boot critical path.
 */

import { createCommandContext } from 'just-bash';
import type { VirtualFS } from '../../../fs/index.js';
import type { ProcessManager } from '../../../kernel/process-manager.js';
import { textAsStdin } from '../../just-bash-compat.js';
import { VfsAdapter } from '../../vfs-adapter.js';
import { listUnitRecords } from './store.js';
import { getJshdSupervisor, type JshdLickSink } from './supervisor.js';
import type { JshdUnitRecord } from './types.js';

export interface RestoreJshdDeps {
  fs: VirtualFS;
  processManager: ProcessManager;
  lickManager?: JshdLickSink;
}

export async function restoreEnabledJshdUnits(deps: RestoreJshdDeps): Promise<string[]> {
  const records = (await listUnitRecords(deps.fs)).filter((record) => record.enabled);
  if (records.length === 0) return [];
  const adapter = new VfsAdapter(deps.fs);
  const supervisor = getJshdSupervisor({
    fs: deps.fs,
    processManager: deps.processManager,
    lickManager: deps.lickManager,
    buildContext: (record) => contextFor(adapter, record),
  });
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

function contextFor(adapter: VfsAdapter, record: JshdUnitRecord) {
  return createCommandContext({
    fs: adapter,
    cwd: record.cwd,
    env: new Map(Object.entries(record.env)),
    stdin: textAsStdin(''),
  });
}
