/**
 * File-tree action wiring: hover buttons (CAT preview, DL download, ZIP download)
 * and keyboard copy-path (Cmd/Ctrl+C). App-specific behaviors that belong in the
 * webapp layer, not in the generic `<slicc-file-tree>` WC.
 *
 * Buttons are injected into a `.ft-acts` container on `pointerover` and removed
 * on `pointerout`. `replaceChildren` in the tree's render cycle destroys them,
 * so they're always re-injected fresh.
 */

import type { SliccFileTree } from '@slicc/webcomponents';
import { zipSync } from 'fflate';
import { isTerminalPreviewableMediaPath } from '../../core/mime-types.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';

export interface FileActionDeps {
  fileTree: SliccFileTree;
  openFs(): Promise<LocalVfsClient>;
  /** Switch the workbench to the named surface (e.g. 'term'). */
  activateSurface(surfaceId: string): void;
}

/** Shell-escape a path with single quotes. */
function q(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/** Recursively collect all files under a VFS dir as { relPath: Uint8Array }. */
async function collectFiles(
  fs: LocalVfsClient,
  dir: string,
  prefix: string
): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  let entries;
  try {
    entries = await fs.readDir(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = `${dir}/${e.name}`;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.type === 'directory') {
      Object.assign(out, await collectFiles(fs, full, rel));
    } else {
      try {
        const content = await fs.readFile(full, { encoding: 'binary' });
        out[rel] = content instanceof Uint8Array ? content : new TextEncoder().encode(content);
      } catch {
        // skip unreadable files
      }
    }
  }
  return out;
}

function makeActionBtn(label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'ft-act';
  btn.textContent = label;
  return btn;
}

function makeActsContainer(): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'ft-acts';
  return div;
}

/** Trigger a browser download of bytes with the given filename. */
function downloadBytes(
  bytes: Uint8Array,
  filename: string,
  mime = 'application/octet-stream'
): void {
  // new Uint8Array(typed) copies into a plain ArrayBuffer, satisfying Blob's BlobPart constraint.
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Switch to the terminal surface and run a command, waiting up to 3 s for the
 * terminal view to mount (it's lazily initialised on first activation).
 */
async function runInTerminal(cmd: string, activateSurface: (id: string) => void): Promise<void> {
  activateSurface('term');
  for (let i = 0; i < 30; i++) {
    const tv = (globalThis as Record<string, unknown>).__slicc_terminal_view as
      | { executeCommandInTerminal(cmd: string): unknown }
      | undefined;
    if (tv) {
      tv.executeCommandInTerminal(cmd);
      return;
    }
    await new Promise<void>((r) => setTimeout(r, 100));
  }
}

/**
 * Wire hover action buttons and Cmd+C copy-path onto the file tree.
 * Returns a dispose function that cleans up all listeners.
 */
export function wireFileTreeActions(deps: FileActionDeps): () => void {
  const { fileTree, openFs, activateSurface } = deps;

  let selectedPath: string | null = null;

  const onFileSelect = (e: Event): void => {
    const detail = (e as CustomEvent<{ id: string; path: string }>).detail;
    selectedPath = detail?.path ?? null;
    // Clear tabIndex on any previously focused row.
    for (const r of fileTree.querySelectorAll<HTMLElement>('.f[tabindex]')) {
      r.removeAttribute('tabindex');
    }
    // Make the selected row focusable and focus it so keydown bubbles to our listener.
    if (detail?.id) {
      for (const r of fileTree.querySelectorAll<HTMLElement>('.f')) {
        if (r.dataset.id === detail.id) {
          r.tabIndex = 0;
          r.focus({ preventScroll: true });
          break;
        }
      }
    }
  };

  // --- Hover action buttons ---

  const onPointerOver = (e: PointerEvent): void => {
    const target = e.target as HTMLElement | null;

    // File row: CAT + DL buttons
    const fileRow = target?.closest<HTMLElement>('.f');
    if (fileRow && fileTree.contains(fileRow) && !fileRow.querySelector('.ft-acts')) {
      const path = fileRow.dataset.id;
      if (!path) return;
      const filename = path.split('/').pop() ?? path;
      const acts = makeActsContainer();

      const catBtn = makeActionBtn(isTerminalPreviewableMediaPath(path) ? 'IMGCAT' : 'CAT');
      catBtn.title = 'Preview in terminal';
      catBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const cmd = isTerminalPreviewableMediaPath(path) ? `imgcat ${q(path)}` : `cat ${q(path)}`;
        void runInTerminal(cmd, activateSurface);
      });

      const dlBtn = makeActionBtn('DL');
      dlBtn.title = 'Download file';
      dlBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void openFs()
          .then(async (fs) => {
            const content = await fs.readFile(path, { encoding: 'binary' });
            const bytes =
              content instanceof Uint8Array ? content : new TextEncoder().encode(content);
            downloadBytes(bytes, filename);
          })
          .catch(console.error);
      });

      acts.append(catBtn, dlBtn);
      fileRow.appendChild(acts);
    }

    // Dir row: ZIP button
    const dirRow = target?.closest<HTMLElement>('.dir');
    if (dirRow && fileTree.contains(dirRow) && !dirRow.querySelector('.ft-acts')) {
      const dirPath = dirRow.dataset.dirId;
      const dirName = dirPath?.split('/').pop() ?? 'archive';
      if (!dirPath) return;
      const acts = makeActsContainer();
      const zipBtn = makeActionBtn('ZIP');
      zipBtn.title = 'Download as ZIP';
      zipBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void openFs()
          .then(async (fs) => {
            const files = await collectFiles(fs, dirPath, '');
            const zipped = zipSync(files);
            downloadBytes(zipped, `${dirName}.zip`, 'application/zip');
          })
          .catch(console.error);
      });
      acts.append(zipBtn);
      dirRow.appendChild(acts);
    }
  };

  const onPointerOut = (e: PointerEvent): void => {
    const target = e.target as HTMLElement | null;
    const related = e.relatedTarget as HTMLElement | null;
    const row = target?.closest<HTMLElement>('.f,.dir');
    if (!row || !fileTree.contains(row)) return;
    // Keep buttons while the pointer is still inside the row (e.g. moving to a button).
    if (related && row.contains(related)) return;
    row.querySelector('.ft-acts')?.remove();
  };

  // --- Cmd/Ctrl+C copy path ---

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'c') return;
    if (!selectedPath) return;
    if (window.getSelection()?.isCollapsed === false) return;
    e.preventDefault();
    navigator.clipboard.writeText(selectedPath).then(() => {
      const sel = fileTree.getAttribute('selected');
      if (!sel) return;
      for (const r of fileTree.querySelectorAll<HTMLElement>('.f')) {
        if (r.dataset.id === sel) {
          r.classList.add('ft-copy-flash');
          setTimeout(() => r.classList.remove('ft-copy-flash'), 300);
          break;
        }
      }
    }, console.warn);
  };

  fileTree.addEventListener('file-select', onFileSelect);
  fileTree.addEventListener('pointerover', onPointerOver);
  fileTree.addEventListener('pointerout', onPointerOut);
  fileTree.addEventListener('keydown', onKeyDown);

  return (): void => {
    fileTree.removeEventListener('file-select', onFileSelect);
    fileTree.removeEventListener('pointerover', onPointerOver);
    fileTree.removeEventListener('pointerout', onPointerOut);
    fileTree.removeEventListener('keydown', onKeyDown);
  };
}
