/**
 * Canonical runtime-environment primitives for the webapp bundle.
 *
 * Every Chrome-extension environment check in `packages/webapp/src/` MUST go
 * through one of the helpers exported here — raw `chrome.runtime.id` sniffs
 * are banned by the `lint:no-raw-chrome-runtime-id` gate.
 *
 * The helpers are pure (side-effect-free, no imports) and rely only on ambient
 * globals. They intentionally do NOT import `proxied-fetch.ts` or any other
 * module — keep them leaf-level so every layer can import them safely.
 */

/**
 * True when running inside a real `chrome-extension://` page or its
 * DedicatedWorker — the extension origin where `chrome.runtime.id` is a
 * non-empty string. Returns false on externally-connectable hosted pages
 * (thin-bridge leader) and in Node / worker realms with no `chrome` global.
 *
 * Realms that return true: extension service worker, side panel, options
 * page, offscreen document, extension-spawned workers.
 */
export function isExtensionRealm(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof (chrome as { runtime?: { id?: string } })?.runtime?.id === 'string' &&
    (chrome as { runtime: { id: string } }).runtime.id.length > 0
  );
}

/**
 * True when `chrome.runtime.connect` is available — i.e. the page can open a
 * named Port to an extension. This is true on both real extension pages AND
 * externally-connectable hosted origins (the thin-bridge leader tab), but
 * false in a DedicatedWorker or Node realm.
 *
 * Use this to decide whether the page realm can bridge fetch / secrets / mount
 * traffic to the extension service worker via a Port.
 */
export function hasChromeRuntimeConnect(): boolean {
  const runtime = (globalThis as { chrome?: { runtime?: { connect?: unknown } } }).chrome?.runtime;
  return typeof runtime?.connect === 'function';
}
