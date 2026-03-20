/**
 * File Browser Panel — displays virtual filesystem contents as a tree.
 *
 * Shows directories and files from the VirtualFS, with expandable
 * folders and auto-refresh every 3 seconds.
 */

import type { VirtualFS } from '../fs/index.js';
import { isTerminalPreviewableMediaPath } from '../core/mime-types.js';
import { zipSync } from 'fflate';

/** Format byte size into human-readable string. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'M';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'G';
}

/** Create an S2-style outline SVG icon (14×14, 1.5px stroke). */
function svgFileIcon(paths: string[]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.style.flexShrink = '0';
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** S2 folder icon — open folder outline */
function folderIcon(): SVGSVGElement {
  return svgFileIcon([
    'M2 6V5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6z',
  ]);
}

/** S2 file icon — document outline */
function fileIcon(): SVGSVGElement {
  return svgFileIcon(['M6 2h5l5 5v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z', 'M11 2v5h5']);
}

/** S2 chevron icon for tree disclosure */
function chevronIcon(expanded: boolean): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.style.flexShrink = '0';
  svg.style.transition = 'transform 130ms ease';
  if (expanded) svg.style.transform = 'rotate(90deg)';
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M7 5l5 5-5 5');
  svg.appendChild(path);
  return svg;
}

/** Quote a shell argument with single quotes. */
function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildPreviewCommand(path: string): string {
  const command = isTerminalPreviewableMediaPath(path) ? 'imgcat' : 'cat';
  return `${command} ${quoteShellArg(path)}`;
}

export interface FileBrowserPanelOptions {
  onRunCommand?: (command: string) => Promise<void> | void;
  onClearFilesystem?: () => Promise<void> | void;
}

export class FileBrowserPanel {
  private container: HTMLElement;
  private bodyEl!: HTMLElement;
  private fs: VirtualFS | null = null;
  private expandedDirs = new Set<string>(['/']);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private onRunCommand: ((command: string) => Promise<void> | void) | null;
  private onClearFilesystem: (() => Promise<void> | void) | null;
  private selectedPath: string | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(container: HTMLElement, options: FileBrowserPanelOptions = {}) {
    this.container = container;
    this.onRunCommand = options.onRunCommand ?? null;
    this.onClearFilesystem = options.onClearFilesystem ?? null;
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
    } catch (err) {
      console.warn(
        '[FileBrowser] Refresh failed:',
        err instanceof Error ? err.message : String(err)
      );
      return;
    }
    // Compare BEFORE applying selection (selection attrs would defeat the check)
    if (tmp.innerHTML === this.bodyEl.innerHTML) {
      this.applySelection();
      return;
    }
    const hadFocus = this.container.contains(document.activeElement);
    while (this.bodyEl.firstChild) this.bodyEl.removeChild(this.bodyEl.firstChild);
    while (tmp.firstChild) this.bodyEl.appendChild(tmp.firstChild);
    this.applySelection();
    if (hadFocus && this.selectedPath) {
      const row = this.bodyEl.querySelector('.file-browser__item--selected') as HTMLElement | null;
      row?.focus();
    }
  }

  private render(): void {
    // Clear container safely
    while (this.container.firstChild) this.container.removeChild(this.container.firstChild);
    this.container.classList.add('file-browser');

    // Header toolbar with title + clear button
    if (this.onClearFilesystem) {
      const header = document.createElement('div');
      header.className = 'file-browser__header';
      const title = document.createElement('span');
      title.className = 'file-browser__header-title';
      title.textContent = 'Files';
      header.appendChild(title);

      const clearBtn = document.createElement('button');
      clearBtn.className = 'file-browser__header-btn';
      clearBtn.setAttribute('aria-label', 'Clear filesystem');
      clearBtn.dataset.tooltip = 'Clear filesystem';
      clearBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="m8.249,15.021c-.4,0-.733-.317-.748-.72l-.25-6.5c-.017-.414.307-.763.72-.778.01-.001.021-.001.03-.001.4,0,.733.317.748.72l.25,6.5c.017.414-.307.763-.72.778-.01.001-.021.001-.03.001Z" fill="currentColor"/><path d="m11.751,15.021c-.01,0-.02,0-.03-.001-.413-.016-.736-.364-.72-.778l.25-6.5c.015-.403.348-.72.748-.72.01,0,.02,0,.03.001.413.016.736.364.72.778l-.25,6.5c-.015.403-.348.72-.748.72Z" fill="currentColor"/><path d="m17,4h-3.5v-.75c0-1.24-1.01-2.25-2.25-2.25h-2.5c-1.24,0-2.25,1.01-2.25,2.25v.75h-3.5c-.414,0-.75.336-.75.75s.336.75.75.75h.52l.422,10.342c.048,1.21,1.036,2.158,2.248,2.158h7.619c1.212,0,2.2-.948,2.248-2.158l.422-10.342h.52c.414,0,.75-.336.75-.75s-.336-.75-.75-.75Zm-9-.75c0-.413.337-.75.75-.75h2.5c.413,0,.75.337.75.75v.75h-4v-.75Zm6.56,12.531c-.017.403-.346.719-.75.719h-7.619c-.404,0-.733-.316-.75-.719l-.42-10.281h9.959l-.42,10.281Z" fill="currentColor"/></svg>';
      clearBtn.addEventListener('click', async () => {
        await this.onClearFilesystem?.();
        location.reload();
      });
      header.appendChild(clearBtn);

      this.container.appendChild(header);
    }

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'file-browser__body';
    this.container.appendChild(this.bodyEl);
    this.setupKeydown();
  }

  private async renderDir(path: string, parentEl: HTMLElement, depth: number): Promise<void> {
    if (!this.fs) return;

    let entries;
    try {
      entries = await this.fs.readDir(path);
    } catch (err) {
      console.warn(
        '[FileBrowser] readDir failed:',
        path,
        err instanceof Error ? err.message : String(err)
      );
      return;
    }

    // Sort: directories first, then files, alphabetical within each group
    const dirs = entries
      .filter((e) => e.type === 'directory')
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = entries
      .filter((e) => e.type === 'file')
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of [...dirs, ...files]) {
      const fullPath = path === '/' ? '/' + entry.name : path + '/' + entry.name;
      const row = document.createElement('div');
      row.className = 'file-browser__item';
      row.style.paddingLeft = 12 + depth * 16 + 'px';
      row.dataset.path =
        entry.type === 'directory' && !fullPath.endsWith('/') ? fullPath + '/' : fullPath;

      if (entry.type === 'directory') {
        const isExpanded = this.expandedDirs.has(fullPath);
        const arrow = document.createElement('span');
        arrow.className = 'file-browser__arrow';
        arrow.appendChild(chevronIcon(isExpanded));
        row.appendChild(arrow);

        const icon = document.createElement('span');
        icon.className = 'file-browser__icon';
        icon.appendChild(folderIcon());
        row.appendChild(icon);

        const name = document.createElement('span');
        name.className = 'file-browser__name';
        name.textContent = entry.name;
        row.appendChild(name);

        // Download folder as ZIP button
        const zipBtn = document.createElement('button');
        zipBtn.className = 'file-browser__action-btn';
        zipBtn.style.marginLeft = 'auto';
        zipBtn.textContent = 'ZIP';
        zipBtn.title = 'Download as ZIP';
        zipBtn.addEventListener('click', (e) => {
          e.stopPropagation(); // don't toggle expand
          this.downloadDirAsZip(fullPath, entry.name);
        });
        row.appendChild(zipBtn);

        row.style.cursor = 'pointer';
        row.addEventListener('click', () => {
          this.selectPath(fullPath, 'directory');
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
        row.appendChild(spacer);

        const icon = document.createElement('span');
        icon.className = 'file-browser__icon';
        icon.appendChild(fileIcon());
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
        } catch (err) {
          console.warn(
            '[FileBrowser] stat failed:',
            fullPath,
            err instanceof Error ? err.message : String(err)
          );
        }

        // Preview in terminal button
        const catBtn = document.createElement('button');
        catBtn.className = 'file-browser__action-btn';
        catBtn.style.marginLeft = '8px';
        catBtn.textContent = 'CAT';
        catBtn.title = this.onRunCommand
          ? isTerminalPreviewableMediaPath(fullPath)
            ? 'Preview media in terminal'
            : 'Preview in terminal'
          : 'Terminal unavailable';
        catBtn.disabled = !this.onRunCommand;
        catBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.previewFile(fullPath);
        });
        row.appendChild(catBtn);

        row.addEventListener('click', () => {
          this.selectPath(fullPath, 'file');
        });

        parentEl.appendChild(row);
      }
    }
  }

  /** Recursively collect all files under a directory as { relativePath: Uint8Array }. */
  private async collectFiles(dirPath: string, prefix: string): Promise<Record<string, Uint8Array>> {
    if (!this.fs) return {};
    const files: Record<string, Uint8Array> = {};
    const entries = await this.fs.readDir(dirPath);
    for (const entry of entries) {
      const fullPath = dirPath === '/' ? '/' + entry.name : dirPath + '/' + entry.name;
      const relPath = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.type === 'directory') {
        const subFiles = await this.collectFiles(fullPath, relPath);
        Object.assign(files, subFiles);
      } else {
        const content = await this.fs.readFile(fullPath, { encoding: 'binary' });
        files[relPath] =
          content instanceof Uint8Array ? content : new TextEncoder().encode(content as string);
      }
    }
    return files;
  }

  /** Download a directory as a ZIP file. */
  private async downloadDirAsZip(dirPath: string, dirName: string): Promise<void> {
    if (!this.fs) return;
    try {
      const files = await this.collectFiles(dirPath, '');
      const zipped = zipSync(files);
      const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = dirName + '.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(
        '[FileBrowser] ZIP download failed:',
        dirPath,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /** Run `cat` or `imgcat` for the selected file in the terminal panel. */
  private previewFile(path: string): void {
    if (!this.onRunCommand) return;
    const command = buildPreviewCommand(path);
    void Promise.resolve(this.onRunCommand(command)).catch((err) => {
      console.error(
        '[FileBrowser] Preview command failed:',
        path,
        err instanceof Error ? err.message : String(err)
      );
    });
  }

  private selectPath(fullPath: string, type: 'file' | 'directory'): void {
    this.selectedPath = type === 'directory' && !fullPath.endsWith('/') ? fullPath + '/' : fullPath;
    this.applySelection();
    const row = this.bodyEl.querySelector('.file-browser__item--selected') as HTMLElement | null;
    row?.focus();
  }

  private applySelection(): void {
    const prev = this.bodyEl.querySelector('.file-browser__item--selected');
    if (prev) {
      prev.classList.remove('file-browser__item--selected');
      prev.removeAttribute('tabindex');
    }
    if (!this.selectedPath) return;
    const rows = this.bodyEl.querySelectorAll<HTMLElement>('.file-browser__item');
    for (const row of rows) {
      if (row.dataset.path === this.selectedPath) {
        row.classList.add('file-browser__item--selected');
        row.tabIndex = 0;
        break;
      }
    }
  }

  private setupKeydown(): void {
    this.keydownHandler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'c') return;
      if (!this.selectedPath) return;
      const collapsed = window.getSelection()?.isCollapsed !== false;
      if (!collapsed) return;
      e.preventDefault();
      navigator.clipboard
        .writeText(this.selectedPath)
        .then(() => {
          this.flashCopyFeedback();
        })
        .catch((err) => {
          console.warn(
            '[FileBrowser] Clipboard write failed:',
            err instanceof Error ? err.message : String(err)
          );
        });
    };
    this.container.addEventListener('keydown', this.keydownHandler);
  }

  private flashCopyFeedback(): void {
    const row = this.bodyEl.querySelector('.file-browser__item--selected');
    if (!row) return;
    row.classList.add('file-browser__item--copy-flash');
    setTimeout(() => {
      row.classList.remove('file-browser__item--copy-flash');
    }, 300);
  }

  /** Dispose the panel and stop auto-refresh. */
  dispose(): void {
    if (this.keydownHandler) {
      this.container.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    while (this.container.firstChild) this.container.removeChild(this.container.firstChild);
  }
}
