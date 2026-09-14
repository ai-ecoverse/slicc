import { define } from '../internal/define.js';

import './slicc-dock-item.js';
import { append, h } from '../internal/dom.js';

export interface DockItemDescriptor {
  id: string;

  icon?: string;

  label?: string;

  kind?: 'sprinkle' | 'tool';

  hue?: string;
}

export interface DockSelectDetail {
  id: string;

  kind: 'sprinkle' | 'tool';
}

export interface DockCollapseDetail {
  id: string;
}

const SYSTEM_TOOLS: readonly DockItemDescriptor[] = [
  { id: 'browser', icon: 'globe', label: 'Browser · CDP', kind: 'tool' },
  { id: 'files', icon: 'folder', label: 'Files · VFS', kind: 'tool' },
  { id: 'term', icon: 'square-terminal', label: 'Terminal', kind: 'tool' },
  { id: 'memory', icon: 'brain', label: 'Memory', kind: 'tool' },
  { id: 'monitor', icon: 'activity', label: 'Monitor', kind: 'tool' },
] as const;

const STYLE = `
.slicc-dock {
  flex: 0 0 48px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  background: color-mix(in srgb, var(--ctx) 12%, var(--bg));
  border-left: 1px solid var(--line);
  padding: 10px 0;
  position: relative;
  z-index: 2;
}
.slicc-dock .div {
  width: 22px;
  height: 1px;
  background: var(--line);
  margin: 2px 0;
}
.slicc-dock .grow { flex: 1; }
`;

const STYLE_ID = 'slicc-dock-style';

function ensureDockStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function normalizeKind(value: string | null | undefined): 'sprinkle' | 'tool' {
  return value === 'sprinkle' ? 'sprinkle' : 'tool';
}

export class SliccDock extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['active', 'system-tools'];
  }

  #items: DockItemDescriptor[] = [];
  #onSelect: ((e: Event) => void) | null = null;
  #onCollapse: ((e: Event) => void) | null = null;
  #onLongpress: ((e: Event) => void) | null = null;
  #initialized = false;

  connectedCallback(): void {
    ensureDockStyle(this.ownerDocument);
    this.classList.add('slicc-dock');
    this.setAttribute('part', 'rail');
    this.setAttribute('role', 'toolbar');
    this.setAttribute('aria-orientation', 'vertical');
    if (!this.#initialized) {
      this.#adoptSlotted();
      this.#initialized = true;
    }
    if (!this.#onSelect) {
      this.#onSelect = (e: Event) => this.#handleChildSelect(e);
      this.#onCollapse = (e: Event) => this.#handleChildCollapse(e);
      this.#onLongpress = (e: Event) => this.#handleChildLongpress(e);
      this.addEventListener('select', this.#onSelect);
      this.addEventListener('collapse', this.#onCollapse);
      this.addEventListener('longpress', this.#onLongpress);
    }
    this.#render();
  }

  disconnectedCallback(): void {
    if (this.#onSelect) {
      this.removeEventListener('select', this.#onSelect);
      this.#onSelect = null;
    }
    if (this.#onCollapse) {
      this.removeEventListener('collapse', this.#onCollapse);
      this.#onCollapse = null;
    }
    if (this.#onLongpress) {
      this.removeEventListener('longpress', this.#onLongpress);
      this.#onLongpress = null;
    }
  }

  attributeChangedCallback(name: string): void {
    if (!this.#initialized) return;
    if (name === 'active') this.#syncActive();
    else if (name === 'system-tools') this.#render();
  }

  get items(): DockItemDescriptor[] {
    return this.#items.map((i) => ({ ...i }));
  }

  set items(value: DockItemDescriptor[]) {
    this.#items = Array.isArray(value) ? value.map((i) => ({ ...i })) : [];
    if (this.#initialized && this.isConnected) this.#render();
  }

  get active(): string | null {
    return this.getAttribute('active');
  }

  set active(value: string | null) {
    if (value == null) this.removeAttribute('active');
    else this.setAttribute('active', value);
  }

  get systemTools(): boolean {
    return this.hasAttribute('system-tools');
  }

  set systemTools(value: boolean) {
    this.toggleAttribute('system-tools', !!value);
  }

  selectItem(id: string): void {
    this.active = id;
    this.dispatchEvent(
      new CustomEvent<DockSelectDetail>('slicc-dock-select', {
        detail: { id, kind: this.#kindFor(id) },
        bubbles: true,
        composed: true,
      })
    );
  }

  clearActive(): void {
    this.active = null;
  }

  collapse(): void {
    const id = this.active;
    this.active = null;
    if (id == null) return;
    this.dispatchEvent(
      new CustomEvent<DockCollapseDetail>('slicc-dock-collapse', {
        detail: { id },
        bubbles: true,
        composed: true,
      })
    );
  }

  #adoptSlotted(): void {
    const els = [...this.querySelectorAll<HTMLElement>('slicc-dock-item')];
    if (els.length === 0) return;
    const adopted: DockItemDescriptor[] = [];
    for (const el of els) {
      const kind = normalizeKind(el.getAttribute('kind'));
      const id = el.getAttribute('item-id') ?? el.dataset.t ?? el.getAttribute('tip') ?? '';
      if (kind === 'tool' || id === '') continue;
      adopted.push({
        id,
        icon: el.getAttribute('icon') ?? undefined,
        label: el.getAttribute('tip') ?? undefined,
        kind: 'sprinkle',
        hue: el.getAttribute('hue') ?? undefined,
      });
    }
    for (const el of els) el.remove();
    if (this.#items.length === 0) this.#items = adopted;
  }

  #kindFor(id: string): 'sprinkle' | 'tool' {
    if (SYSTEM_TOOLS.some((t) => t.id === id)) return 'tool';
    return this.#items.find((i) => i.id === id)?.kind ?? 'tool';
  }

  #itemEl(item: DockItemDescriptor, active: string | null): HTMLElement {
    const id = item.id;
    const kind = normalizeKind(item.kind);
    const icon = item.icon ?? '';
    const label = item.label ?? id;
    const isActive = active != null && active === id;
    const hue = item.hue;
    return h('slicc-dock-item', {
      'data-t': id,
      'item-id': id,
      kind,
      icon: icon || false,
      tip: label,
      hue: hue || false,
      active: isActive,
    });
  }

  #render(): void {
    const active = this.active;
    const nodes: Node[] = [];
    for (const item of this.#items) {
      if (normalizeKind(item.kind) === 'sprinkle') nodes.push(this.#itemEl(item, active));
    }
    nodes.push(h('div', { class: 'grow' }));
    if (this.systemTools) {
      nodes.push(h('div', { class: 'div' }));
      for (const tool of SYSTEM_TOOLS) nodes.push(this.#itemEl(tool, active));
    }
    this.replaceChildren();
    append(this, nodes);
  }

  #syncActive(): void {
    const active = this.active;
    for (const el of this.querySelectorAll<HTMLElement>('slicc-dock-item')) {
      el.toggleAttribute('active', el.dataset.t === active);
    }
  }

  #handleChildSelect(e: Event): void {
    const id = this.#idFromChildEvent(e);
    if (id == null) return;
    e.stopPropagation();
    this.selectItem(id);
  }

  #handleChildCollapse(e: Event): void {
    const id = this.#idFromChildEvent(e);
    if (id == null) return;
    e.stopPropagation();

    if (this.active !== id) this.active = id;
    this.collapse();
  }

  #handleChildLongpress(e: Event): void {
    const id = this.#idFromChildEvent(e);
    if (id == null) return;
    e.stopPropagation();
    if (this.active !== id) this.selectItem(id);
    this.dispatchEvent(
      new CustomEvent<DockSelectDetail>('slicc-dock-longpress', {
        detail: { id, kind: this.#kindFor(id) },
        bubbles: true,
        composed: true,
      })
    );
  }

  #idFromChildEvent(e: Event): string | null {
    const detail = (e as CustomEvent<{ id: string | null }>).detail;
    if (detail && typeof detail.id === 'string') return detail.id;
    const item = (e.target as HTMLElement | null)?.closest<HTMLElement>('slicc-dock-item');
    if (item && this.contains(item)) return item.dataset.t ?? null;
    return null;
  }
}

define('slicc-dock', SliccDock);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-dock': SliccDock;
  }
  interface HTMLElementEventMap {
    'slicc-dock-select': CustomEvent<DockSelectDetail>;
    'slicc-dock-collapse': CustomEvent<DockCollapseDetail>;
    'slicc-dock-longpress': CustomEvent<DockSelectDetail>;
  }
}
