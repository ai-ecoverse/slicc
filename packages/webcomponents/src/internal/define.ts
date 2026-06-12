/**
 * Register a custom element, guarding against double-registration. Every
 * component module calls this at import time so importing the module (or the
 * package barrel) is sufficient to register the element. Idempotent: re-imports
 * and HMR re-evaluations are safe.
 */
export function define(tag: string, ctor: CustomElementConstructor): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(tag)) {
    customElements.define(tag, ctor);
  }
}
