/**
 * One resolver for "which work unit does this lick belong to?" (#2273).
 *
 * A `LickEvent.targetScoop` is an *alias*, not an id: webhooks, cron tasks,
 * `fswatch`, background `bash` jobs and sprinkle routes all carry whatever the
 * user typed after `--scoop`. Two call sites used to re-implement the lookup
 * with subtly different fallbacks — `kernel/host.ts routeFormattedLickToCone`
 * dropped an unmatched target, `KernelFacade.routeSprinkleLick` fell through to
 * the cone — and neither could name a cone.
 *
 * A cone is now addressable by the same alias vocabulary as a scoop: its
 * folder (`cone`, `cone-research`) or its name. Unaddressed events resolve
 * {@link pickDefaultRoot}, so the user's "Make default" pick in the Cones rail
 * decides where they land.
 */

import type { RegisteredScoop } from '../scoops/types.js';
import { pickDefaultRoot } from './default-root.js';

export interface ResolveLickTargetOptions {
  /**
   * What to do when `alias` is given but matches no registered unit.
   * `'drop'` (the default) returns `undefined` so the caller can warn and
   * discard — a lick addressed to a scoop that no longer exists should not
   * silently surface in someone else's chat. `'default-root'` falls through
   * to the default root, which is what sprinkle routing has always done (a
   * stale `sprinkle route` entry must not swallow the panel's events).
   */
  unmatched?: 'drop' | 'default-root';
  /** Override the persisted default-root pick (tests, panel-side callers). */
  defaultRootJid?: string | null;
}

/**
 * Match a `targetScoop` alias against the registry. Accepts a unit's `name`,
 * its `folder` (which is how a cone is addressed: `cone`, `cone-research`) or
 * the bare name of a scoop whose folder carries the conventional `-scoop`
 * suffix.
 */
function matchLickTargetAlias(
  scoops: readonly RegisteredScoop[],
  alias: string
): RegisteredScoop | undefined {
  return scoops.find(
    (s) => s.name === alias || s.folder === alias || s.folder === `${alias}-scoop`
  );
}

/**
 * Resolve the unit a lick should be delivered to: the aliased unit when the
 * event names one, else the default root.
 */
export function resolveLickTarget(
  scoops: readonly RegisteredScoop[],
  alias: string | undefined,
  options: ResolveLickTargetOptions = {}
): RegisteredScoop | undefined {
  const fallback = (): RegisteredScoop | undefined =>
    options.defaultRootJid === undefined
      ? pickDefaultRoot(scoops)
      : pickDefaultRoot(scoops, options.defaultRootJid);
  if (!alias) return fallback();
  const matched = matchLickTargetAlias(scoops, alias);
  if (matched) return matched;
  return options.unmatched === 'default-root' ? fallback() : undefined;
}
