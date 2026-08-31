// @vitest-environment jsdom
/**
 * The shell half of keyboard mode: the six commands that reach their surface
 * through the DOM rather than through a component method, and the three chord
 * lists.
 *
 * The bias under test throughout is that every one of them is a silent no-op
 * when its surface is not on screen — these run on floats with no workbench,
 * no copy row, and a read-only transcript.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copyChat,
  copyReply,
  focusApproval,
  openAttachMenu,
  type ShortcutSurfaceDeps,
  shortcutLists,
  stopTurn,
  zoomSurface,
} from '../../../src/ui/wc/wc-shortcut-surfaces.js';

function harness(options: { activeDock?: string | null } = {}) {
  const inputCard = document.createElement('slicc-input-card');
  const thread = document.createElement('div');
  const dockTree = document.createElement('slicc-dock-tree');
  const freezer = document.createElement('div');
  const memoryHost = document.createElement('slicc-memory-panel');
  document.body.append(inputCard, thread, dockTree, freezer, memoryHost);
  const selectFile = vi.fn();
  const fileTree = { items: [] as Array<{ id?: string }>, selectFile };
  const deps: ShortcutSurfaceDeps = {
    inputCard,
    thread,
    dockTree,
    dock: { active: options.activeDock ?? null },
    freezer,
    fileTree: fileTree as unknown as ShortcutSurfaceDeps['fileTree'],
    memoryHost,
  };
  return { deps, inputCard, thread, dockTree, freezer, memoryHost, fileTree, selectFile };
}

/** A surface leaf in the dock-tree, with a spyable fullscreen request. */
function surface(dockTree: HTMLElement, id: string, options: { parked?: boolean } = {}) {
  const el = document.createElement('slicc-surface');
  el.setAttribute('surface-id', id);
  const requestFullscreen = vi.fn(async () => undefined);
  Object.assign(el, { requestFullscreen });
  if (options.parked) {
    const parking = document.createElement('div');
    parking.className = 'dock-tree__parking';
    parking.append(el);
    dockTree.append(parking);
  } else {
    dockTree.append(el);
  }
  return { el, requestFullscreen };
}

/** An approval card's button, as the transcript renders one. */
function approval(thread: HTMLElement, action: string, options: { disabled?: boolean } = {}) {
  const button = document.createElement('button');
  button.dataset.action = action;
  if (options.disabled) button.disabled = true;
  thread.append(button);
  return button;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('stopTurn', () => {
  /**
   * Dispatched at the card, not at the send button's shadow root: `stop` is
   * composed and bubbling, so the card is where the host's listener already
   * is — and the "is anything running?" guard stays in that listener.
   */
  it("fires the send button's own stop event at the input card", () => {
    const { deps, inputCard } = harness();
    const seen = vi.fn();
    inputCard.addEventListener('stop', seen);
    stopTurn(deps);
    expect(seen).toHaveBeenCalledTimes(1);
    expect((seen.mock.calls[0] as unknown as [Event])[0].bubbles).toBe(true);
  });
});

describe('openAttachMenu', () => {
  it("calls the add menu's own open()", () => {
    const { deps, inputCard } = harness();
    const menu = document.createElement('slicc-add-menu');
    const open = vi.fn();
    Object.assign(menu, { open });
    inputCard.append(menu);
    openAttachMenu(deps);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a composer with no add menu', () => {
    const { deps } = harness();
    expect(() => openAttachMenu(deps)).not.toThrow();
  });

  /** jsdom never upgrades the element, so `open` may not exist at all. */
  it('does nothing when the element has not upgraded', () => {
    const { deps, inputCard } = harness();
    inputCard.append(document.createElement('slicc-add-menu'));
    expect(() => openAttachMenu(deps)).not.toThrow();
  });
});

describe('the copy row', () => {
  function copyRow(thread: HTMLElement) {
    const row = document.createElement('div');
    row.className = 'wc-copy-row';
    const button = document.createElement('slicc-press-button');
    row.append(button);
    thread.append(row);
    const short = vi.fn();
    const long = vi.fn();
    button.addEventListener('short-click', short);
    button.addEventListener('long-press', long);
    return { short, long };
  }

  it('fires the press gestures the row already listens for', () => {
    const { deps, thread } = harness();
    const { short, long } = copyRow(thread);
    copyReply(deps);
    expect(short).toHaveBeenCalledTimes(1);
    expect(long).not.toHaveBeenCalled();
    copyChat(deps);
    expect(long).toHaveBeenCalledTimes(1);
  });

  it('does nothing before the first reply has rendered one', () => {
    const { deps } = harness();
    expect(() => copyReply(deps)).not.toThrow();
    expect(() => copyChat(deps)).not.toThrow();
  });
});

describe('focusApproval', () => {
  it('focuses the oldest pending request', () => {
    const { deps, thread } = harness();
    const first = approval(thread, 'approve');
    approval(thread, 'deny');
    focusApproval(deps);
    expect(document.activeElement).toBe(first);
  });

  it('walks to the next one when pressed again, wrapping', () => {
    const { deps, thread } = harness();
    const first = approval(thread, 'approve');
    const second = approval(thread, 'deny');
    focusApproval(deps);
    focusApproval(deps);
    expect(document.activeElement).toBe(second);
    focusApproval(deps);
    expect(document.activeElement).toBe(first);
  });

  /** An answered card's buttons are disabled; they are not requests anymore. */
  it('skips an answered request', () => {
    const { deps, thread } = harness();
    approval(thread, 'approve', { disabled: true });
    const live = approval(thread, 'approve');
    focusApproval(deps);
    expect(document.activeElement).toBe(live);
  });

  it('does nothing when there is nothing to answer', () => {
    const { deps } = harness();
    const before = document.activeElement;
    focusApproval(deps);
    expect(document.activeElement).toBe(before);
  });
});

describe('zoomSurface', () => {
  it('full-screens the surface the dock is showing', () => {
    const { deps, dockTree } = harness({ activeDock: 'files' });
    const { requestFullscreen } = surface(dockTree, 'files');
    zoomSurface(deps);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('escapes an id with a colon in it, as every sprinkle has', () => {
    const { deps, dockTree } = harness({ activeDock: 'sprinkle:notes' });
    const { requestFullscreen } = surface(dockTree, 'sprinkle:notes');
    zoomSurface(deps);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  /**
   * A parked surface is `display:none`, and `requestFullscreen()` on a hidden
   * element rejects — so it is left alone rather than made to fail.
   */
  it('leaves a parked surface alone', () => {
    const { deps, dockTree } = harness({ activeDock: 'files' });
    const { requestFullscreen } = surface(dockTree, 'files', { parked: true });
    zoomSurface(deps);
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it('does nothing with no panel open, or none mounted', () => {
    const closed = harness({ activeDock: null });
    expect(() => zoomSurface(closed.deps)).not.toThrow();
    const missing = harness({ activeDock: 'files' });
    expect(() => zoomSurface(missing.deps)).not.toThrow();
  });

  it('swallows a refusal rather than raising it at the keyboard', async () => {
    const { deps, dockTree } = harness({ activeDock: 'files' });
    const { el } = surface(dockTree, 'files');
    Object.assign(el, { requestFullscreen: vi.fn(() => Promise.reject(new Error('denied'))) });
    expect(() => zoomSurface(deps)).not.toThrow();
    await Promise.resolve();
  });
});

describe('shortcutLists', () => {
  it('indexes the file tree by row, skipping the group headers', () => {
    const h = harness();
    h.fileTree.items = [
      { kind: 'group', label: 'Workspace' } as never,
      { id: '/a.ts' },
      { id: '/b.ts' },
    ];
    const list = shortcutLists(h.deps).files;
    expect(list.size()).toBe(2);
    list.selectAt(1);
    expect(h.selectFile).toHaveBeenCalledWith('/b.ts');
  });

  it('clicks the nth archived chat, which is how the card is activated at all', () => {
    const h = harness();
    const clicks: string[] = [];
    for (const slug of ['jan', 'feb']) {
      const card = document.createElement('slicc-freezer-card');
      card.setAttribute('slug', slug);
      card.addEventListener('click', () => clicks.push(slug));
      h.freezer.append(card);
    }
    const list = shortcutLists(h.deps).sessions;
    expect(list.size()).toBe(2);
    list.selectAt(1);
    expect(clicks).toEqual(['feb']);
  });

  it('clicks the nth memory row', () => {
    const h = harness();
    const row = document.createElement('slicc-memrow');
    const clicked = vi.fn();
    row.addEventListener('click', clicked);
    h.memoryHost.append(row);
    shortcutLists(h.deps).memory.selectAt(0);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  /**
   * Half a chord is long enough for a panel to finish mounting, so the size
   * is read at press time rather than captured when the wiring was built.
   */
  it('reads the rows live, not at wiring time', () => {
    const h = harness();
    const lists = shortcutLists(h.deps);
    expect(lists.sessions.size()).toBe(0);
    h.freezer.append(document.createElement('slicc-freezer-card'));
    expect(lists.sessions.size()).toBe(1);
  });

  it('is a no-op past the end of every list', () => {
    const h = harness();
    const lists = shortcutLists(h.deps);
    expect(() => lists.files.selectAt(3)).not.toThrow();
    expect(() => lists.memory.selectAt(3)).not.toThrow();
    expect(() => lists.sessions.selectAt(3)).not.toThrow();
    expect(h.selectFile).not.toHaveBeenCalled();
  });
});
