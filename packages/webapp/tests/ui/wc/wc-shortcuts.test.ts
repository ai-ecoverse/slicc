// @vitest-environment jsdom
/**
 * The WC shell's modal keyboard mode: the two-press Escape contract, the
 * bare-letter command table inside the mode, and the guarantees that keep it
 * out of the way of typing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deepTarget,
  digitFor,
  hasOpenOverlay,
  isTypingTarget,
  nextInCycle,
  shortcutRows,
  sprinkleIds,
  unitKeyForDigit,
  wireKeyboardShortcuts,
} from '../../../src/ui/wc/wc-shortcuts.js';

/** Every wiring made by a test, torn down after it — a leaked document
 *  listener from one test claims (and `preventDefault`s) the next one's keys. */
const wired: Array<{ dispose(): void }> = [];

function harness(
  options: {
    tabs?: string[];
    activeTab?: string | null;
    dockItems?: Array<{ id: string; kind?: 'sprinkle' | 'tool' }>;
    activeDock?: string | null;
    noComposer?: boolean;
    noDock?: boolean;
    noFreezer?: boolean;
  } = {}
) {
  const keys = options.tabs ?? ['cone_1', 'cone_2', 'scoop_a'];
  const select = vi.fn();
  const selectItem = vi.fn();
  const focusComposer = vi.fn();
  const toggle = vi.fn();
  const accounts = vi.fn();
  const switcher = {
    scoops: keys.map((key) => ({ key, label: key })),
    active: options.activeTab === undefined ? (keys[0] ?? null) : options.activeTab,
    select,
  };
  const dock = {
    items: options.dockItems ?? [
      { id: 'files', kind: 'tool' as const },
      { id: 'new', kind: 'sprinkle' as const },
    ],
    active: options.activeDock ?? null,
    selectItem,
  };
  const freezer = Object.assign(document.createElement('div'), { toggle });
  document.body.append(freezer);
  const newChat = vi.fn();
  freezer.addEventListener('new-chat-save', newChat);
  const handles = wireKeyboardShortcuts({
    switcher,
    ...(options.noDock ? {} : { dock }),
    ...(options.noFreezer ? {} : { freezer }),
    ...(options.noComposer ? {} : { focusComposer }),
    doc: document,
  });
  handles.setAction('accounts', accounts);
  wired.push(handles);
  return { handles, select, selectItem, focusComposer, toggle, newChat, accounts, freezer };
}

/** Dispatch a keydown on `target` (bubbling, so the document listener sees it). */
function press(init: KeyboardEventInit, target: EventTarget = document.body): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Enter (or leave) keyboard mode the way a user does. */
function escape(target: EventTarget = document.body): boolean {
  return press({ key: 'Escape', code: 'Escape' }, target);
}

afterEach(() => {
  while (wired.length > 0) wired.pop()?.dispose();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-slicc-keyboard-mode');
});

describe('digitFor', () => {
  it('reads the physical key, so Shift+3 is still 3', () => {
    expect(digitFor(new KeyboardEvent('keydown', { code: 'Digit3', key: '#' }))).toBe(3);
  });

  it('falls back to key when code is absent', () => {
    expect(digitFor(new KeyboardEvent('keydown', { key: '7' }))).toBe(7);
  });

  it('rejects 0 and non-digits', () => {
    expect(digitFor(new KeyboardEvent('keydown', { code: 'Digit0', key: '0' }))).toBeNull();
    expect(digitFor(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a' }))).toBeNull();
  });
});

describe('unitKeyForDigit', () => {
  const strip = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }];

  it('indexes the strip as rendered', () => {
    expect(unitKeyForDigit(strip, 1)).toBe('a');
    expect(unitKeyForDigit(strip, 3)).toBe('c');
  });

  it('maps 9 onto the last unit, like a browser tab', () => {
    expect(unitKeyForDigit(strip, 9)).toBe('d');
  });

  it('is null past the end and on an empty strip', () => {
    expect(unitKeyForDigit(strip, 5)).toBeNull();
    expect(unitKeyForDigit([], 9)).toBeNull();
  });
});

describe('nextInCycle', () => {
  it('wraps at the end', () => {
    expect(nextInCycle(['a', 'b', 'c'], 'c')).toBe('a');
    expect(nextInCycle(['a', 'b', 'c'], 'a')).toBe('b');
  });

  it('starts at the first entry when the current one is unknown', () => {
    expect(nextInCycle(['a', 'b'], null)).toBe('a');
    expect(nextInCycle(['a', 'b'], 'gone')).toBe('a');
  });

  it('is null only for an empty list', () => {
    expect(nextInCycle([], 'a')).toBeNull();
  });
});

describe('sprinkleIds', () => {
  it('keeps rail order and drops tools and the new launcher', () => {
    const dock = {
      items: [
        { id: 'sprinkle:b', kind: 'sprinkle' as const },
        { id: 'files', kind: 'tool' as const },
        { id: 'sprinkle:a', kind: 'sprinkle' as const },
        { id: 'new', kind: 'sprinkle' as const },
      ],
      active: null,
      selectItem: vi.fn(),
    };
    expect(sprinkleIds(dock)).toEqual(['sprinkle:b', 'sprinkle:a']);
  });
});

describe('isTypingTarget / deepTarget', () => {
  it('sees a textarea inside a shadow root through composedPath', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const textarea = document.createElement('textarea');
    root.append(textarea);
    document.body.append(host);
    let seen: boolean | null = null;
    document.addEventListener('keydown', (e) => {
      seen = isTypingTarget(deepTarget(e));
    });
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true }));
    expect(seen).toBe(true);
  });

  it('is false for a plain element', () => {
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('counts a node inside a contenteditable', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', '');
    const span = document.createElement('span');
    div.append(span);
    document.body.append(div);
    expect(isTypingTarget(span)).toBe(true);
  });

  it('does not count contenteditable="false"', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'false');
    document.body.append(div);
    expect(isTypingTarget(div)).toBe(false);
  });
});

describe('hasOpenOverlay', () => {
  it('sees the overlays that own Escape', () => {
    expect(hasOpenOverlay(document)).toBe(false);
    const dialog = document.createElement('slicc-dialog');
    document.body.append(dialog);
    // A closed dialog is not an overlay.
    expect(hasOpenOverlay(document)).toBe(false);
    dialog.setAttribute('open', '');
    expect(hasOpenOverlay(document)).toBe(true);
    dialog.remove();
    // Quick Look has no `open` attribute — its presence IS its open state.
    document.body.append(document.createElement('slicc-quick-look'));
    expect(hasOpenOverlay(document)).toBe(true);
  });
});

describe('shortcutRows', () => {
  it('documents Escape, the digits, and every command including its aliases', () => {
    const rows = shortcutRows();
    expect(rows[0].keys).toEqual(['Esc']);
    expect(rows[1].keys).toEqual(['1 – 9']);
    const flat = rows.flatMap((r) => r.keys);
    for (const key of ['d', 'c', '⏎', 'n', 'b', 'f', 't', 'e', 'm', 's', 'a', 'h', '?', '/']) {
      expect(flat).toContain(key);
    }
  });
});

describe('the Escape contract', () => {
  it('enters the mode on the first press and swallows it', () => {
    const { handles } = harness();
    expect(handles.active()).toBe(false);
    expect(escape()).toBe(true);
    expect(handles.active()).toBe(true);
    expect(document.documentElement.hasAttribute('data-slicc-keyboard-mode')).toBe(true);
  });

  it('leaves the mode on the second press and lets it through to the browser', () => {
    const { handles } = harness();
    escape();
    // NOT prevented: the second press is the one that may exit full screen.
    expect(escape()).toBe(false);
    expect(handles.active()).toBe(false);
    expect(document.documentElement.hasAttribute('data-slicc-keyboard-mode')).toBe(false);
  });

  it('performs the fullscreen exit itself, since Keyboard Lock hides it from the browser', () => {
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: document.body,
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreen,
    });
    const { handles } = harness();
    escape();
    expect(exitFullscreen).not.toHaveBeenCalled();
    escape();
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(handles.active()).toBe(false);
    Reflect.deleteProperty(document, 'fullscreenElement');
    Reflect.deleteProperty(document, 'exitFullscreen');
  });

  it('enters from inside the composer and blurs it', () => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();
    const { handles } = harness();
    escape(textarea);
    expect(handles.active()).toBe(true);
    expect(document.activeElement).not.toBe(textarea);
  });

  it('leaves an open overlay to handle its own Escape', () => {
    const dialog = document.createElement('slicc-dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    const { handles } = harness();
    expect(escape()).toBe(false);
    expect(handles.active()).toBe(false);
  });

  it('shows a mode badge while it is on', () => {
    harness();
    expect(document.querySelector('[data-wc-shortcuts="badge"]')).toBeNull();
    escape();
    expect(document.querySelector('[data-wc-shortcuts="badge"]')?.textContent).toContain(
      'Keyboard mode'
    );
    escape();
    expect(document.querySelector('[data-wc-shortcuts="badge"]')).toBeNull();
  });
});

describe('outside keyboard mode', () => {
  it('binds nothing at all', () => {
    const h = harness();
    for (const key of ['1', 'c', 'd', 'n', 'b', 'f', 't', 'e', 'm', 's', 'a', 'h', '?', '/']) {
      expect(press({ key, code: key === '1' ? 'Digit1' : `Key${key.toUpperCase()}` })).toBe(false);
    }
    expect(h.select).not.toHaveBeenCalled();
    expect(h.selectItem).not.toHaveBeenCalled();
    expect(h.focusComposer).not.toHaveBeenCalled();
    expect(h.toggle).not.toHaveBeenCalled();
    expect(h.accounts).not.toHaveBeenCalled();
    expect(h.handles.helpOverlay()).toBeNull();
  });
});

describe('inside keyboard mode', () => {
  it('switches agents by digit and keeps the mode', () => {
    const { handles, select } = harness();
    escape();
    expect(press({ key: '2', code: 'Digit2' })).toBe(true);
    expect(select).toHaveBeenCalledWith('cone_2');
    expect(handles.active()).toBe(true);
  });

  it('ignores a digit past the end of the strip', () => {
    const { select } = harness({ tabs: ['only'] });
    escape();
    expect(press({ key: '4', code: 'Digit4' })).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it('d walks the strip, looping past the end', () => {
    const { select } = harness({ activeTab: 'scoop_a' });
    escape();
    press({ key: 'd', code: 'KeyD' });
    expect(select).toHaveBeenCalledWith('cone_1');
  });

  it('c and Enter go back to the composer and leave the mode', () => {
    const { focusComposer, handles } = harness();
    escape();
    press({ key: 'c', code: 'KeyC' });
    expect(focusComposer).toHaveBeenCalledTimes(1);
    expect(handles.active()).toBe(false);
    escape();
    press({ key: 'Enter', code: 'Enter' });
    expect(focusComposer).toHaveBeenCalledTimes(2);
    expect(handles.active()).toBe(false);
  });

  it("n fires the rail action row's own new-chat event", () => {
    const { newChat, handles } = harness();
    escape();
    press({ key: 'n', code: 'KeyN' });
    expect(newChat).toHaveBeenCalledTimes(1);
    expect(handles.active()).toBe(false);
  });

  it('b toggles the left rail and keeps the mode', () => {
    const { toggle, handles } = harness();
    escape();
    press({ key: 'b', code: 'KeyB' });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(handles.active()).toBe(true);
  });

  it.each([
    ['f', 'files'],
    ['t', 'browser'],
    ['e', 'term'],
    ['m', 'memory'],
  ])('%s opens the %s dock surface and leaves the mode', (key, id) => {
    const { selectItem, handles } = harness();
    escape();
    press({ key, code: `Key${key.toUpperCase()}` });
    expect(selectItem).toHaveBeenCalledWith(id);
    expect(handles.active()).toBe(false);
  });

  it('s cycles the installed sprinkles', () => {
    const { selectItem } = harness({
      dockItems: [
        { id: 'files', kind: 'tool' },
        { id: 'sprinkle:one', kind: 'sprinkle' },
        { id: 'sprinkle:two', kind: 'sprinkle' },
        { id: 'new', kind: 'sprinkle' },
      ],
      activeDock: 'sprinkle:one',
    });
    escape();
    press({ key: 's', code: 'KeyS' });
    expect(selectItem).toHaveBeenCalledWith('sprinkle:two');
  });

  it('s falls back to the new-sprinkle launcher when none are installed', () => {
    const { selectItem, handles } = harness();
    escape();
    press({ key: 's', code: 'KeyS' });
    expect(selectItem).toHaveBeenCalledWith('new');
    // A cycle key holds the mode, so a second press can reach the next one.
    expect(handles.active()).toBe(true);
  });

  it('a opens accounts through the registered action', () => {
    const { accounts, handles } = harness();
    escape();
    press({ key: 'a', code: 'KeyA' });
    expect(accounts).toHaveBeenCalledTimes(1);
    expect(handles.active()).toBe(false);
  });

  it.each(['h', '?', '/'])('%s toggles the help overlay', (key) => {
    const { handles } = harness();
    escape();
    press({ key, code: 'KeyH' });
    const overlay = handles.helpOverlay();
    expect(overlay?.getAttribute('heading')).toBe('Keyboard mode');
    expect(overlay?.querySelectorAll('.wcsc__row')).toHaveLength(shortcutRows().length);
    press({ key, code: 'KeyH' });
    expect(handles.helpOverlay()).toBeNull();
  });

  it('forgets an overlay that dismissed itself', () => {
    const { handles } = harness();
    handles.showHelp();
    handles
      .helpOverlay()
      ?.dispatchEvent(new CustomEvent('slicc-dialog-close', { detail: { reason: 'escape' } }));
    expect(handles.helpOverlay()).toBeNull();
  });

  it('an unbound key is not an exit — the mode is sticky', () => {
    const { handles } = harness();
    escape();
    expect(press({ key: 'z', code: 'KeyZ' })).toBe(false);
    expect(handles.active()).toBe(true);
  });

  it('never claims a chord the browser or the OS owns', () => {
    const { select, handles } = harness();
    escape();
    expect(press({ key: '2', code: 'Digit2', metaKey: true })).toBe(false);
    expect(press({ key: 'r', code: 'KeyR', ctrlKey: true })).toBe(false);
    expect(select).not.toHaveBeenCalled();
    expect(handles.active()).toBe(true);
  });

  it('does not steal a keystroke aimed at a text field', () => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    const { select, handles } = harness();
    handles.setActive(true);
    expect(press({ key: '2', code: 'Digit2' }, textarea)).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it('leaves the mode when focus lands in a text field', () => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    const { handles } = harness();
    escape();
    textarea.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(handles.active()).toBe(false);
  });

  it('degrades to no-ops on a float without the surfaces', () => {
    const { handles } = harness({ noDock: true, noFreezer: true, noComposer: true });
    escape();
    for (const key of ['f', 'b', 'n', 's', 'c']) {
      expect(() => press({ key, code: `Key${key.toUpperCase()}` })).not.toThrow();
    }
    expect(handles.helpOverlay()).toBeNull();
  });
});

describe('dispose', () => {
  it('removes the listeners, the badge and any overlay', () => {
    const { handles, select } = harness();
    escape();
    handles.showHelp();
    handles.dispose();
    expect(document.querySelector('slicc-dialog')).toBeNull();
    expect(document.querySelector('[data-wc-shortcuts="badge"]')).toBeNull();
    expect(handles.active()).toBe(false);
    escape();
    press({ key: '1', code: 'Digit1' });
    expect(select).not.toHaveBeenCalled();
  });
});
