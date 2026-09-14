import { parseClaudeVersion } from './claude-model-version.js';

export interface FamilyCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

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
