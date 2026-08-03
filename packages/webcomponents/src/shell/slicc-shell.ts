import { define } from '../internal/define.js';

/**
 * Scoped, document-level stylesheet for `<slicc-shell>`. Light-DOM hosts can't
 * carry an inline `<style>` in a shadow root, so the chrome is injected once
 * and scoped by the `.slicc-shell` host class.
 *
 * The shell is a flat flex row: the dock-tree (permanently full-span — the
 * sole layout host, containing chat and every panel as independent leaves)
 * beside the fixed 48px dock rail. Children are matched by tag
 * (`slicc-dock-tree` / `slicc-dock`) and by the prototype class names
 * (`.dock-tree` / `.dock`) for plain-markup hosts.
 */
const STYLE = `
.slicc-shell { display: flex; flex: 1; min-height: 0; }
.slicc-shell > slicc-dock-tree,
.slicc-shell > .dock-tree {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}
/* Pin the dock to its full 48px basis. This selector outranks the dock's own
   "flex: 0 0 48px" rule, so an "auto" basis here would collapse the rail to its
   ~35px icon-content width and leave a bare-shader strip down the right edge. */
.slicc-shell > slicc-dock,
.slicc-shell > .dock { flex: 0 0 48px; }
`;

const STYLE_ID = 'slicc-shell-style';

/** Inject the scoped shell stylesheet into a document once (idempotent). */
function ensureShellStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * `<slicc-shell>` — the top-level flex row laying out the dock-tree (the sole
 * layout host — chat and every panel are independent leaves within it) beside
 * the right dock rail (composed BY TAG as `<slicc-dock-tree>`, `<slicc-dock>`).
 *
 * Light DOM (no shadow root): the host IS the flex row; its children lay out
 * in DOM order.
 *
 * @csspart shell - the host row (also styleable via the element itself)
 * @slot - default; `<slicc-dock-tree>`, `<slicc-dock>` by tag
 */
export class SliccShell extends HTMLElement {
  connectedCallback(): void {
    ensureShellStyle(this.ownerDocument);
    this.classList.add('slicc-shell');
    this.setAttribute('part', 'shell');
  }

  /** The composed dock-tree, if present. */
  get dockTree(): HTMLElement | null {
    return this.querySelector(':scope > slicc-dock-tree, :scope > .dock-tree');
  }

  /** The composed dock rail, if present. */
  get dock(): HTMLElement | null {
    return this.querySelector(':scope > slicc-dock, :scope > .dock');
  }
}

define('slicc-shell', SliccShell);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-shell': SliccShell;
  }
}
