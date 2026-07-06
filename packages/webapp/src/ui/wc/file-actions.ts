/**
 * File action wiring: connects file-tree hover action events to VFS operations,
 * Quick Look preview, and the overflow menu. Consumed by wc-workbench.ts.
 */

import type { MenuItem } from '@slicc/webcomponents';
import { SliccOverflowMenu, SliccQuickLook } from '@slicc/webcomponents';

import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';

const MIME_MAP: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.ts': 'text/typescript',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

function mimeFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function isPreviewableInBrowser(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return ext === '.html' || ext === '.svg';
}

async function copyFileContent(fs: WritableVfsClient, from: string, to: string): Promise<void> {
  const data = await fs.readFile(from);
  await fs.writeFile(to, data);
}

export interface FileActionDeps {
  fileTree: HTMLElement;
  openFs(): Promise<LocalVfsClient>;
  /** Page-side writer routed through the worker's VfsRpcHost — see writable-vfs-client.ts. */
  openWriter(): Promise<WritableVfsClient>;
  insertReference(path: string): void;
  toPreviewUrl(vfsPath: string): string;
  log: { error(message: string, ...data: unknown[]): void };
}

export function wireFileActions(deps: FileActionDeps): void {
  const { fileTree, openFs, openWriter, insertReference, toPreviewUrl, log } = deps;

  fileTree.addEventListener('file-preview', async (e) => {
    const { path } = (e as CustomEvent<{ id: string; path: string }>).detail;
    try {
      const fs = await openFs();
      const mime = mimeFromPath(path);
      let content: string | ArrayBuffer;
      if (mime.startsWith('text/') || mime === 'application/json') {
        content = (await fs.readFile(path, { encoding: 'utf-8' })) as string;
      } else {
        const raw = (await fs.readFile(path, { encoding: 'binary' })) as Uint8Array;
        const copy = new Uint8Array(raw.length);
        copy.set(raw);
        content = copy.buffer;
      }
      SliccQuickLook.open({ path, content, mimeType: mime });
    } catch (err) {
      log.error('File preview failed', err);
    }
  });

  fileTree.addEventListener('file-reference', (e) => {
    const { path } = (e as CustomEvent<{ id: string; path: string }>).detail;
    insertReference(path);
  });

  fileTree.addEventListener('file-download', async (e) => {
    const { path } = (e as CustomEvent<{ id: string; path: string }>).detail;
    try {
      const fs = await openFs();
      const rawData = (await fs.readFile(path, { encoding: 'binary' })) as Uint8Array;
      const data = new Uint8Array(rawData.length);
      data.set(rawData);
      const filename = path.split('/').pop() || 'download';
      const mime = mimeFromPath(path);
      const blob = new Blob([data], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      log.error('File download failed', err);
    }
  });

  fileTree.addEventListener('file-overflow', (e) => {
    const { path, anchor } = (e as CustomEvent<{ id: string; path: string; anchor: HTMLElement }>)
      .detail;
    const items: MenuItem[] = [
      { id: 'rename', label: 'Rename' },
      { id: 'duplicate', label: 'Duplicate' },
      { id: 'copy-path', label: 'Copy path' },
      {
        id: 'open-browser',
        label: 'Open in browser',
        visible: isPreviewableInBrowser(path),
      },
      { id: 'delete', label: 'Delete', destructive: true },
    ];
    // dispatchTarget: the file tree host outlives the periodic 3s refresh that
    // rebuilds row DOM (and thus `anchor`) out from under a still-open menu.
    SliccOverflowMenu.show({ anchor, items, context: { path }, dispatchTarget: fileTree });
  });

  fileTree.addEventListener('overflow-action', async (e) => {
    const { action, context } = (e as CustomEvent<{ action: string; context: { path: string } }>)
      .detail;
    const { path } = context;
    try {
      switch (action) {
        case 'copy-path':
          await navigator.clipboard.writeText(path);
          break;
        case 'open-browser':
          window.open(toPreviewUrl(path), '_blank');
          break;
        case 'duplicate': {
          const dot = path.lastIndexOf('.');
          const newPath = dot > 0 ? `${path.slice(0, dot)}_copy${path.slice(dot)}` : `${path}_copy`;
          await copyFileContent(await openWriter(), path, newPath);
          break;
        }
        case 'delete': {
          if (confirm(`Delete ${path}?`)) {
            const fs = await openWriter();
            await fs.rm(path);
          }
          break;
        }
        case 'rename': {
          const oldName = path.split('/').pop() ?? '';
          const newName = prompt(`Rename ${path} to:`, oldName)?.trim();
          if (!newName || newName === oldName || newName.includes('/')) break;
          const newPath = `${path.slice(0, path.length - oldName.length)}${newName}`;
          const fs = await openWriter();
          await copyFileContent(fs, path, newPath);
          await fs.rm(path);
          break;
        }
      }
    } catch (err) {
      log.error(`Overflow action "${action}" failed`, err);
    }
  });
}
