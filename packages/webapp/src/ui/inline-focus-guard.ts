export const FOCUS_GESTURE_WINDOW_MS = 1000;

function isWithin(scope: Node, target: EventTarget | null): boolean {
  return (
    !!target && typeof (target as Node).nodeType === 'number' && scope.contains(target as Node)
  );
}

function deepTarget(event: Event): HTMLElement | null {
  const origin = event.composedPath()[0];
  return origin && typeof (origin as HTMLElement).focus === 'function'
    ? (origin as HTMLElement)
    : null;
}

function deepActiveElement(doc: Document): HTMLElement | null {
  let element: Element | null = doc.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element && element !== doc.body ? (element as HTMLElement) : null;
}

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

  const onDocFocusIn = (event: FocusEvent): void => {
    if (!event.composedPath().includes(scope)) lastOutside = deepTarget(event);
  };

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
