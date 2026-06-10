import { createLogger } from '../../core/logger.js';
import type { AddItem } from './add-item.js';
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
  capturePhoto(): Promise<File | null>;
  captureScreenshot(): Promise<File | null>;
}

export class AddMenu {
  private readonly panel: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly list: HTMLElement;
  private open_ = false;
  private results: AddItem[] = [];
  private highlight = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: AddMenuOptions) {
    this.panel = document.createElement('div');
    this.panel.className = 'add-menu';
    this.panel.style.display = 'none';

    this.search = document.createElement('input');
    this.search.className = 'add-menu__search';
    this.search.type = 'text';
    this.search.placeholder = 'Search files, skills, conversations…';

    this.list = document.createElement('div');
    this.list.className = 'add-menu__list';
    this.list.setAttribute('role', 'listbox');

    this.panel.append(this.list, this.search);
    this.opts.composer.appendChild(this.panel);

    this.search.addEventListener('input', () => this.scheduleSearch());
    this.opts.composer.addEventListener('dragover', (e) => {
      if (this.open_) e.preventDefault();
    });
    this.opts.composer.addEventListener('drop', (e) => {
      if (!this.open_) return;
      e.preventDefault();
      if (e.dataTransfer?.files?.length) {
        this.opts.onAttachFiles(e.dataTransfer.files);
        this.close();
      }
    });
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
        return false;
      default:
        return false;
    }
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.panel.remove();
  }

  /** Overridden by the host (ChatPanel) to click the hidden file input. */
  requestUpload: () => void = () => {};

  private navigateResults(direction: 1 | -1): boolean {
    if (!this.results.length) return true;
    this.highlight = (this.highlight + direction + this.results.length) % this.results.length;
    this.renderResults();
    return true;
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
    if (this.search.value.trim() !== query) return;
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
    this.list.innerHTML = '';
    const actions: { label: string; sub: string; run: () => void }[] = [
      {
        label: 'Upload from this computer',
        sub: 'Drag & drop or click to browse',
        run: () => this.requestUpload(),
      },
      { label: 'Take a photo', sub: '', run: () => void this.runCapture(this.opts.capturePhoto) },
      {
        label: 'Take a screenshot',
        sub: '',
        run: () => void this.runCapture(this.opts.captureScreenshot),
      },
    ];
    for (const a of actions) {
      const el = document.createElement('div');
      el.className = 'add-menu__action';
      el.textContent = a.sub ? `${a.label} — ${a.sub}` : a.label;
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        a.run();
      });
      this.list.appendChild(el);
    }
  }

  private async runCapture(fn: () => Promise<File | null>): Promise<void> {
    const file = await fn();
    if (file) {
      this.opts.onAttachFiles([file]);
      this.close();
    } else {
      const note = document.createElement('div');
      note.className = 'add-menu__empty';
      note.textContent = 'Capture cancelled.';
      this.list.prepend(note);
    }
  }

  private renderResults(): void {
    this.list.innerHTML = '';
    this.results.forEach((item, i) => {
      const el = this.buildResultItem(item, i === this.highlight);
      this.list.appendChild(el);
    });
    const active = this.list.querySelector<HTMLElement>('.add-menu__item--active');
    active?.scrollIntoView?.({ block: 'nearest' });
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
    kind.textContent = item.kind;
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
