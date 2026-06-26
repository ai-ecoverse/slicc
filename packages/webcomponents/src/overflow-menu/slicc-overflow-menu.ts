import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

export interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  visible?: boolean;
  destructive?: boolean;
}

export interface OverflowMenuOptions {
  anchor: HTMLElement;
  items: MenuItem[];
  context?: any;
}

const STYLE = `
:host {
  position: fixed;
  z-index: 110;
  display: block;
}
.menu {
  min-width: 140px;
  max-width: 200px;
  background: var(--canvas, #fff);
  border: 1px solid var(--line, #e1e1e1);
  border-radius: 8px;
  box-shadow: 0 8px 24px -4px rgba(10,10,10,.2), 0 2px 6px -2px rgba(10,10,10,.12);
  padding: 4px;
  font-family: var(--ui);
  font-size: 13px;
}
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 10px;
  border-radius: 5px;
  color: var(--ink, #131313);
  cursor: pointer;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
  font: inherit;
}
.item:hover {
  background: var(--ghost, rgba(0,0,0,.05));
}
.item.destructive {
  color: var(--red, #e53e3e);
}
`;
const SHEET = sheet(STYLE);

let activeInstance: SliccOverflowMenu | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;
let clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

export class SliccOverflowMenu extends HTMLElement {
  #root: ShadowRoot;
  #context: any = undefined;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#root.addEventListener('click', this.#onItemClick);
  }

  disconnectedCallback(): void {
    this.#root.removeEventListener('click', this.#onItemClick);
  }

  #onItemClick = (e: Event): void => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;
    const action = target.dataset.action!;
    this.dispatchEvent(
      new CustomEvent('overflow-action', {
        bubbles: true,
        composed: true,
        detail: { action, context: this.#context },
      })
    );
    SliccOverflowMenu.hide();
  };

  static show(opts: OverflowMenuOptions): void {
    SliccOverflowMenu.hide();
    const el = document.createElement('slicc-overflow-menu') as SliccOverflowMenu;
    el.#context = opts.context;

    const visibleItems = opts.items.filter((i) => i.visible !== false);
    const menuDiv = h('div', { class: 'menu' });
    for (const item of visibleItems) {
      const cls = item.destructive ? 'item destructive' : 'item';
      const btn = h('button', { class: cls, 'data-action': item.id }, item.label);
      menuDiv.appendChild(btn);
    }
    el.#root.appendChild(menuDiv);

    document.body.appendChild(el);
    activeInstance = el;

    const rect = opts.anchor.getBoundingClientRect();
    const menuRect = el.getBoundingClientRect();
    let top = rect.bottom + 4;
    if (top + menuRect.height > window.innerHeight) {
      top = rect.top - menuRect.height - 4;
    }
    let left = rect.right - menuRect.width;
    if (left < 4) left = rect.left;
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;

    escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') SliccOverflowMenu.hide();
    };
    clickOutsideHandler = (e: MouseEvent) => {
      if (!el.contains(e.target as Node) && e.target !== opts.anchor) {
        SliccOverflowMenu.hide();
      }
    };
    document.addEventListener('keydown', escapeHandler);
    setTimeout(() => document.addEventListener('click', clickOutsideHandler!), 0);
  }

  static hide(): void {
    if (activeInstance) {
      activeInstance.remove();
      activeInstance = null;
    }
    if (escapeHandler) {
      document.removeEventListener('keydown', escapeHandler);
      escapeHandler = null;
    }
    if (clickOutsideHandler) {
      document.removeEventListener('click', clickOutsideHandler);
      clickOutsideHandler = null;
    }
  }
}

define('slicc-overflow-menu', SliccOverflowMenu);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-overflow-menu': SliccOverflowMenu;
  }
}
