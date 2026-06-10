import { Monitor, Upload } from 'lucide';
import { createLogger } from '../../core/logger.js';
import { createLucideIcon, type IconNode } from '../create-lucide-icon.js';
import { type AddItem, referenceKindLabel } from './add-item.js';
import type { AddSearchAggregator } from './search-providers.js';

const log = createLogger('add-menu');
const PER_KIND_LIMIT = 6;
const DEBOUNCE_MS = 120;

export interface AddMenuOptions {
  composer: HTMLElement;
  toggleButton: HTMLButtonElement;
  aggregator: AddSearchAggregator;
  onAttachFiles(files: File[] | FileList): void;
  onAddReference(item: AddItem): void;
  captureScreenshot(): Promise<File | null>;
  /** Called when the user chooses "Upload from this computer". */
  requestUpload?(): void;
  onClose?(): void;
}

export class AddMenu {
  private readonly panel: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly list: HTMLElement;
  private open_ = false;

  private readonly onComposerDragOver = (e: DragEvent): void => {
    if (this.open_) e.preventDefault();
  };

  private readonly onComposerDrop = (e: DragEvent): void => {
    if (!this.open_) return;
    e.preventDefault();
    if (e.dataTransfer?.files?.length) {
      this.opts.onAttachFiles(e.dataTransfer.files);
      this.close();
    }
  };

  private readonly onSearchKeydown = (e: KeyboardEvent): void => {
    if (this.handleKey(e)) e.preventDefault();
  };

  private readonly onDocumentMousedown = (e: MouseEvent): void => {
    if (!this.open_) return;
    const target = e.target as Node | null;
    if (this.panel.contains(target) || this.opts.toggleButton.contains(target)) return;
    this.close();
  };

  private results: AddItem[] = [];
  private highlight = 0;
  private actionElems: { el: HTMLElement; run: () => void }[] = [];
  private actionHighlight = -1;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listId = `add-menu-list-${Math.random().toString(36).slice(2, 9)}`;

  constructor(private readonly opts: AddMenuOptions) {
    this.panel = document.createElement('div');
    this.panel.className = 'add-menu';
    this.panel.style.display = 'none';

    this.search = document.createElement('input');
    this.search.className = 'add-menu__search';
    this.search.type = 'text';
    this.search.placeholder = 'Search files, skills, conversations…';
    this.search.setAttribute('aria-label', 'Search files, skills, conversations');
    this.search.setAttribute('aria-controls', this.listId);

    this.list = document.createElement('div');
    this.list.id = this.listId;
    this.list.className = 'add-menu__list';
    this.list.setAttribute('role', 'listbox');

    this.panel.append(this.list, this.search);
    this.opts.composer.appendChild(this.panel);

    this.search.addEventListener('input', () => this.scheduleSearch());
    // `open()` focuses the search input, so Arrow/Enter/Escape land here —
    // not on the composer textarea whose keydown handler also calls
    // `handleKey`. Without this listener, result navigation and selection
    // would be dead while the menu is open.
    this.search.addEventListener('keydown', this.onSearchKeydown);
    this.opts.composer.addEventListener('dragover', this.onComposerDragOver);
    this.opts.composer.addEventListener('drop', this.onComposerDrop);
    document.addEventListener('mousedown', this.onDocumentMousedown);
  }

  isOpen(): boolean {
    return this.open_;
  }

  open(): void {
    this.open_ = true;
    this.panel.style.display = 'block';
    this.opts.composer.classList.add('composer--add-open');
    this.search.value = '';
    this.highlight = 0;
    this.renderActionsAndDefault();
    this.search.focus();
  }

  close(): void {
    this.open_ = false;
    this.panel.style.display = 'none';
    this.opts.composer.classList.remove('composer--add-open');
    this.list.innerHTML = '';
    this.results = [];
    this.actionElems = [];
    this.actionHighlight = -1;
    this.search.removeAttribute('aria-activedescendant');
    this.opts.onClose?.();
  }

  handleKey(event: KeyboardEvent): boolean {
    if (!this.open_) return false;
    switch (event.key) {
      case 'Escape':
        this.close();
        return true;
      case 'ArrowDown':
        return this.navigateResults(1);
      case 'ArrowUp':
        return this.navigateResults(-1);
      case 'Enter':
        if (this.results.length) {
          this.pick(this.results[this.highlight]);
          return true;
        }
        if (this.actionHighlight >= 0 && this.actionHighlight < this.actionElems.length) {
          this.actionElems[this.actionHighlight].run();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.search.removeEventListener('keydown', this.onSearchKeydown);
    this.opts.composer.removeEventListener('dragover', this.onComposerDragOver);
    this.opts.composer.removeEventListener('drop', this.onComposerDrop);
    document.removeEventListener('mousedown', this.onDocumentMousedown);
    this.actionElems = [];
    this.panel.remove();
  }

  private navigateResults(direction: 1 | -1): boolean {
    if (this.results.length > 0) {
      this.highlight = (this.highlight + direction + this.results.length) % this.results.length;
      this.renderResults();
      return true;
    }
    if (this.actionElems.length > 0) {
      const len = this.actionElems.length;
      this.actionHighlight =
        this.actionHighlight < 0
          ? direction === 1
            ? 0
            : len - 1
          : (this.actionHighlight + direction + len) % len;
      this.applyActionHighlight();
      return true;
    }
    return false;
  }

  private applyActionHighlight(): void {
    for (let i = 0; i < this.actionElems.length; i++) {
      this.actionElems[i].el.classList.toggle(
        'add-menu__action--active',
        i === this.actionHighlight
      );
    }
    const active = this.actionElems[this.actionHighlight]?.el;
    if (active?.id) {
      this.search.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView?.({ block: 'nearest' });
    } else {
      this.search.removeAttribute('aria-activedescendant');
    }
  }

  private scheduleSearch(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const query = this.search.value.trim();
    if (!query) {
      this.renderActionsAndDefault();
      return;
    }
    this.debounceTimer = setTimeout(() => void this.runSearch(query), DEBOUNCE_MS);
  }

  private async runSearch(query: string): Promise<void> {
    let items: AddItem[] = [];
    try {
      items = await this.opts.aggregator.search(query, PER_KIND_LIMIT);
    } catch (err) {
      log.warn('Add-menu search failed', { error: String(err) });
    }
    log.debug('runSearch', { query, resultCount: items.length });
    if (this.search.value.trim() !== query) return;
    this.actionElems = [];
    this.actionHighlight = -1;
    this.results = items;
    this.highlight = 0;
    if (items.length === 0) {
      this.renderEmpty(query);
      return;
    }
    this.renderResults();
  }

  private renderEmpty(query: string): void {
    this.list.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'add-menu__empty';
    empty.textContent = `No matches for "${query}".`;
    this.list.appendChild(empty);
  }

  private renderActionsAndDefault(): void {
    this.results = [];
    this.actionElems = [];
    this.actionHighlight = -1;
    this.list.innerHTML = '';
    this.search.removeAttribute('aria-activedescendant');
    const actions: { icon: IconNode; label: string; sub?: string; run: () => void }[] = [
      {
        icon: Upload as unknown as IconNode,
        label: 'Upload from this computer',
        sub: 'Drag & drop or click to browse',
        run: () => this.opts.requestUpload?.(),
      },
      {
        icon: Monitor as unknown as IconNode,
        label: 'Take a screenshot',
        run: () => void this.runCapture(this.opts.captureScreenshot),
      },
    ];
    actions.forEach((a, i) => {
      const el = document.createElement('div');
      el.className = 'add-menu__action';
      el.id = `${this.listId}-act-${i}`;
      el.setAttribute('role', 'option');

      el.appendChild(createLucideIcon(a.icon, 18));

      const text = document.createElement('span');
      text.className = 'add-menu__action-text';
      const label = document.createElement('span');
      label.className = 'add-menu__action-label';
      label.textContent = a.label;
      text.appendChild(label);
      if (a.sub) {
        const sub = document.createElement('span');
        sub.className = 'add-menu__action-sub';
        sub.textContent = a.sub;
        text.appendChild(sub);
      }
      el.appendChild(text);

      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        a.run();
      });
      this.actionElems.push({ el, run: a.run });
      this.list.appendChild(el);
    });
  }

  private async runCapture(fn: () => Promise<File | null>): Promise<void> {
    let file: File | null;
    try {
      file = await fn();
    } catch (err) {
      log.warn('Screenshot capture threw unexpectedly', { error: String(err) });
      file = null;
    }
    if (file) {
      this.opts.onAttachFiles([file]);
      this.close();
    } else {
      const note = document.createElement('div');
      note.className = 'add-menu__empty';
      note.textContent = 'Capture cancelled or unavailable.';
      this.list.prepend(note);
    }
  }

  private renderResults(): void {
    this.list.innerHTML = '';
    this.results.forEach((item, i) => {
      const el = this.buildResultItem(item, i === this.highlight);
      el.id = `${this.listId}-opt-${i}`;
      this.list.appendChild(el);
    });
    const active = this.list.querySelector<HTMLElement>('.add-menu__item--active');
    active?.scrollIntoView?.({ block: 'nearest' });
    if (active?.id) {
      this.search.setAttribute('aria-activedescendant', active.id);
    } else {
      this.search.removeAttribute('aria-activedescendant');
    }
  }

  private buildResultItem(item: AddItem, isActive: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = 'add-menu__item';
    if (isActive) el.classList.add('add-menu__item--active');
    el.setAttribute('role', 'option');

    const label = document.createElement('span');
    label.className = 'add-menu__item-label';
    label.textContent = item.label;
    el.appendChild(label);

    const kind = document.createElement('span');
    kind.className = 'add-menu__item-kind';
    kind.textContent = referenceKindLabel(item.kind);
    el.appendChild(kind);

    if (item.sublabel) {
      const sub = document.createElement('span');
      sub.className = 'add-menu__item-sub';
      sub.textContent = item.sublabel;
      el.appendChild(sub);
    }

    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.pick(item);
    });
    return el;
  }

  private pick(item: AddItem): void {
    this.opts.onAddReference(item);
    this.close();
  }
}
