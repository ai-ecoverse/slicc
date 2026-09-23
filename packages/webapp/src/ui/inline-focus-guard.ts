/**
 * Keyboard-focus guard for INLINE (fragment, non-full-document) sprinkles.
 *
 * A full-document sprinkle runs in a srcdoc frame and gets
 * `iframeFocusGuardSource` spliced in ahead of its scripts. An inline sprinkle
 * has no frame: its revived `<script>`s run in the SLICC document itself, so a
 * "focus the first field on load" nicety — or any async continuation of one —
 * pulls the caret out of the composer while the user types, and there is no
 * per-sprinkle `HTMLElement.prototype.focus` to patch.
 *
 * So the guard sits on the receiving end instead: a focus move INTO the
 * sprinkle's subtree is honoured only when
 *
 * - the focus is already inside the sprinkle (moving it between the
 *   sprinkle's own fields is the sprinkle's business), or
 * - the user just pressed a pointer inside the sprinkle (a click on one of
 *   its fields or labels), or
 * - the user just pressed Tab (keyboard navigation into the sprinkle).
 *
 * Anything else is handed back to whatever held the focus before (a textarea
 * keeps its selection, so the caret comes back where it was), or dropped when
 * nothing did. Like the frame guard this is a guard against accidents, not a
 * sandbox: inline sprinkle code is same-document, trusted agent code.
 */

/** How long a pointer press or Tab keeps the door open for the focus it causes. */
export const FOCUS_GESTURE_WINDOW_MS = 1000;

/** Duck-typed, so it holds across realms (a test DOM's `Node` is not the global one). */
function isWithin(scope: Node, target: EventTarget | null): boolean {
  return (
    !!target && typeof (target as Node).nodeType === 'number' && scope.contains(target as Node)
  );
}

/** The element a focus event is really about, piercing open shadow roots. */
function deepTarget(event: Event): HTMLElement | null {
  const origin = event.composedPath()[0];
  return origin && typeof (origin as HTMLElement).focus === 'function'
    ? (origin as HTMLElement)
    : null;
}

/** What holds the focus right now, piercing open shadow roots. */
function deepActiveElement(doc: Document): HTMLElement | null {
  let element: Element | null = doc.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element && element !== doc.body ? (element as HTMLElement) : null;
}

/**
 * Install the guard on `scope` (the inline sprinkle's content wrapper).
 * Returns the uninstaller; call it when the sprinkle is disposed.
 */
export function guardInlineFocus(scope: HTMLElement, now: () => number = Date.now): () => void {
  const doc = scope.ownerDocument;
  let lastGesture = Number.NEGATIVE_INFINITY;
  const initial = deepActiveElement(doc);
  let lastOutside: HTMLElement | null = initial && !isWithin(scope, initial) ? initial : null;

  const onPointerDown = (): void => {
    lastGesture = now();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') lastGesture = now();
  };
  // Remember the last focus holder OUTSIDE the sprinkle: `relatedTarget` on
  // the incoming focusin is retargeted to a shadow host, which cannot give
  // the caret back to the textarea inside it.
  const onDocFocusIn = (event: FocusEvent): void => {
    if (!event.composedPath().includes(scope)) lastOutside = deepTarget(event);
  };
  // ...and forget it when the focus leaves it for nowhere (a blur). A window
  // blur (switching apps) also fires `focusout` with no `relatedTarget`, but
  // the element stays the active one and gets the focus back on return, so it
  // is still the restore target.
  const onDocFocusOut = (event: FocusEvent): void => {
    if (event.relatedTarget || event.composedPath().includes(scope)) return;
    if (deepTarget(event) === deepActiveElement(doc)) return;
    lastOutside = null;
  };
  const onFocusIn = (event: FocusEvent): void => {
    if (isWithin(scope, event.relatedTarget)) return;
    if (now() - lastGesture <= FOCUS_GESTURE_WINDOW_MS) return;
    const intruder = deepTarget(event);
    const previous = lastOutside?.isConnected ? lastOutside : null;
    // Listeners further out must not act on a focus that is being undone.
    event.stopPropagation();
    if (previous) previous.focus({ preventScroll: true });
    else intruder?.blur();
  };

  scope.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('focusin', onDocFocusIn, true);
  doc.addEventListener('focusout', onDocFocusOut, true);
  scope.addEventListener('focusin', onFocusIn, true);
  return () => {
    scope.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('focusin', onDocFocusIn, true);
    doc.removeEventListener('focusout', onDocFocusOut, true);
    scope.removeEventListener('focusin', onFocusIn, true);
  };
}
