// Target resolution for licks and sprinkle routes. Lives in `base/` — the
// kernel host and the page-side facade both resolve targets, and neither
// should have to pull the whole `scoops/lick-manager.ts` module in to do it.

/**
 * Resolve a lick's `targetScoop` / route field against the live registry, in
 * THREE ORDERED PASSES over the whole roster:
 *
 *  1. exact `folder`
 *  2. `<target>-scoop` folder (a scoop addressed by its bare name)
 *  3. exact `name`
 *
 * The order is the point. `lickScoopMatches` (`scoops/lick-manager.ts`) answers "does THIS unit
 * match?" and is order-free, which is right for filtering; but resolving one
 * target out of many with a single `find` that ORs the three forms makes the
 * answer depend on registry order — a cone *named* `reviewer` sitting next to
 * a scoop in folder `reviewer-scoop` would resolve to whichever happened to be
 * registered first. Passing over the whole roster once per form makes the more
 * specific form win regardless of insertion order (#2311).
 *
 * Returns `undefined` when nothing matches; callers warn and drop rather than
 * silently redirecting a targeted lick to the default root.
 */
export function matchLickTargetAlias<T extends { name: string; folder: string }>(
  units: readonly T[],
  target: string
): T | undefined {
  return (
    units.find((u) => u.folder === target) ??
    units.find((u) => u.folder === `${target}-scoop`) ??
    units.find((u) => u.name === target)
  );
}
