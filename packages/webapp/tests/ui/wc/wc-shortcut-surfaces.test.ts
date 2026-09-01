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
  scrollMessage,
  shortcutLists,
  stopTurn,
  toggleVoice,
  zoomSurface,
} from '../../../src/ui/wc/wc-shortcut-surfaces.js';

function harness(options: { activeDock?: string | null } = {}) {
  const inputCard = document.createElement('slicc-input-card');
  const thread = document.createElement('div');
  const dockTree = document.createElement('slicc-dock-tree');
  const freezer = document.createElement('div');
  const memoryHost = document.createElement('slicc-memory-panel');
  const composer = document.createElement('slicc-composer');
  document.body.append(inputCard, thread, dockTree, freezer, memoryHost, composer);
  const selectFile = vi.fn();
  const fileTree = { rows: [] as string[], visibleIds: () => fileTree.rows, selectFile };
  const deps: ShortcutSurfaceDeps = {
    inputCard,
    thread,
    dockTree,
    dock: { active: options.activeDock ?? null },
    freezer,
    composer,
    fileTree: fileTree as unknown as ShortcutSurfaceDeps['fileTree'],
    memoryHost,
  };
  return { deps, inputCard, thread, dockTree, freezer, composer, memoryHost, fileTree, selectFile };
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

/**
 * A pending approval, as `WcChatController` renders one: a
 * `[data-tool-ui-request]` container holding the card's dip iframe. The
 * container is what states "still pending" — it is removed when the request
 * is answered.
 */
function approval(thread: HTMLElement, requestId: string, options: { inline?: boolean } = {}) {
  const card = document.createElement('div');
  card.className = 'msg__dip';
  card.setAttribute('data-tool-ui-request', requestId);
  thread.append(card);
  if (options.inline) {
    const button = document.createElement('button');
    button.dataset.action = 'approve';
    card.append(button);
    return { card, button };
  }
  const frame = document.createElement('iframe');
  card.append(frame);
  const button = frame.contentDocument?.createElement('button');
  if (button) {
    button.dataset.action = 'approve';
    frame.contentDocument?.body.append(button);
  }
  return { card, frame, button };
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
  it("lands on the button inside the card's dip iframe", () => {
    const { deps, thread } = harness();
    const { button } = approval(thread, 'req-1');
    focusApproval(deps);
    expect(button?.ownerDocument.activeElement).toBe(button);
  });

  it("focuses an inline card's own button", () => {
    const { deps, thread } = harness();
    const { button } = approval(thread, 'req-1', { inline: true });
    focusApproval(deps);
    expect(document.activeElement).toBe(button);
  });

  /**
   * The extension serves the same card from `sprinkle-sandbox.html`, another
   * origin, where the parent may not read `contentDocument` at all. Focusing
   * the FRAME still puts the keyboard inside the card.
   */
  it('focuses the frame itself when the dip is out of reach', () => {
    const { deps, thread } = harness();
    const { frame } = approval(thread, 'req-1');
    Object.defineProperty(frame, 'contentDocument', {
      get() {
        throw new Error('cross-origin');
      },
    });
    focusApproval(deps);
    expect(document.activeElement).toBe(frame);
  });

  it('walks to the next card when pressed again, wrapping', () => {
    const { deps, thread } = harness();
    const first = approval(thread, 'req-1');
    const second = approval(thread, 'req-2');
    focusApproval(deps);
    expect(first.button?.ownerDocument.activeElement).toBe(first.button);
    focusApproval(deps);
    expect(second.button?.ownerDocument.activeElement).toBe(second.button);
    focusApproval(deps);
    expect(first.button?.ownerDocument.activeElement).toBe(first.button);
  });

  /** Answering a request removes its container, so it leaves the cycle. */
  it('never stops on a request that has been answered', () => {
    const { deps, thread } = harness();
    const answered = approval(thread, 'req-1');
    const live = approval(thread, 'req-2');
    answered.card.remove();
    focusApproval(deps);
    expect(live.button?.ownerDocument.activeElement).toBe(live.button);
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

  it('resolves surfaces from the live frame when the dock-tree has been detached', () => {
    // Mirrors panelizeShell: surfaces live under the frame's layout; dockTree
    // is no longer in the document.
    const { deps, dockTree } = harness({ activeDock: 'term' });
    const frame = document.createElement('div');
    const layout = document.createElement('div');
    const { requestFullscreen } = surface(layout, 'term');
    frame.append(layout);
    document.body.append(frame);
    dockTree.remove();
    deps.frame = frame;
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
  /**
   * The rows on SCREEN, which is why this reads `visibleIds()` and not
   * `items`: the items array is nested (a root's files sit under `children`)
   * and says nothing about what is expanded, so counting it would make `f 3`
   * miss every file and `f 1` select a directory.
   */
  it('indexes the file tree by the rows it is showing', () => {
    const h = harness();
    h.fileTree.rows = ['/workspace', '/workspace/a.ts', '/workspace/b.ts'];
    const list = shortcutLists(h.deps).files;
    expect(list.size()).toBe(3);
    list.selectAt(2);
    expect(h.selectFile).toHaveBeenCalledWith('/workspace/b.ts');
  });

  /** Expanding a directory changes the numbering, and must. */
  it('re-reads the rows on every press', () => {
    const h = harness();
    h.fileTree.rows = ['/workspace'];
    const list = shortcutLists(h.deps).files;
    expect(list.size()).toBe(1);
    h.fileTree.rows = ['/workspace', '/workspace/a.ts'];
    expect(list.size()).toBe(2);
  });

  it('skips the cards the freezer search has filtered out', () => {
    const h = harness();
    const clicks: string[] = [];
    for (const [slug, hidden] of [
      ['jan', true],
      ['feb', false],
      ['mar', true],
    ] as const) {
      const card = document.createElement('slicc-freezer-card');
      card.setAttribute('slug', slug);
      // What `<slicc-freezer>`'s live search does: hide, do not remove.
      if (hidden) card.classList.add('match-hidden');
      card.addEventListener('click', () => clicks.push(slug));
      h.freezer.append(card);
    }
    const list = shortcutLists(h.deps).sessions;
    // Only the match counts, and `1` is the first row actually on screen.
    expect(list.size()).toBe(1);
    list.selectAt(0);
    expect(clicks).toEqual(['feb']);
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

describe('toggleVoice', () => {
  it("drives the composer's hands-free push-to-talk", () => {
    const { deps, composer } = harness();
    const toggleHandsFree = vi.fn(() => true);
    Object.assign(composer, { toggleHandsFree });
    toggleVoice(deps);
    expect(toggleHandsFree).toHaveBeenCalledTimes(1);
  });

  /** No `ptt` opt-in, or an element the browser has not upgraded. */
  it('does nothing on a composer without the entry point', () => {
    const { deps } = harness();
    expect(() => toggleVoice(deps)).not.toThrow();
  });
});

describe('scrollMessage', () => {
  /** Give the thread and its rows a geometry jsdom will not invent. */
  function rows(thread: HTMLElement, tops: number[]) {
    thread.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    for (const top of tops) {
      const row = document.createElement('slicc-agent-message');
      row.getBoundingClientRect = () => ({ top }) as DOMRect;
      thread.append(row);
    }
  }

  it('scrolls to the first message below the fold', () => {
    const { deps, thread } = harness();
    rows(thread, [-200, -40, 120, 400]);
    scrollMessage(deps, 1);
    expect(thread.scrollTop).toBe(120);
  });

  it('goes back to the last one above it', () => {
    const { deps, thread } = harness();
    thread.scrollTop = 500;
    rows(thread, [-200, -40, 120, 400]);
    scrollMessage(deps, -1);
    // The nearest row above the fold, not the top of the transcript.
    expect(thread.scrollTop).toBe(460);
  });

  it('stays put at either end', () => {
    const { deps, thread } = harness();
    rows(thread, [10, 200]);
    scrollMessage(deps, -1);
    expect(thread.scrollTop).toBe(0);
  });

  it('does nothing in an empty transcript', () => {
    const { deps, thread } = harness();
    thread.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    expect(() => scrollMessage(deps, 1)).not.toThrow();
    expect(thread.scrollTop).toBe(0);
  });
});
