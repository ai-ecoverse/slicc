/**
 * File action wiring: connects file-tree hover action events to VFS operations,
 * Quick Look preview, and the overflow menu. Consumed by wc-workbench.ts.
 */

import type { MenuItem } from '@slicc/webcomponents';
import { SliccOverflowMenu, SliccQuickLook } from '@slicc/webcomponents';

import { richPreviewKind, sniffFileType } from '../../core/file-type.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';
import { readGitBase } from '../git-preview-source.js';
import { renderMessageContent } from '../message-renderer.js';

function isPreviewableInBrowser(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return ext === '.html' || ext === '.svg';
}

/**
 * Read a file and identify it from its BYTES, not its name.
 *
 * The download path still wants a type for its `Blob`, and the preview path
 * wants to know whether the content is readable — both now come from the same
 * sniff, so a file previews and downloads as the same thing. This replaced a
 * second hardcoded extension table that had drifted from `core/mime-types.ts`
 * and, like it, answered `application/octet-stream` for anything it had not
 * been told about.
 */
async function readAndIdentify(
  fs: LocalVfsClient,
  path: string
): Promise<{ mime: string; text: boolean; bytes: Uint8Array<ArrayBuffer> }> {
  const raw = (await fs.readFile(path, { encoding: 'binary' })) as Uint8Array;
  // Re-materialize into a plain same-realm Uint8Array: the raw value can be a
  // pooled or foreign buffer (see the copies in the other handlers here).
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  bytes.set(raw);
  const { mime, text } = sniffFileType(path, bytes);
  return { mime, text, bytes };
}

/**
 * Beyond this size a file gets no rendered view.
 *
 * Rendering is synchronous work on the main thread — `marked` + DOMPurify for
 * markdown, a layout pass for HTML — and a multi-megabyte document would freeze
 * the overlay it is supposed to be filling. Source view has no such problem
 * (`@pierre/diffs` virtualizes), so the large file still previews; it just
 * previews as source.
 */
const RENDERED_PREVIEW_MAX_BYTES = 512 * 1024;

/**
 * The rendered half of a markdown or HTML preview, if this file has one.
 *
 * Markdown goes through the SAME renderer the transcript uses, so a README
 * previews exactly the way the agent's prose does — and, crucially, arrives
 * sanitized: `renderMessageContent` runs DOMPurify, and Quick Look mounts an
 * `inline` payload as trusted markup. HTML is NOT sanitized and is never
 * mounted inline; it goes into a sandboxed iframe, which is the only honest way
 * to show a file that may contain anything.
 */
function buildRenderedView(
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

/**
 * Read `path`, work out what it is, and show it in Quick Look.
 *
 * Exported because two surfaces open previews: the file tree's preview action
 * and a clicked file mention in the transcript. Routing both through one
 * function is what keeps a mention and a tree row showing the SAME thing —
 * same sniffed type, same git diff, same line highlight.
 *
 * A file that turns out to have uncommitted changes opens on its diff; looking
 * that up costs a lazy `isomorphic-git` load, so it is only attempted for text.
 */
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

/** Save `path` to the user's downloads, typed by the same sniff the preview uses. */
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
  // Re-materialize into a plain same-realm Uint8Array: the raw value can be a
  // pooled/foreign buffer that fails `instanceof Uint8Array` (and writeFile's
  // non-mount path passes content straight through with no normalization of
  // its own) — see the identical copy in the file-preview/file-download
  // handlers above.
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
    // Preview / Reference / Download used to be hover buttons on the row. The
    // tree's renderer has no slot for arbitrary row controls, so they live here
    // now — the events they raise are unchanged.
    //
    // Rename / Duplicate / Delete are FILE-only, matching the old tree (which
    // drew no action buttons on directory rows at all). They are not merely
    // untested on directories, they cannot work: `copyFileContent` reads the
    // path as a file and fails with EISDIR, and `rm` without `recursive` fails
    // on a populated directory. Offering them would advertise operations that
    // always error.
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
        // Re-dispatched rather than handled inline: `file-preview` /
        // `file-reference` / `file-download` are the component's documented
        // events, and hosts (plus the stories) listen for them. Calling the
        // implementations directly would make the menu work while silently
        // breaking every other consumer of the contract.
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
        case 'rename': {
          const oldName = path.split('/').pop() ?? '';
          const newName = prompt(`Rename ${path} to:`, oldName)?.trim();
          if (!newName || newName === oldName || newName.includes('/')) break;
          const newPath = `${path.slice(0, path.length - oldName.length)}${newName}`;
          const fs = await openWriter();
          if (
            (await existsInVfs(fs, newPath)) &&
            !confirm(`${newPath} already exists. Overwrite?`)
          ) {
            break;
          }
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
