/**
 * Thin adapter over the node-semver `semver` package.
 *
 * ipk only needs a handful of operations; this module re-exports them with stable
 * signatures so resolver.ts and registry.ts stay unchanged. node-semver is
 * zero-dependency and browser-safe (no Node builtins), and its default
 * prerelease-admission and x-range behavior already match what ipk expects.
 */

import {
  compare as semverCompare,
  maxSatisfying as semverMaxSatisfying,
  parse as semverParse,
  satisfies as semverSatisfies,
  validRange as semverValidRange,
} from 'semver';

/**
 * True when `version` satisfies `range`. Prereleases are admitted only when a
 * comparator in the matched set carries a prerelease tag on the same
 * [major, minor, patch] tuple (node-semver's default `includePrerelease=false`).
 * Returns false (never throws) for an invalid version or range.
 */
export function satisfies(version: string, range: string): boolean {
  return semverSatisfies(version, range);
}

/**
 * Highest version in `versions` that satisfies `range`, or null when none do.
 * Invalid versions in the list are ignored; an invalid range yields null.
 */
export function maxSatisfying(versions: string[], range: string): string | null {
  return semverMaxSatisfying(versions, range);
}

/** True when `range` is a parseable semver range. Never throws. */
export function isValidRange(range: string): boolean {
  return semverValidRange(range) !== null;
}

/**
 * `spec` as a plain version with any build metadata dropped (`1.2.3+b` →
 * `1.2.3`), or null when it is not a single version. pnpm treats such a spec
 * as an exact request.
 */
export function exactVersion(spec: string): string | null {
  return semverParse(spec)?.version ?? null;
}

/**
 * Highest entry of `versions` on `target`'s major.minor.patch line,
 * prereleases included, or null when there is none.
 */
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
