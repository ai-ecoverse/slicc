/**
 * Merge silent-child spend into the newest frozen-session index row for a
 * cone. Used at New-session clear after the freezer has already written the
 * archive from chat messages alone — those messages never carried the folded
 * one-shot `agent` usage (#3437 review).
 */

import type { AssistantMessage } from '../core/types.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import {
  type FrozenSessionCost,
  type FrozenSessionIndexEntry,
  type FrozenSessionModel,
  readSessionsIndex,
} from '../transcript/frozen-archive-format.js';
import { upsertSessionsIndexEntry } from '../transcript/frozen-archive-writer.js';
import { PRIMARY_CONE_FOLDER } from '../work-unit/record.js';
import type { RegisteredScoop } from './types.js';

/** Structural VFS surface the merge needs (shared with the freezer writer). */
export type FoldedCostArchiveVfs = Parameters<typeof upsertSessionsIndexEntry>[0] & LocalVfsClient;

/**
 * Add folded assistant-turn usage into the newest `/sessions` index row for
 * `scoop`'s cone folder. Returns false when there is no matching row (erase /
 * short-session skip) so the caller can keep the spend on the dropped ledger.
 */
export async function mergeFoldedCostIntoLatestFrozen(
  vfs: FoldedCostArchiveVfs,
  scoop: Pick<RegisteredScoop, 'folder'>,
  folded: readonly AssistantMessage[]
): Promise<boolean> {
  if (folded.length === 0) return false;
  const coneFolder = scoop.folder || PRIMARY_CONE_FOLDER;
  const entries = await readSessionsIndex(vfs);
  const candidates = entries.filter((entry) => (entry.cone ?? PRIMARY_CONE_FOLDER) === coneFolder);
  if (candidates.length === 0) return false;
  // Newest freeze first — the New-session clear runs moments after the freezer
  // wrote this row, so folding into any older archive would mis-attribute.
  const latest = candidates.reduce((best, entry) =>
    entry.frozenAt > best.frozenAt ? entry : best
  );

  const merged: FrozenSessionIndexEntry = {
    ...latest,
    cost: mergeFrozenCost(latest.cost, folded),
    models: mergeFrozenModels(latest.models, folded),
  };
  await upsertSessionsIndexEntry(vfs, merged);
  return true;
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
