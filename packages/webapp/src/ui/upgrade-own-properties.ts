/**
 * Adopt properties set on a custom element BEFORE its definition loaded.
 *
 * `el.patch = '…'` on an un-upgraded element installs an OWN data property.
 * When the definition arrives, that own property shadows the prototype's
 * accessor forever: the setter never runs, and the element renders nothing.
 *
 * Deleting the own value and re-assigning it through the prototype fixes that.
 * Call it FIRST in `connectedCallback`, before anything reads the backing
 * fields, listing every property that has an accessor.
 *
 * Sprinkles hit this: the element bundles load asynchronously (a shim that
 * dynamic-imports the hashed entry in full-doc mode; an appended `<script>` in
 * inline mode), while the documented usage is `document.getElementById('d')
 * .patch = …` in a plain inline script.
 */
/** A custom element addressed by the property names its class defines accessors for. */
interface AccessorBag {
  [property: string]: unknown;
}

export function upgradeOwnProperties(el: HTMLElement, props: readonly string[]): void {
  // An element seen through its accessor names: the only shape this touches.
  const target = el as unknown as AccessorBag;
  for (const prop of props) {
    if (!Object.hasOwn(el, prop)) continue;
    const value = target[prop];
    delete target[prop];
    target[prop] = value;
  }
}
