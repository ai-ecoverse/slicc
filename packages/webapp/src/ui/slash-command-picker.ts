export interface SlashCommandPickerItem {
  name: string;
  description?: string;
  kind: 'action' | 'skill' | 'submenu';
}

export interface SlashCommandPickerOptions {
  anchor: HTMLElement;
  /** Called when the user accepts an item (Enter / Tab / click). */
  onAccept(item: SlashCommandPickerItem): void;
  onDismiss(): void;
}

export class SlashCommandPicker {
  private readonly root: HTMLElement;
  private items: SlashCommandPickerItem[] = [];
  private highlight = 0;
  private visible = false;

  constructor(private readonly opts: SlashCommandPickerOptions) {
    this.root = document.createElement('div');
    this.root.className = 'slash-picker';
    this.root.style.display = 'none';
    this.root.setAttribute('role', 'listbox');
    document.body.appendChild(this.root);
  }

  show(items: SlashCommandPickerItem[]): void {
    if (items.length === 0) {
      this.hide();
      this.opts.onDismiss();
      return;
    }
    this.items = items;
    this.highlight = 0;
    this.render();
    this.position();
    this.root.style.display = 'block';
    this.visible = true;
  }

  hide(): void {
    this.root.style.display = 'none';
    this.root.innerHTML = '';
    this.items = [];
    this.visible = false;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Returns true if the event was consumed. */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.visible) return false;
    switch (event.key) {
      case 'ArrowDown':
        this.highlight = (this.highlight + 1) % this.items.length;
        this.render();
        return true;
      case 'ArrowUp':
        this.highlight = (this.highlight - 1 + this.items.length) % this.items.length;
        this.render();
        return true;
      case 'Enter':
        this.opts.onAccept(this.items[this.highlight]);
        return true;
      case 'Tab':
        this.opts.onAccept(this.items[this.highlight]);
        return true;
      case 'Escape':
        this.hide();
        this.opts.onDismiss();
        return true;
      default:
        return false;
    }
  }

  dispose(): void {
    this.root.remove();
  }

  private render(): void {
    this.root.innerHTML = '';
    let activeEl: HTMLElement | null = null;
    this.items.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'slash-picker__item';
      if (i === this.highlight) {
        el.classList.add('slash-picker__item--active');
        activeEl = el;
      }
      el.setAttribute('role', 'option');

      const label = document.createElement('span');
      label.className = 'slash-picker__label';
      label.textContent = `/${item.name}`;
      el.appendChild(label);

      if (item.description) {
        const desc = document.createElement('span');
        desc.className = 'slash-picker__desc';
        desc.textContent = item.description;
        el.appendChild(desc);
      }

      if (item.kind === 'skill') {
        const kindHint = document.createElement('span');
        kindHint.className = 'slash-picker__kind';
        kindHint.textContent = 'skill';
        el.appendChild(kindHint);
      }

      // mousedown not click — fires before the anchor loses focus
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.opts.onAccept(item);
      });

      this.root.appendChild(el);
    });
    // Keep the highlighted row visible when navigating past the fold.
    // Guarded: scrollIntoView is unimplemented in jsdom (test env).
    (activeEl as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  }

  private position(): void {
    const rect = this.opts.anchor.getBoundingClientRect();
    this.root.style.position = 'fixed';
    this.root.style.left = `${rect.left}px`;
    this.root.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    this.root.style.minWidth = `${Math.min(rect.width, 320)}px`;
    this.root.style.maxWidth = '480px';
  }
}
