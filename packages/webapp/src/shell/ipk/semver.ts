/**
 * Thin adapter over the node-semver `semver` package.
 *
 * ipk only needs three operations; this module re-exports them with stable
 * signatures so resolver.ts and registry.ts stay unchanged. node-semver is
 * zero-dependency and browser-safe (no Node builtins), and its default
 * prerelease-admission and x-range behavior already match what ipk expects.
 */

import {
  maxSatisfying as semverMaxSatisfying,
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
