/**
 * Pure family-cost inheritance helper.
 *
 * Extracted from `providers/adobe.ts:findFamilyCost()` so it has zero DOM /
 * `chrome` / `import.meta.glob` dependencies and can be unit-tested directly
 * (adobe.ts itself cannot be imported under vitest). It depends only on
 * `parseClaudeVersion` from `claude-model-version.ts`, following the same
 * extraction pattern as `adobe-model-metadata.ts`.
 *
 * When a proxy reports a Claude model pi-ai's registry doesn't know yet (e.g.
 * `claude-opus-5`), the synthesized model would otherwise price at $0. This
 * helper inherits pricing from the highest known version in the same Claude
 * family so the session cost counter degrades gracefully instead of to zero.
 * Both `buildAdobeModel()` (adobe.ts) and `getProviderModels()`'s unknown-model
 * branch (account-store.ts) route through it to keep the two model-construction
 * paths aligned.
 */

import { parseClaudeVersion } from './claude-model-version.js';

/** Per-token cost structure (values in $ per million tokens); matches pi-ai's `ModelCostRates`. */
export interface FamilyCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Find the closest known model in the same Claude family to inherit costs from.
 * Searches for e.g. `opus-4-8` when the proxy returns `opus-5-0` that pi-ai
 * doesn't know yet, picking the highest known version in the family. Returns a
 * zero-cost fallback when the id is non-Claude or no family member is known.
 */
export function findFamilyCost<T extends { id: string; cost: FamilyCost }>(
  modelId: string,
  modelMap: Map<string, T>
): FamilyCost {
  const zeroCost: FamilyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const target = parseClaudeVersion(modelId);
  if (!target) return zeroCost;
  let best: { major: number; minor: number; cost: FamilyCost } | undefined;
  for (const m of modelMap.values()) {
    const v = parseClaudeVersion(m.id);
    if (!v || v.family !== target.family) continue;
    if (!best || v.major > best.major || (v.major === best.major && v.minor > best.minor)) {
      best = { major: v.major, minor: v.minor, cost: m.cost };
    }
  }
  return best?.cost ?? zeroCost;
}
