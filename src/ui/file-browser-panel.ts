/**
 * File Browser Panel — displays virtual filesystem contents as a tree.
 *
 * Shows directories and files from the VirtualFS, with expandable
 * folders and auto-refresh every 3 seconds.
 */

import type { VirtualFS } from '../fs/index.js';

/** Format byte size into human-readable string. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'M';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'G';
}

export class FileBrowserPanel {
  private container: HTMLElement;
  private bodyEl!: HTMLElement;
  private fs: VirtualFS | null = null;
  private expandedDirs = new Set<string>(['/']);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  /** Wire up the virtual filesystem. Triggers initial refresh. */
  setFs(fs: VirtualFS): void {
    this.fs = fs;
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), 3000);
  }

  /** Re-read the VFS and update the tree display (only if content changed). */
  async refresh(): Promise<void> {
    if (!this.fs) return;
    const tmp = document.createElement('div');
    try {
      await this.renderDir('/', tmp, 0);
    } catch {
      // FS may not be ready yet
      return;
    }
    // Only touch the DOM if the tree actually changed
    if (tmp.innerHTML === this.bodyEl.innerHTML) return;
    while (this.bodyEl.firstChild) this.bodyEl.removeChild(this.bodyEl.firstChild);
    while (tmp.firstChild) this.bodyEl.appendChild(tmp.firstChild);
  }

  private render(): void {
    // Clear container safely
    while (this.container.firstChild) this.container.removeChild(this.container.firstChild);
    this.container.classList.add('file-browser');

    const header = document.createElement('div');
    header.className = 'panel-header';
    header.textContent = 'Files';
    this.container.appendChild(header);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'file-browser__body';
    this.container.appendChild(this.bodyEl);
  }

  private async renderDir(path: string, parentEl: HTMLElement, depth: number): Promise<void> {
    if (!this.fs) return;

    let entries;
    try {
      entries = await this.fs.readDir(path);
    } catch {
      return;
    }

    // Sort: directories first, then files, alphabetical within each group
    const dirs = entries.filter(e => e.type === 'directory').sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter(e => e.type === 'file').sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of [...dirs, ...files]) {
      const fullPath = path === '/' ? '/' + entry.name : path + '/' + entry.name;
      const row = document.createElement('div');
      row.className = 'file-browser__item';
      row.style.paddingLeft = (12 + depth * 16) + 'px';

      if (entry.type === 'directory') {
        const isExpanded = this.expandedDirs.has(fullPath);
        const arrow = document.createElement('span');
        arrow.className = 'file-browser__arrow';
        arrow.textContent = isExpanded ? '\u25BE' : '\u25B8'; // ▾ or ▸
        row.appendChild(arrow);

        const icon = document.createElement('span');
        icon.className = 'file-browser__icon';
        icon.textContent = '\uD83D\uDCC1'; // 📁
        row.appendChild(icon);

        const name = document.createElement('span');
        name.className = 'file-browser__name';
        name.textContent = entry.name;
        row.appendChild(name);

        row.style.cursor = 'pointer';
        row.addEventListener('click', () => {
          if (this.expandedDirs.has(fullPath)) {
            this.expandedDirs.delete(fullPath);
          } else {
            this.expandedDirs.add(fullPath);
          }
          this.refresh();
        });

        parentEl.appendChild(row);

        if (isExpanded) {
          await this.renderDir(fullPath, parentEl, depth + 1);
        }
      } else {
        // File entry
        const spacer = document.createElement('span');
        spacer.className = 'file-browser__arrow';
        spacer.textContent = ' ';
        row.appendChild(spacer);

        const icon = document.createElement('span');
        icon.className = 'file-browser__icon';
        icon.textContent = '\uD83D\uDCC4'; // 📄
        row.appendChild(icon);

        const name = document.createElement('span');
        name.className = 'file-browser__name';
        name.textContent = entry.name;
        row.appendChild(name);

        // Get file size
        try {
          const stats = await this.fs!.stat(fullPath);
          const size = document.createElement('span');
          size.className = 'file-browser__size';
          size.textContent = formatSize(stats.size);
          row.appendChild(size);
        } catch {
          // stat failed, skip size
        }

        // Click to download
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => this.downloadFile(fullPath, entry.name));

        parentEl.appendChild(row);
      }
    }
  }

  /** Read a file from VFS and trigger a browser download. */
  private async downloadFile(path: string, filename: string): Promise<void> {
    if (!this.fs) return;
    try {
      const content = await this.fs.readFile(path, { encoding: 'binary' });
      const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content);
      const blob = new Blob([bytes.buffer as ArrayBuffer]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // read failed, ignore
    }
  }

  /** Dispose the panel and stop auto-refresh. */
  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    while (this.container.firstChild) this.container.removeChild(this.container.firstChild);
  }
}
