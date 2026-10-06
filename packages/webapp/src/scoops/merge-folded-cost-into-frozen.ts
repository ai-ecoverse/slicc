import type { AssistantMessage } from '../core/types.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type {
  FrozenSessionCost,
  FrozenSessionIndexEntry,
  FrozenSessionModel,
} from '../transcript/frozen-archive-format.js';
import {
  readSessionsIndexForWrite,
  serializeIndexWrite,
  writeSessionsIndexUnlocked,
} from '../transcript/frozen-archive-writer.js';
import { PRIMARY_CONE_FOLDER } from '../work-unit/record.js';
import type { RegisteredScoop } from './types.js';

export type FoldedCostArchiveVfs = Parameters<typeof writeSessionsIndexUnlocked>[0] &
  LocalVfsClient;

export async function mergeFoldedCostIntoLatestFrozen(
  vfs: FoldedCostArchiveVfs,
  scoop: Pick<RegisteredScoop, 'folder'>,
  folded: readonly AssistantMessage[]
): Promise<boolean> {
  if (folded.length === 0) return false;
  const coneFolder = scoop.folder || PRIMARY_CONE_FOLDER;

  return serializeIndexWrite(async () => {
    const entries = await readSessionsIndexForWrite(vfs);
    const candidates = entries.filter(
      (entry) => (entry.cone ?? PRIMARY_CONE_FOLDER) === coneFolder
    );
    if (candidates.length === 0) return false;

    const latest = candidates.reduce((best, entry) =>
      entry.frozenAt > best.frozenAt ? entry : best
    );
    const merged: FrozenSessionIndexEntry = {
      ...latest,
      cost: mergeFrozenCost(latest.cost, folded),
      models: mergeFrozenModels(latest.models, folded),
    };
    await writeSessionsIndexUnlocked(
      vfs,
      entries.map((entry) => (entry === latest ? merged : entry))
    );
    return true;
  });
}

function mergeFrozenCost(
  existing: FrozenSessionCost | undefined,
  folded: readonly AssistantMessage[]
): FrozenSessionCost {
  let total = existing?.total ?? 0;
  let input = existing?.input ?? 0;
  let output = existing?.output ?? 0;
  let cacheRead = existing?.cacheRead ?? 0;
  let cacheWrite = existing?.cacheWrite ?? 0;
  for (const msg of folded) {
    total += msg.usage.cost.total;
    input += msg.usage.cost.input;
    output += msg.usage.cost.output;
    cacheRead += msg.usage.cost.cacheRead;
    cacheWrite += msg.usage.cost.cacheWrite;
  }
  return { total, input, output, cacheRead, cacheWrite };
}

function mergeFrozenModels(
  existing: FrozenSessionModel[] | undefined,
  folded: readonly AssistantMessage[]
): FrozenSessionModel[] {
  const byModel = new Map<string, FrozenSessionModel>();
  for (const row of existing ?? []) {
    byModel.set(row.model, { ...row });
  }
  for (const msg of folded) {
    const prior = byModel.get(msg.model) ?? { model: msg.model, cost: 0, turns: 0, tokens: 0 };
    prior.cost += msg.usage.cost.total;
    prior.turns += 1;
    prior.tokens += msg.usage.totalTokens;
    byModel.set(msg.model, prior);
  }
  return [...byModel.values()].sort((a, b) => b.cost - a.cost);
}
