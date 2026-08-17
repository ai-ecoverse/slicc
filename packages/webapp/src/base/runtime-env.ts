/**
 * Canonical runtime-environment primitives for the webapp bundle.
 *
 * Pure and side-effect-free: these helpers read ambient globals only and live
 * in the foundational layer so every layer can import them without a back-edge.
 */

/**
 * True when running inside a real `chrome-extension://` page or its
 * DedicatedWorker. Externally-connectable hosted pages and realms without a
 * `chrome` global return false.
 */
export function isExtensionRealm(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof (chrome as { runtime?: { id?: string } })?.runtime?.id === 'string' &&
    (chrome as { runtime: { id: string } }).runtime.id.length > 0
  );
}

/** True when the page realm can open a named Chrome runtime Port. */
export function hasChromeRuntimeConnect(): boolean {
  const runtime = (globalThis as { chrome?: { runtime?: { connect?: unknown } } }).chrome?.runtime;
  return typeof runtime?.connect === 'function';
}
