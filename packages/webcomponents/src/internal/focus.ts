export function deepActiveElement(doc: Document): Element | null {
  let element: Element | null = doc.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

function isWithin(scope: Node, node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (scope.contains(current)) return true;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

export function withFocusPreserved<T>(scope: Node, rebuild: () => T): T {
  const doc = scope.ownerDocument ?? (scope as Document);
  const before = deepActiveElement(doc);
  const owned = !!before && before !== doc.body && isWithin(scope, before);
  const result = rebuild();
  if (owned && before.isConnected && deepActiveElement(doc) !== before) {
    (before as HTMLElement).focus?.({ preventScroll: true });
  }
  return result;
}
