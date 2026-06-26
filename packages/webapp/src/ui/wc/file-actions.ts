/**
 * File action wiring: connects file-tree hover action events to VFS operations,
 * Quick Look preview, and the overflow menu. Consumed by wc-workbench.ts.
 */

import type { MenuItem } from '@slicc/webcomponents';
import { SliccOverflowMenu, SliccQuickLook } from '@slicc/webcomponents';

import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';

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

export interface FileActionDeps {
  fileTree: HTMLElement;
  openFs(): Promise<LocalVfsClient>;
  insertReference(path: string): void;
  toPreviewUrl(vfsPath: string): string;
  log: { error(message: string, ...data: unknown[]): void };
}

export function wireFileActions(deps: FileActionDeps): void {
  const { fileTree, openFs, insertReference, toPreviewUrl, log } = deps;

  fileTree.addEventListener('file-preview', async (e) => {
    const { path } = (e as CustomEvent<{ id: string; path: string }>).detail;
    try {
      const fs = await openFs();
      const mime = mimeFromPath(path);
      let content: string | ArrayBuffer;
      if (mime.startsWith('text/') || mime === 'application/json') {
        content = (await fs.readFile(path, { encoding: 'utf-8' })) as string;
      } else {
        const raw = await fs.readFile(path);
        if (typeof raw === 'string') {
          content = new TextEncoder().encode(raw).buffer;
        } else {
          content = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
        }
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
      const rawData = (await fs.readFile(path)) as Uint8Array;
      // Create a new Uint8Array with ArrayBuffer to avoid SharedArrayBuffer issues
      const data = new Uint8Array(rawData);
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
    SliccOverflowMenu.show({ anchor, items, context: { path } });
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
          const fs = await openFs();
          const data = await fs.readFile(path);
          const dot = path.lastIndexOf('.');
          const newPath = dot > 0 ? `${path.slice(0, dot)}_copy${path.slice(dot)}` : `${path}_copy`;
          // LocalVfsClient is read-only, but this is a design-time limitation.
          // The real fs passed in is a VirtualFS that has writeFile.
          // We cast here to access the write method.
          await (
            fs as LocalVfsClient & { writeFile(p: string, d: unknown): Promise<void> }
          ).writeFile(newPath, data);
          break;
        }
        case 'delete': {
          if (confirm(`Delete ${path.split('/').pop()}?`)) {
            const fs = await openFs();
            // Same cast for rm method
            await (fs as LocalVfsClient & { rm(p: string): Promise<void> }).rm(path);
          }
          break;
        }
        case 'rename':
          // Inline rename is complex — emit event for the file tree to handle
          break;
      }
    } catch (err) {
      log.error(`Overflow action "${action}" failed`, err);
    }
  });
}
