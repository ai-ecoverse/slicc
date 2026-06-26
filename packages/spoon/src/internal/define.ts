/**
 * Register a custom element, guarding against double-registration. Every
 * component module calls this at import time so importing the module (or the
 * package barrel) is sufficient to register the element. Idempotent: re-imports
 * and HMR re-evaluations are safe.
 *
 * Registry-less worlds (no-op): Chrome MV3 content-script ISOLATED worlds
 * expose `customElements` as `null` (not `undefined`), so a `typeof` check
 * alone would let `customElements.get(...)` throw a `TypeError`. The `== null`
 * check covers both `null` and `undefined` and skips registration cleanly —
 * callers in those worlds are expected to mount the element in the page MAIN
 * world (see `packages/chrome-extension/manifest.json` content_scripts entry
 * with `"world": "MAIN"`).
 */
export function define(tag: string, ctor: CustomElementConstructor): void {
  if (typeof customElements === 'undefined' || customElements == null) return;
  if (!customElements.get(tag)) {
    customElements.define(tag, ctor);
  }
}
