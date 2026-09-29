import {
  compare as semverCompare,
  maxSatisfying as semverMaxSatisfying,
  parse as semverParse,
  satisfies as semverSatisfies,
  validRange as semverValidRange,
} from 'semver';

export function satisfies(version: string, range: string): boolean {
  return semverSatisfies(version, range);
}

export function maxSatisfying(versions: string[], range: string): string | null {
  return semverMaxSatisfying(versions, range);
}

export function isValidRange(range: string): boolean {
  return semverValidRange(range) !== null;
}

export function exactVersion(spec: string): string | null {
  return semverParse(spec)?.version ?? null;
}

export function maxOnReleaseLine(versions: string[], target: string): string | null {
  const line = semverParse(target);
  if (!line) return null;
  let best: string | null = null;
  for (const v of versions) {
    const parsed = semverParse(v);
    if (!parsed) continue;
    if (parsed.major !== line.major || parsed.minor !== line.minor || parsed.patch !== line.patch) {
      continue;
    }
    if (best === null || semverCompare(parsed, best) > 0) best = v;
  }
  return best;
}
