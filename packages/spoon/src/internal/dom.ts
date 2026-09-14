export type HChild = Node | string | number | null | undefined | false;

export interface HProps {
  class?: string;
  part?: string;
  style?: string;

  [name: string]: string | number | boolean | null | undefined;
}

export function append(parent: ParentNode, children: readonly HChild[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    parent.append(
      typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c
    );
  }
}

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

export function frag(...children: HChild[]): DocumentFragment {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export function sheet(css: string): CSSStyleSheet {
  const s = new CSSStyleSheet();
  s.replaceSync(css);
  return s;
}
