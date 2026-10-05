// @vitest-environment jsdom
/**
 * Freezer delete flow: trash → confirm dialog naming the chat → delete →
 * close + refresh; a failure keeps the dialog for a retry.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

const mockDelete = vi.fn();
vi.mock('../../../src/ui/frozen-session-delete.js', () => ({
  deleteFrozenSession: (...args: unknown[]) => mockDelete(...args),
}));

import type { FrozenSessionIndexEntry } from '../../../src/ui/wc/wc-freezer.js';
import { type FreezerDeleteDeps, wireFreezerDelete } from '../../../src/ui/wc/wc-freezer-delete.js';

const ENTRY: FrozenSessionIndexEntry = {
  filename: '2026-06-01T10-00-00Z-fix-build.md',
  sessionId: 'sid-1',
  title: 'Fix the build',
  frozenAt: '2026-06-01T10:00:00Z',
  messageCount: 2,
};

function card(slug: string): HTMLElement {
  const el = document.createElement('slicc-freezer-card');
  el.setAttribute('slug', slug);
  const btn = document.createElement('button');
  btn.className = 'slicc-fzcard__delete';
  el.append(btn);
  return el;
}

function harness(overrides: Partial<FreezerDeleteDeps> = {}) {
  document.body.replaceChildren();
  const freezer = document.createElement('slicc-freezer');
  freezer.append(card(ENTRY.filename));
  document.body.append(freezer);
  const writer = { tag: 'writer' };
  const deps: FreezerDeleteDeps = {
    freezer,
    openVfs: vi.fn(async () => ({ reader: {}, writer }) as never),
    getEntries: () => [ENTRY],
    getViewedId: () => null,
    leaveViewed: vi.fn(),
    refreshFreezer: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ...overrides,
  };
  const handles = wireFreezerDelete(deps);
  return { freezer, deps, handles, writer };
}

function ask(freezer: HTMLElement, slug = ENTRY.filename): void {
  freezer
    .querySelector('slicc-freezer-card')!
    .dispatchEvent(
      new CustomEvent('freezer-card-delete', { bubbles: true, composed: true, detail: { slug } })
    );
}

const action = (name: string) =>
  document.querySelector<HTMLButtonElement>(`slicc-dialog [data-cone-action="${name}"]`)!;

beforeEach(() => {
  mockDelete.mockReset();
});

describe('wireFreezerDelete', () => {
  it('opens a confirm that names the chat and says memories are kept', () => {
    const { freezer, handles } = harness();
    ask(freezer);
    const dialog = handles.dialog()!;
    expect(dialog.getAttribute('heading')).toBe('Delete frozen chat?');
    expect(dialog.textContent).toContain(
      '“Fix the build” and its transcript will be permanently deleted. Memories already learned from it are kept.'
    );
    expect(action('delete').textContent).toBe('Delete');
    expect(action('cancel').textContent).toBe('Cancel');
  });

  it('Cancel closes without deleting', () => {
    const { freezer, handles, deps } = harness();
    ask(freezer);
    action('cancel').click();
    expect(handles.dialog()).toBeNull();
    expect(document.querySelector('slicc-dialog')).toBeNull();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(deps.refreshFreezer).not.toHaveBeenCalled();
  });

  it('Delete deletes by filename + sessionId, closes and refreshes the rail', async () => {
    mockDelete.mockResolvedValue({ status: 'deleted' });
    const { freezer, handles, deps, writer } = harness();
    ask(freezer);
    action('delete').click();

    await vi.waitFor(() => expect(deps.refreshFreezer).toHaveBeenCalled());
    expect(mockDelete).toHaveBeenCalledWith(writer, {
      filename: ENTRY.filename,
      sessionId: 'sid-1',
    });
    expect(handles.dialog()).toBeNull();
    expect(deps.leaveViewed).not.toHaveBeenCalled();
  });

  it('deleting the chat on screen leaves it', async () => {
    mockDelete.mockResolvedValue({ status: 'deleted' });
    const { freezer, deps } = harness({ getViewedId: () => 'sid-1' });
    ask(freezer);
    action('delete').click();
    await vi.waitFor(() => expect(deps.leaveViewed).toHaveBeenCalledWith(ENTRY));
  });

  it('a failed delete keeps the dialog with an error and re-enables Delete', async () => {
    mockDelete.mockResolvedValue({ status: 'failed', errors: ['/sessions/x.md: EIO'] });
    const { freezer, handles, deps } = harness();
    ask(freezer);
    action('delete').click();

    await vi.waitFor(() =>
      expect(document.querySelector('[data-freezer-delete-error]')?.textContent).toBe(
        "Couldn't delete everything — try again."
      )
    );
    expect(handles.dialog()).not.toBeNull();
    expect(action('delete').disabled).toBe(false);
    expect(deps.refreshFreezer).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalled();
  });

  it('a thrown error is handled like a failed delete', async () => {
    const { freezer, deps } = harness({
      openVfs: vi.fn(async () => {
        throw new Error('vfs gone');
      }),
    });
    ask(freezer);
    action('delete').click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-freezer-delete-error]')).not.toBeNull()
    );
    expect(deps.refreshFreezer).not.toHaveBeenCalled();
  });

  it('ignores live rows, unknown slugs, and a second request for an open slug', () => {
    const live = harness({ getEntries: () => [{ ...ENTRY, live: true }] });
    ask(live.freezer);
    expect(live.handles.dialog()).toBeNull();

    const unknown = harness();
    ask(unknown.freezer, 'nope.md');
    expect(unknown.handles.dialog()).toBeNull();

    const twice = harness();
    ask(twice.freezer);
    ask(twice.freezer);
    expect(document.querySelectorAll('slicc-dialog')).toHaveLength(1);
  });

  it('moves focus to the re-rendered card when a refresh replaced the opener', () => {
    const { freezer } = harness();
    ask(freezer);
    const replacement = card(ENTRY.filename);
    freezer.replaceChildren(replacement);
    action('cancel').click();
    expect(document.activeElement).toBe(replacement.querySelector('.slicc-fzcard__delete'));
  });
});
