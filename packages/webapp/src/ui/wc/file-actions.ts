import type { MenuItem } from '@slicc/webcomponents';
import { SliccOverflowMenu, SliccQuickLook } from '@slicc/webcomponents';

import { richPreviewKind, sniffFileType } from '../../core/file-type.js';
import { sameFileIdentity } from '../../fs/same-file-identity.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';
import { readGitBase } from '../git-preview-source.js';
import { renderMessageContent } from '../message-renderer.js';

function isPreviewableInBrowser(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return ext === '.html' || ext === '.svg';
}

async function readAndIdentify(
  fs: LocalVfsClient,
  path: string
): Promise<{ mime: string; text: boolean; bytes: Uint8Array<ArrayBuffer> }> {
  const raw = (await fs.readFile(path, { encoding: 'binary' })) as Uint8Array;

  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  bytes.set(raw);
  const { mime, text } = sniffFileType(path, bytes);
  return { mime, text, bytes };
}

const RENDERED_PREVIEW_MAX_BYTES = 512 * 1024;

export function buildRenderedView(
  path: string,
  mime: string,
  contents: string
): { mount: 'inline' | 'sandbox'; html: string } | null {
  if (contents.length > RENDERED_PREVIEW_MAX_BYTES) return null;
  switch (richPreviewKind(path, mime)) {
    case 'markdown':
      return { mount: 'inline', html: renderMessageContent(contents) };
    case 'html':
      return { mount: 'sandbox', html: contents };
    default:
      return null;
  }
}

export async function openFilePreview(
  fs: LocalVfsClient,
  path: string,
  options: { line?: number } = {}
): Promise<void> {
  const { mime, text, bytes } = await readAndIdentify(fs, path);

  if (!text) {
    SliccQuickLook.open({
      path,
      content: bytes.buffer as ArrayBuffer,
      mimeType: mime,
      text: false,
    });
    return;
  }

  const contents = new TextDecoder().decode(bytes);
  const base = await readGitBase(fs, path, contents);
  const rendered = buildRenderedView(path, mime, contents);

  SliccQuickLook.open({
    path,
    content: contents,
    mimeType: mime,
    text: true,
    ...(base ? { baseContent: base.baseContent, gitStatus: base.status } : {}),
    ...(rendered ? { rendered } : {}),
    ...(options.line !== undefined ? { line: options.line } : {}),
  });
}

async function downloadFile(fs: LocalVfsClient, path: string): Promise<void> {
  const { mime, bytes } = await readAndIdentify(fs, path);
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = path.split('/').pop() || 'download';
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function copyFileContent(fs: WritableVfsClient, from: string, to: string): Promise<void> {
  const raw = await fs.readFile(from, { encoding: 'binary' });

  const data = typeof raw === 'string' ? raw : Uint8Array.from(raw);
  await fs.writeFile(to, data);
}

async function existsInVfs(fs: WritableVfsClient, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function renameFileInVfs(fs: WritableVfsClient, path: string): Promise<void> {
  const oldName = path.split('/').pop() ?? '';
  const newName = prompt(`Rename ${path} to:`, oldName)?.trim();
  if (!newName || newName === oldName || newName.includes('/')) return;
  const newPath = `${path.slice(0, path.length - oldName.length)}${newName}`;
  const fromStat = await fs.stat(path);
  try {
    const toStat = await fs.stat(newPath);
    if (sameFileIdentity(fromStat, toStat)) return;
  } catch {}
  if ((await existsInVfs(fs, newPath)) && !confirm(`${newPath} already exists. Overwrite?`)) {
    return;
  }
  await copyFileContent(fs, path, newPath);
  await fs.rm(path);
}

export interface FileActionDeps {
  fileTree: HTMLElement;
  openFs(): Promise<LocalVfsClient>;

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
      await openFilePreview(await openFs(), path);
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
      await downloadFile(await openFs(), path);
    } catch (err) {
      log.error('File download failed', err);
    }
  });

  fileTree.addEventListener('file-overflow', (e) => {
    const { path, anchor, kind } = (
      e as CustomEvent<{ id: string; path: string; anchor: HTMLElement; kind?: string }>
    ).detail;
    const isFile = kind !== 'directory';

    const items: MenuItem[] = [
      { id: 'preview', label: 'Preview', visible: isFile },
      { id: 'reference', label: 'Reference in chat', visible: isFile },
      { id: 'download', label: 'Download', visible: isFile },
      { id: 'rename', label: 'Rename', visible: isFile },
      { id: 'duplicate', label: 'Duplicate', visible: isFile },
      { id: 'copy-path', label: 'Copy path' },
      {
        id: 'open-browser',
        label: 'Open in browser',
        visible: isFile && isPreviewableInBrowser(path),
      },
      { id: 'delete', label: 'Delete', destructive: true, visible: isFile },
    ];

    SliccOverflowMenu.show({ anchor, items, context: { path }, dispatchTarget: fileTree });
  });

  fileTree.addEventListener('overflow-action', async (e) => {
    const { action, context } = (e as CustomEvent<{ action: string; context: { path: string } }>)
      .detail;
    const { path } = context;
    try {
      switch (action) {
        case 'preview':
        case 'reference':
        case 'download':
          fileTree.dispatchEvent(
            new CustomEvent(`file-${action}`, {
              detail: { id: path, path },
              bubbles: true,
              composed: true,
            })
          );
          break;
        case 'copy-path':
          await navigator.clipboard.writeText(path);
          break;
        case 'open-browser':
          window.open(toPreviewUrl(path), '_blank');
          break;
        case 'duplicate': {
          const dot = path.lastIndexOf('.');
          const newPath = dot > 0 ? `${path.slice(0, dot)}_copy${path.slice(dot)}` : `${path}_copy`;
          const fs = await openWriter();
          if (
            (await existsInVfs(fs, newPath)) &&
            !confirm(`${newPath} already exists. Overwrite?`)
          ) {
            break;
          }
          await copyFileContent(fs, path, newPath);
          break;
        }
        case 'delete': {
          if (confirm(`Delete ${path}?`)) {
            const fs = await openWriter();
            await fs.rm(path);
          }
          break;
        }
        case 'rename':
          await renameFileInVfs(await openWriter(), path);
          break;
      }
    } catch (err) {
      log.error(`Overflow action "${action}" failed`, err);
    }
  });
}
