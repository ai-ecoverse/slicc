const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

export function deepFocus(doc: Document): Element | null {
  let element: Element | null = doc.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

export function isTypable(element: Element | null | undefined): boolean {
  if (!element) return false;
  const tag = element.tagName;
  if (tag === 'TEXTAREA') return !(element as HTMLTextAreaElement).readOnly;
  if (tag === 'INPUT') {
    const input = element as HTMLInputElement;
    return !input.readOnly && !NON_TEXT_INPUT_TYPES.has(input.type);
  }
  return (element as HTMLElement).isContentEditable === true;
}

export function typingElement(doc: Document): Element | null {
  const focused = deepFocus(doc);
  if (focused?.tagName === 'IFRAME' || focused?.tagName === 'FRAME') {
    let inner: Document | null = null;
    try {
      inner = (focused as HTMLIFrameElement).contentDocument;
    } catch {}
    return inner ? typingElement(inner) : focused;
  }
  return isTypable(focused) ? focused : null;
}
