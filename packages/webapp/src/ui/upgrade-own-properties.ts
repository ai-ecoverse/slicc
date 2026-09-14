interface AccessorBag {
  [property: string]: unknown;
}

export function upgradeOwnProperties(el: HTMLElement, props: readonly string[]): void {
  const target = el as unknown as AccessorBag;
  for (const prop of props) {
    if (!Object.hasOwn(el, prop)) continue;
    const value = target[prop];
    delete target[prop];
    target[prop] = value;
  }
}
