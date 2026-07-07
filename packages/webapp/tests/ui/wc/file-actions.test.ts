// @vitest-environment jsdom
/**
 * `wireFileActions` regression coverage. `duplicate`/`delete` previously read
 * through the read-only `LocalVfsClient` and cast it to a write-capable type
 * that didn't exist at runtime — `writeFile`/`rm` threw `TypeError`s that were
 * swallowed by the handler's own try/catch, so the menu items silently did
 * nothing. They now go through the real kernel-RPC-backed `WritableVfsClient`
 * (`openWriter`). `rename` was a stub; it's now implemented as
 * read + write-to-new-name + remove-old, same as `duplicate` plus a delete.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { SliccOverflowMenu } from '@slicc/webcomponents';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { wireFileActions } from '../../../src/ui/wc/file-actions.js';

async function seededFs(): Promise<VirtualFS> {
  const fs = await VirtualFS.create({ dbName: `file-actions-${Math.random()}`, wipe: true });
  await fs.mkdir('/workspace/skills', { recursive: true });
  await fs.writeFile('/workspace/skills/SKILL.md', '# skill content');
  return fs;
}

function dispatchOverflowAction(
  fileTree: HTMLElement,
  action: string,
  context: { path: string }
): void {
  fileTree.dispatchEvent(
    new CustomEvent('overflow-action', {
      bubbles: true,
      composed: true,
      detail: { action, context },
    })
  );
}

describe('wireFileActions', () => {
  let fs: VirtualFS;
  let fileTree: HTMLElement;
  let log: { error: Mock<(message: string, ...data: unknown[]) => void> };

  beforeEach(async () => {
    fs = await seededFs();
    fileTree = document.createElement('div');
    document.body.appendChild(fileTree);
    log = { error: vi.fn<(message: string, ...data: unknown[]) => void>() };
    wireFileActions({
      fileTree,
      openFs: async () => fs,
      openWriter: async () => fs,
      insertReference: vi.fn(),
      toPreviewUrl: (p: string) => `http://localhost/preview${p}`,
      log,
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    SliccOverflowMenu.hide();
  });

  it('duplicate writes a sibling _copy file with the same content', async () => {
    dispatchOverflowAction(fileTree, 'duplicate', { path: '/workspace/skills/SKILL.md' });
    await vi.waitFor(async () => {
      expect(await fs.readFile('/workspace/skills/SKILL_copy.md', { encoding: 'utf-8' })).toBe(
        '# skill content'
      );
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('duplicate round-trips binary content byte-for-byte', async () => {
    // Bytes 0x80-0xFF are invalid standalone UTF-8 continuation bytes — a
    // naive utf-8 read+write mangles them into U+FFFD replacement chars.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x80]);
    await fs.writeFile('/workspace/skills/photo.png', bytes);
    dispatchOverflowAction(fileTree, 'duplicate', { path: '/workspace/skills/photo.png' });
    await vi.waitFor(async () => {
      await expect(fs.stat('/workspace/skills/photo_copy.png')).resolves.toBeTruthy();
    });
    const copied = await fs.readFile('/workspace/skills/photo_copy.png', { encoding: 'binary' });
    expect(Array.from(copied as Uint8Array)).toEqual(Array.from(bytes));
    expect(log.error).not.toHaveBeenCalled();
  });

  it('rename round-trips binary content byte-for-byte', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x80]);
    await fs.writeFile('/workspace/skills/photo.png', bytes);
    vi.spyOn(window, 'prompt').mockReturnValue('renamed.png');
    dispatchOverflowAction(fileTree, 'rename', { path: '/workspace/skills/photo.png' });
    await vi.waitFor(async () => {
      await expect(fs.stat('/workspace/skills/renamed.png')).resolves.toBeTruthy();
    });
    const renamed = await fs.readFile('/workspace/skills/renamed.png', { encoding: 'binary' });
    expect(Array.from(renamed as Uint8Array)).toEqual(Array.from(bytes));
    await expect(fs.stat('/workspace/skills/photo.png')).rejects.toThrow();
  });

  it('duplicate asks before overwriting an existing sibling, and skips on decline', async () => {
    await fs.writeFile('/workspace/skills/SKILL_copy.md', 'preexisting');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    dispatchOverflowAction(fileTree, 'duplicate', { path: '/workspace/skills/SKILL.md' });
    await new Promise((r) => setTimeout(r, 10));
    expect(confirmSpy).toHaveBeenCalledWith(
      '/workspace/skills/SKILL_copy.md already exists. Overwrite?'
    );
    expect(await fs.readFile('/workspace/skills/SKILL_copy.md', { encoding: 'utf-8' })).toBe(
      'preexisting'
    );
  });

  it('duplicate overwrites an existing sibling when confirmed', async () => {
    await fs.writeFile('/workspace/skills/SKILL_copy.md', 'preexisting');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    dispatchOverflowAction(fileTree, 'duplicate', { path: '/workspace/skills/SKILL.md' });
    await vi.waitFor(async () => {
      expect(await fs.readFile('/workspace/skills/SKILL_copy.md', { encoding: 'utf-8' })).toBe(
        '# skill content'
      );
    });
  });

  it('rename asks before overwriting an existing sibling, and leaves both files untouched on decline', async () => {
    await fs.writeFile('/workspace/skills/OTHER.md', 'sibling content');
    vi.spyOn(window, 'prompt').mockReturnValue('OTHER.md');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    dispatchOverflowAction(fileTree, 'rename', { path: '/workspace/skills/SKILL.md' });
    await new Promise((r) => setTimeout(r, 10));
    expect(confirmSpy).toHaveBeenCalledWith(
      '/workspace/skills/OTHER.md already exists. Overwrite?'
    );
    expect(await fs.readFile('/workspace/skills/OTHER.md', { encoding: 'utf-8' })).toBe(
      'sibling content'
    );
    expect(await fs.readFile('/workspace/skills/SKILL.md', { encoding: 'utf-8' })).toBe(
      '# skill content'
    );
  });

  it('delete confirms with the full path and removes the file', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    dispatchOverflowAction(fileTree, 'delete', { path: '/workspace/skills/SKILL.md' });
    await vi.waitFor(async () => {
      await expect(fs.stat('/workspace/skills/SKILL.md')).rejects.toThrow();
    });
    expect(confirmSpy).toHaveBeenCalledWith('Delete /workspace/skills/SKILL.md?');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('delete does nothing when confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    dispatchOverflowAction(fileTree, 'delete', { path: '/workspace/skills/SKILL.md' });
    await new Promise((r) => setTimeout(r, 10));
    await expect(fs.stat('/workspace/skills/SKILL.md')).resolves.toBeTruthy();
  });

  it('rename prompts with the full path and moves content to the new name', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('RENAMED.md');
    dispatchOverflowAction(fileTree, 'rename', { path: '/workspace/skills/SKILL.md' });
    await vi.waitFor(async () => {
      expect(await fs.readFile('/workspace/skills/RENAMED.md', { encoding: 'utf-8' })).toBe(
        '# skill content'
      );
    });
    expect(promptSpy).toHaveBeenCalledWith('Rename /workspace/skills/SKILL.md to:', 'SKILL.md');
    await expect(fs.stat('/workspace/skills/SKILL.md')).rejects.toThrow();
  });

  it('rename does nothing when the prompt is cancelled', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    dispatchOverflowAction(fileTree, 'rename', { path: '/workspace/skills/SKILL.md' });
    await new Promise((r) => setTimeout(r, 10));
    await expect(fs.stat('/workspace/skills/SKILL.md')).resolves.toBeTruthy();
  });

  it('rename does nothing when the new name is unchanged or contains a slash', async () => {
    vi.spyOn(window, 'prompt').mockReturnValueOnce('SKILL.md').mockReturnValueOnce('a/b.md');
    dispatchOverflowAction(fileTree, 'rename', { path: '/workspace/skills/SKILL.md' });
    await new Promise((r) => setTimeout(r, 10));
    dispatchOverflowAction(fileTree, 'rename', { path: '/workspace/skills/SKILL.md' });
    await new Promise((r) => setTimeout(r, 10));
    await expect(fs.stat('/workspace/skills/SKILL.md')).resolves.toBeTruthy();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('copy-path writes the path to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    dispatchOverflowAction(fileTree, 'copy-path', { path: '/workspace/skills/SKILL.md' });
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('/workspace/skills/SKILL.md');
    });
  });

  it('open-browser opens the preview URL in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    dispatchOverflowAction(fileTree, 'open-browser', { path: '/workspace/skills/index.html' });
    await vi.waitFor(() => {
      expect(open).toHaveBeenCalledWith(
        'http://localhost/preview/workspace/skills/index.html',
        '_blank'
      );
    });
  });

  it('end-to-end: overflow menu survives the anchor being detached before the click', async () => {
    const anchor = document.createElement('button');
    fileTree.appendChild(anchor);
    fileTree.dispatchEvent(
      new CustomEvent('file-overflow', {
        detail: { id: 'x', path: '/workspace/skills/SKILL.md', anchor },
      })
    );
    const menu = document.querySelector('slicc-overflow-menu') as SliccOverflowMenu;
    expect(menu).not.toBeNull();
    // Simulate the file tree's periodic refresh rebuilding rows mid-menu.
    anchor.remove();
    const dupItem = menu.shadowRoot?.querySelector('[data-action="duplicate"]') as HTMLElement;
    dupItem.click();
    await vi.waitFor(async () => {
      expect(await fs.readFile('/workspace/skills/SKILL_copy.md', { encoding: 'utf-8' })).toBe(
        '# skill content'
      );
    });
  });
});
