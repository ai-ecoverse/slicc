/**
 * Browser Panel — shows screenshots from CDP browser control.
 *
 * Displays base64 PNG images and the URL of the page.
 */

export class BrowserPanel {
  private container: HTMLElement;
  private bodyEl!: HTMLElement;
  private imgEl: HTMLImageElement | null = null;
  private placeholderEl!: HTMLElement;
  private urlEl!: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  /** Update the displayed screenshot. */
  setScreenshot(base64: string, url?: string): void {
    if (!this.imgEl) {
      this.imgEl = document.createElement('img');
      this.imgEl.alt = 'Browser screenshot';
      this.bodyEl.innerHTML = '';
      this.bodyEl.appendChild(this.imgEl);
    }
    this.imgEl.src = `data:image/png;base64,${base64}`;

    if (url) {
      this.urlEl.textContent = url;
      this.urlEl.title = url;
    }

    this.placeholderEl.style.display = 'none';
  }

  /** Clear the screenshot. */
  clear(): void {
    if (this.imgEl) {
      this.imgEl.remove();
      this.imgEl = null;
    }
    this.placeholderEl.style.display = '';
    this.urlEl.textContent = '';
  }

  private render(): void {
    this.container.innerHTML = '';
    this.container.classList.add('browser-panel');

    const header = document.createElement('div');
    header.className = 'panel-header';
    header.style.gap = '8px';

    const label = document.createElement('span');
    label.textContent = 'Browser';
    header.appendChild(label);

    this.urlEl = document.createElement('span');
    this.urlEl.style.cssText =
      'font-weight: 400; color: #7b8cff; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;';
    header.appendChild(this.urlEl);
    this.container.appendChild(header);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'browser-panel__body';

    this.placeholderEl = document.createElement('div');
    this.placeholderEl.className = 'browser-panel__placeholder';
    this.placeholderEl.textContent = 'No screenshot yet. The agent will capture browser screenshots here.';
    this.bodyEl.appendChild(this.placeholderEl);

    this.container.appendChild(this.bodyEl);
  }

  /** Dispose the panel. */
  dispose(): void {
    this.container.innerHTML = '';
  }
}
