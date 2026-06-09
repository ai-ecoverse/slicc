/**
 * Tiny hyperscript DOM builder — the innerHTML-free way to construct component
 * markup. Text/number children become text nodes (escaped by the DOM), so there
 * is NO HTML-injection surface: no component sets `.innerHTML`. Use `iconEl()`
 * (icons.ts) for lucide glyphs, never an icon string.
 */

/** A child accepted by {@link h}: a node, a string/number (→ text node), or nothing. */
export type HChild = Node | string | number | null | undefined | false;

/** Props for {@link h}: `class`/`part`/`style` plus any attribute. */
export interface HProps {
  class?: string;
  part?: string;
  style?: string;
  // `true` → boolean attr; `false`/null/undefined → omitted; else stringified.
  [name: string]: string | number | boolean | null | undefined;
}

/** Append children to a parent; strings/numbers become escaped text nodes. */
export function append(parent: ParentNode, children: readonly HChild[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    parent.append(
      typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c
    );
  }
}

/** Create an element with attributes + children — no innerHTML. */
export function h(tag: string, props?: HProps | null, ...children: HChild[]): HTMLElement {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

/** A document fragment holding the given children (strings → text nodes). */
export function frag(...children: HChild[]): DocumentFragment {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/**
 * Build a shared constructable stylesheet from CSS text. Adopt it into a shadow
 * root via `root.adoptedStyleSheets = [sheet(CSS)]` (build once at module scope)
 * — no `<style>` innerHTML, parsed once and shared across instances.
 */
export function sheet(css: string): CSSStyleSheet {
  const s = new CSSStyleSheet();
  s.replaceSync(css);
  return s;
}
