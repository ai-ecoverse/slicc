/**
 * "Is the user typing right now?" — asked by surfaces an AGENT can open (the
 * permission prompt, the `request_secret` dialog) before they move the focus.
 *
 * Agents act while the user types. A dialog that focuses its first control on
 * open takes the caret mid-sentence: the rest of the sentence lands in that
 * control (a secret field), and a Space or Enter lands on its button (a Grant
 * button). So a surface opened from the background checks this first and, when
 * it is true, leaves the focus where the user put it.
 */

/** Input types that take no typed text — focus on one of these is not typing. */
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

/** What actually has the focus, piercing open shadow roots. */
export function deepFocus(doc: Document): Element | null {
  let element: Element | null = doc.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

/** Whether `element` takes typed text: a text field, a textarea, or contenteditable. */
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

/**
 * The element the user is typing into, piercing shadow roots (the composer's
 * `<textarea>` sits inside one, where `document.activeElement` reads as the
 * host) and same-origin frames (a sprinkle's own fields) — or `null` when
 * nothing typable holds the focus.
 *
 * A focused frame whose document cannot be read (cross-origin) counts as
 * typing: nothing out here can tell, and the cost of guessing wrong is a
 * keystroke on someone else's button.
 */
export function typingElement(doc: Document): Element | null {
  const focused = deepFocus(doc);
  if (focused?.tagName === 'IFRAME' || focused?.tagName === 'FRAME') {
    let inner: Document | null = null;
    try {
      inner = (focused as HTMLIFrameElement).contentDocument;
    } catch {
      /* cross-origin — unreadable */
    }
    return inner ? typingElement(inner) : focused;
  }
  return isTypable(focused) ? focused : null;
}
