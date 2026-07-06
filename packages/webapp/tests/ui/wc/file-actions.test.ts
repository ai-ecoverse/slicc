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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  let log: { error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    fs = await seededFs();
    fileTree = document.createElement('div');
    document.body.appendChild(fileTree);
    log = { error: vi.fn() };
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
