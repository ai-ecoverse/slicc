/**
 * The two guarantees every adapter boundary owes its caller (#2276 slice B).
 *
 * Both live here because they are easy to get right once and easy to forget
 * per operation, and because a lapse in either is invisible until a transport
 * misbehaves in production.
 */

import { type CapabilityDomain, type CapabilityResult, capabilityFailed } from './types.js';

/**
 * Memoize a lazy `import()`, but NEVER memoize its rejection.
 *
 * A plain `promise ??= import(...)` caches the failure, so one transient
 * chunk-load error (an evicted asset after a deploy, a flaky network) poisons
 * every later operation on this broker for the life of the tab. Clearing the
 * slot on rejection makes the next call retry the import.
 */
export function createLazyOps<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending === null) {
      pending = load().catch((err: unknown) => {
        pending = null;
        throw err;
      });
    }
    return pending;
  };
}

/**
 * Run one operation so that NOTHING escapes as a throw — not the transport,
 * not the lazy module load, not a body that fails after its headers landed.
 *
 * The conformance suite's "every operation returns a typed result" rule is
 * load-bearing: callers branch on the result, so an escaping rejection would
 * surface as an unhandled error far from the capability that caused it.
 */
export async function guardCapability<T>(
  capability: CapabilityDomain,
  operation: string,
  run: () => Promise<CapabilityResult<T>>
): Promise<CapabilityResult<T>> {
  try {
    return await run();
  } catch (err) {
    return capabilityFailed(
      capability,
      operation,
      err instanceof Error ? err.message : String(err)
    );
  }
}
