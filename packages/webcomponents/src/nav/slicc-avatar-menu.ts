import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

export interface AvatarMenuItem {
  id?: string;

  kind?: 'item' | 'separator' | 'caption';

  label?: string;

  icon?: string;

  danger?: boolean;

  disabled?: boolean;
}

export interface AvatarMenuUser {
  name: string;

  provider?: string;
}

export interface AvatarActionDetail {
  id: string;
}

const STYLE = `
:host { display: inline-block; position: relative; font-family: var(--ui); }
.trigger {
  display: inline-flex; align-items: center; justify-content: center;
  border: none; background: transparent; padding: 0; cursor: pointer;
  border-radius: 9999px; line-height: 0;
}
.trigger:focus-visible { outline: 2px solid var(--accent, #3b63fb); outline-offset: 2px; }
/* The dropdown — anchored under the trigger, right-aligned like the prototype nav. */
.pop {
  position: absolute; top: calc(100% + 8px); right: 0; z-index: 50;
  min-width: 220px;
  background: var(--canvas, #fff);
  border: 1px solid var(--line, #e1e1e1);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0,0,0,.12), 0 2px 8px rgba(0,0,0,.08);
  padding: 8px 0;
  opacity: 0; transform: translateY(-4px) scale(.98); transform-origin: top right;
  pointer-events: none; transition: opacity .14s ease, transform .14s ease;
}
:host([open]) .pop { opacity: 1; transform: none; pointer-events: auto; }
.user { padding: 12px 16px; border-bottom: 1px solid var(--line, #e1e1e1); }
.user .name { font-size: 14px; font-weight: 600; color: var(--ink, #131313); }
.user .prov { font-size: 11px; color: var(--txt-3, #717171); margin-top: 2px; }
.cap { padding: 4px 16px 8px; font-size: 11px; color: var(--txt-3, #717171); }
.sep { height: 1px; background: var(--line, #e1e1e1); margin: 4px 0; }
.item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 8px 16px; border: none; background: transparent;
  color: var(--ink, #131313); font: inherit; font-size: 13px;
  cursor: pointer; text-align: left;
  transition: background .12s ease;
}
.item:hover, .item:focus-visible { background: var(--ghost, rgba(0,0,0,.05)); outline: none; }
.item[disabled] { color: var(--txt-3, #717171); cursor: default; }
.item[disabled]:hover { background: transparent; }
.item.danger { color: var(--rose, #f43f5e); }
.item.danger:hover { background: color-mix(in srgb, var(--rose, #f43f5e) 8%, transparent); }
.item .ic { flex: 0 0 auto; display: flex; color: var(--txt-2, #505050); }
.item.danger .ic { color: var(--rose, #f43f5e); }
@media (prefers-reduced-motion: reduce) { .pop { transition: none; } }
`;
const SHEET = sheet(STYLE);

export class SliccAvatarMenu extends HTMLElement {
  static readonly observedAttributes = ['open'];

  readonly #root: ShadowRoot;
  #trigger!: HTMLButtonElement;
  #pop!: HTMLElement;
  #items: AvatarMenuItem[] = [];
  #user: AvatarMenuUser | null = null;

  #onDoc = (e: MouseEvent): void => {
    if (this.open && !e.composedPath().includes(this)) this.hide();
  };
  #onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.open) {
      this.hide();
      this.#trigger.focus();
    }
  };

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
    this.#trigger = h(
      'button',
      {
        class: 'trigger',
        part: 'trigger',
        type: 'button',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
      },
      h('slot')
    ) as HTMLButtonElement;
    this.#pop = h('div', { class: 'pop', part: 'popover', role: 'menu' });
    this.#root.replaceChildren(this.#trigger, this.#pop);
    this.#trigger.addEventListener('click', () => this.toggle());
  }

  connectedCallback(): void {
    this.#renderItems();
  }

  disconnectedCallback(): void {
    document.removeEventListener('mousedown', this.#onDoc);
    document.removeEventListener('keydown', this.#onKey);
  }

  attributeChangedCallback(name: string): void {
    if (name === 'open') {
      const open = this.open;
      this.#trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        document.addEventListener('mousedown', this.#onDoc);
        document.addEventListener('keydown', this.#onKey);
      } else {
        document.removeEventListener('mousedown', this.#onDoc);
        document.removeEventListener('keydown', this.#onKey);
      }
    }
  }

  get open(): boolean {
    return this.hasAttribute('open');
  }
  set open(value: boolean) {
    this.toggleAttribute('open', value);
  }

  get user(): AvatarMenuUser | null {
    return this.#user;
  }
  set user(value: AvatarMenuUser | null) {
    this.#user = value;
    this.#renderItems();
  }

  get items(): AvatarMenuItem[] {
    return this.#items.map((i) => ({ ...i }));
  }
  set items(value: AvatarMenuItem[]) {
    this.#items = Array.isArray(value) ? value.map((i) => ({ ...i })) : [];
    this.#renderItems();
  }

  show(): void {
    if (!this.open) {
      this.open = true;
      this.#emitToggle();
    }
  }
  hide(): void {
    if (this.open) {
      this.open = false;
      this.#emitToggle();
    }
  }
  toggle(): void {
    this.open ? this.hide() : this.show();
  }

  #emitToggle(): void {
    this.dispatchEvent(
      new CustomEvent<{ open: boolean }>('slicc-avatar-menu-toggle', {
        detail: { open: this.open },
        bubbles: true,
        composed: true,
      })
    );
  }

  #renderItems(): void {
    const nodes: HTMLElement[] = [];
    if (this.#user) {
      const user = h('div', { class: 'user' }, h('div', { class: 'name' }, this.#user.name));
      if (this.#user.provider) user.append(h('div', { class: 'prov' }, this.#user.provider));
      nodes.push(user);
    }
    for (const it of this.#items) {
      if (it.kind === 'separator') {
        nodes.push(h('div', { class: 'sep', role: 'separator' }));
      } else if (it.kind === 'caption') {
        nodes.push(h('div', { class: 'cap' }, it.label ?? ''));
      } else {
        const cls = `item${it.danger ? ' danger' : ''}`;
        const btn = h('button', {
          class: cls,
          part: 'item',
          type: 'button',
          role: 'menuitem',
          'data-id': it.id ?? '',
          disabled: it.disabled ? true : undefined,
        });
        if (it.icon) btn.append(h('span', { class: 'ic' }, iconEl(it.icon, { size: 16 })));
        btn.append(h('span', { class: 'lb' }, it.label ?? ''));
        if (!it.disabled) {
          btn.addEventListener('click', () => this.#activate(it.id ?? ''));
        }
        nodes.push(btn);
      }
    }
    this.#pop.replaceChildren(...nodes);
  }

  #activate(id: string): void {
    this.dispatchEvent(
      new CustomEvent<AvatarActionDetail>('slicc-avatar-action', {
        detail: { id },
        bubbles: true,
        composed: true,
      })
    );
    this.hide();
  }
}

define('slicc-avatar-menu', SliccAvatarMenu);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-avatar-menu': SliccAvatarMenu;
  }
  interface HTMLElementEventMap {
    'slicc-avatar-action': CustomEvent<AvatarActionDetail>;
    'slicc-avatar-menu-toggle': CustomEvent<{ open: boolean }>;
  }
}
