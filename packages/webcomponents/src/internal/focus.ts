/**
 * Focus survival across DOM rebuilds.
 *
 * A layout component that rebuilds its skeleton and re-appends the surfaces it
 * hosts MOVES whatever holds the focus — and moving a focused element blurs it
 * (the browser runs its focus fixup on the removal half of the move and never
 * gives the focus back on the insertion half). The composer's textarea lives in
 * such a surface, so every rebuild a background actor triggers (a scoop opening
 * or closing a sprinkle) silently took the caret away mid-sentence, and the
 * shell's resting keyboard mode then read the next keystrokes as shortcuts.
 */

/** What actually has the focus, piercing open shadow roots. */
export function deepActiveElement(doc: Document): Element | null {
  let element: Element | null = doc.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

/** Whether `node` sits inside `scope`, crossing shadow boundaries upward. */
function isWithin(scope: Node, node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (scope.contains(current)) return true;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

/**
 * Run `rebuild`, then hand the focus back to whatever inside `scope` held it
 * before, if the rebuild moved it away. Focus outside `scope` is never touched,
 * and neither is focus the rebuild legitimately left elsewhere — only a
 * focused element that is still connected and lost the focus to the move is
 * restored. `preventScroll`, because a rebuild the user did not ask for must
 * not scroll anything either.
 *
 * A textarea keeps its selection range across a move, so restoring the focus
 * puts the caret back exactly where it was.
 */
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
