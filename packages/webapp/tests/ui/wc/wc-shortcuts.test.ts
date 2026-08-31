// @vitest-environment jsdom
/**
 * The WC shell's modal keyboard mode: the two-press Escape contract, the
 * bare-letter command table inside the mode, and the guarantees that keep it
 * out of the way of typing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_IDS,
  DEFAULT_KEYMAP,
  deepActiveElement,
  deepTarget,
  describeKey,
  digitFor,
  hasOpenOverlay,
  indexForDigit,
  isActivationTarget,
  isTypingTarget,
  nextInCycle,
  prevInCycle,
  shortcutRows,
  sprinkleIds,
  unitKeyForDigit,
  wireKeyboardShortcuts,
} from '../../../src/ui/wc/wc-shortcuts.js';

/** Every wiring made by a test, torn down after it — a leaked document
 *  listener from one test claims (and `preventDefault`s) the next one's keys. */
const wired: Array<{ dispose(): void }> = [];

/** Let the deferred settle (and any MutationObserver record) run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(
  options: {
    tabs?: string[];
    activeTab?: string | null;
    dockItems?: Array<{ id: string; kind?: 'sprinkle' | 'tool' }>;
    activeDock?: string | null;
    models?: string[];
    noComposer?: boolean;
    noDock?: boolean;
    noFreezer?: boolean;
    composerAvailable?: () => boolean;
    /** Rows the `files` / `sessions` chord lists report. */
    files?: string[];
    sessions?: string[];
  } = {}
) {
  const keys = options.tabs ?? ['cone_1', 'cone_2', 'scoop_a'];
  const select = vi.fn();
  const selectItem = vi.fn();
  /**
   * A real field, because `focusComposer` really does move the caret: the mode
   * settles against the DOM, so a spy that focused nothing would land back in
   * keyboard mode — which is exactly the fallback a composer that REFUSES the
   * focus is supposed to get.
   */
  const composerField = document.createElement('textarea');
  document.body.append(composerField);
  const focusComposer = vi.fn(() => composerField.focus());
  const toggle = vi.fn();
  const accounts = vi.fn();
  /**
   * A real element, standing in for `<slicc-agent-tabs>`: the module watches
   * the `active` ATTRIBUTE for unit switches, so a plain object would have no
   * selection to observe. An unregistered tag rather than the real one, whose
   * `select` is typed and would not take a spy. `select` stays a pure spy —
   * the tests move the selection with `switchTo`, which is what every float
   * does on its own.
   */
  const switcher = document.createElement('slicc-agent-tabs-stub') as HTMLElement & {
    scoops: Array<{ key: string; label?: string }>;
    active: string | null;
    select: typeof select;
  };
  Object.defineProperty(switcher, 'active', {
    configurable: true,
    get: () => switcher.getAttribute('active'),
  });
  switcher.scoops = keys.map((key) => ({ key, label: key }));
  switcher.select = select;
  const initialTab = options.activeTab === undefined ? (keys[0] ?? null) : options.activeTab;
  if (initialTab !== null) switcher.setAttribute('active', initialTab);
  document.body.append(switcher);
  const collapse = vi.fn();
  const dock: {
    items: Array<{ id: string; kind?: 'sprinkle' | 'tool' }>;
    active: string | null;
    selectItem: typeof selectItem;
    collapse: typeof collapse;
  } = {
    items: options.dockItems ?? [
      { id: 'files', kind: 'tool' as const },
      { id: 'new', kind: 'sprinkle' as const },
    ],
    active: options.activeDock ?? null,
    selectItem,
    collapse,
  };
  const openMenu = vi.fn();
  const composerMeta = { models: options.models ?? ['claude-opus-4-6'], openMenu };
  const freezer = Object.assign(document.createElement('div'), { toggle });
  document.body.append(freezer);
  const newChat = vi.fn();
  const erase = vi.fn();
  const newCone = vi.fn();
  const dropCone = vi.fn();
  freezer.addEventListener('new-chat-save', newChat);
  freezer.addEventListener('new-chat-erase', erase);
  freezer.addEventListener('new-cone', newCone);
  freezer.addEventListener('drop-cone', dropCone);
  const stopTurn = vi.fn();
  const focusApproval = vi.fn();
  const openAttachMenu = vi.fn();
  const copyReply = vi.fn();
  const copyChat = vi.fn();
  const zoomSurface = vi.fn();
  const selectFile = vi.fn();
  const selectSession = vi.fn();
  const files = options.files ?? [];
  const sessions = options.sessions ?? [];
  const handles = wireKeyboardShortcuts({
    switcher,
    composerMeta,
    stopTurn,
    focusApproval,
    openAttachMenu,
    copyReply,
    copyChat,
    zoomSurface,
    lists: {
      files: { size: () => files.length, selectAt: (i) => selectFile(files[i]) },
      sessions: { size: () => sessions.length, selectAt: (i) => selectSession(sessions[i]) },
    },
    ...(options.noDock ? {} : { dock }),
    ...(options.noFreezer ? {} : { freezer }),
    ...(options.noComposer ? {} : { focusComposer }),
    ...(options.composerAvailable ? { composerAvailable: options.composerAvailable } : {}),
    doc: document,
  });
  handles.setAction('accounts', accounts);
  wired.push(handles);
  return {
    handles,
    dock,
    composerField,
    switcher,
    select,
    selectItem,
    collapse,
    openMenu,
    focusComposer,
    toggle,
    newChat,
    erase,
    newCone,
    dropCone,
    stopTurn,
    focusApproval,
    openAttachMenu,
    copyReply,
    copyChat,
    zoomSurface,
    selectFile,
    selectSession,
    accounts,
    freezer,
    /** Move the selection the way a float does, and let the mode react. */
    switchTo: async (key: string): Promise<void> => {
      switcher.setAttribute('active', key);
      await flush();
    },
  };
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

/**
 * jsdom always reports a document nobody is looking at, and the mode
 * deliberately stays out of one (an unfocused Cherry iframe in a host page
 * must not wear the badge for a keyboard it does not have). Every test but the
 * one that checks THAT rule speaks for a document the user is looking at.
 */
beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  while (wired.length > 0) wired.pop()?.dispose();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-slicc-keyboard-mode');
  vi.restoreAllMocks();
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
      collapse: vi.fn(),
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

  /**
   * The shell mounts `<slicc-permissions>` and `<slicc-tab-overlay>` once at
   * boot and leaves them there for the session. A selector that matched the
   * bare tag swallowed EVERY Escape, so the mode could never be entered —
   * which is exactly what happened the first time this shipped.
   */
  it('does not mistake the always-mounted overlay hosts for open ones', () => {
    document.body.append(
      document.createElement('slicc-permissions'),
      document.createElement('slicc-tab-overlay')
    );
    expect(hasOpenOverlay(document)).toBe(false);
    const prompt = document.createElement('div');
    prompt.className = 'slicc-permissions__prompt';
    prompt.setAttribute('data-open', '');
    document.body.append(prompt);
    expect(hasOpenOverlay(document)).toBe(true);
  });
});

describe('shortcutRows', () => {
  it('documents Escape, the digits, and every command including its aliases', () => {
    const rows = shortcutRows();
    expect(rows[0].keys).toEqual(['Esc']);
    expect(rows[1].keys).toEqual(['1 – 9']);
    const flat = rows.flatMap((r) => r.keys);
    for (const key of [
      '→',
      '←',
      'i',
      '⏎',
      'n',
      'N',
      's',
      'a',
      'u',
      'y',
      'f',
      't',
      'b',
      'm',
      'g',
      'p',
      '[',
      ']',
      'z',
      'l',
      ',',
      '?',
    ]) {
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

  it('keeps the mode on a second press and lets it through to the browser', () => {
    const { handles } = harness();
    escape();
    // NOT prevented: a press inside the mode is the one that may exit full
    // screen. The mode itself is the resting state and has nothing to leave.
    expect(escape()).toBe(false);
    expect(handles.active()).toBe(true);
    expect(document.documentElement.hasAttribute('data-slicc-keyboard-mode')).toBe(true);
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
    expect(handles.active()).toBe(true);
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

  it('records leaving the composer as a CHOICE, so a switch does not undo it', () => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();
    const { handles } = harness();
    expect(handles.intent()).toBe('composer');
    escape(textarea);
    expect(handles.intent()).toBe('keyboard');
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
    const { handles } = harness();
    expect(document.querySelector('[data-wc-shortcuts="badge"]')).toBeNull();
    escape();
    expect(document.querySelector('[data-wc-shortcuts="badge"]')?.textContent).toContain(
      'Keyboard mode'
    );
    handles.setActive(false);
    expect(document.querySelector('[data-wc-shortcuts="badge"]')).toBeNull();
  });
});

describe('outside keyboard mode', () => {
  it('binds nothing at all', () => {
    const h = harness();
    for (const key of ['1', 'i', 'n', 'b', 'f', 't', 'm', 's', 'l', 'a', 'y', 'z']) {
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

  it('→ walks the strip, looping past the end', () => {
    const { select } = harness({ activeTab: 'scoop_a' });
    escape();
    press({ key: 'ArrowRight', code: 'ArrowRight' });
    expect(select).toHaveBeenCalledWith('cone_1');
  });

  it('← walks it the other way, looping past the front', () => {
    const { select } = harness({ activeTab: 'cone_1' });
    escape();
    press({ key: 'ArrowLeft', code: 'ArrowLeft' });
    expect(select).toHaveBeenCalledWith('scoop_a');
  });

  it('i and Enter go back to the composer and leave the mode', () => {
    const { focusComposer, handles } = harness();
    escape();
    press({ key: 'i', code: 'KeyI' });
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

  it('[ toggles the left rail and keeps the mode', () => {
    const { toggle, handles } = harness();
    escape();
    press({ key: '[', code: 'BracketLeft' });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(handles.active()).toBe(true);
  });

  it.each([
    ['b', 'browser'],
    ['t', 'term'],
    ['g', 'monitor'],
  ])('%s opens the %s dock surface and leaves the mode', (key, id) => {
    const { selectItem, handles } = harness();
    escape();
    press({ key, code: `Key${key.toUpperCase()}` });
    expect(selectItem).toHaveBeenCalledWith(id);
    expect(handles.active()).toBe(false);
  });

  /**
   * The two panels that own a chord list keep the keyboard instead: the digit
   * that completes `f 3` has to land while the mode is still on, and neither
   * panel takes the focus a dropped mode would be predicting.
   */
  it.each([
    ['f', 'files'],
    ['m', 'memory'],
  ])('%s opens the %s dock surface and KEEPS the mode', (key, id) => {
    const { selectItem, handles } = harness();
    escape();
    press({ key, code: `Key${key.toUpperCase()}` });
    expect(selectItem).toHaveBeenCalledWith(id);
    expect(handles.active()).toBe(true);
  });

  it('P cycles the installed sprinkles', () => {
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
    press({ key: 'P', code: 'KeyP', shiftKey: true });
    expect(selectItem).toHaveBeenCalledWith('sprinkle:two');
  });

  it('P falls back to the new-sprinkle launcher when none are installed', () => {
    const { selectItem, handles } = harness();
    escape();
    press({ key: 'P', code: 'KeyP', shiftKey: true });
    expect(selectItem).toHaveBeenCalledWith('new');
    // A cycle key holds the mode, so a second press can reach the next one.
    expect(handles.active()).toBe(true);
  });

  /**
   * The chord prefix has to be idempotent, or `p 3` would flash whichever
   * sprinkle the cycle happened to land on before opening the third.
   */
  it('p opens the FIRST sprinkle rather than cycling', () => {
    const { selectItem } = harness({
      dockItems: [
        { id: 'sprinkle:one', kind: 'sprinkle' },
        { id: 'sprinkle:two', kind: 'sprinkle' },
      ],
      activeDock: 'sprinkle:one',
    });
    escape();
    press({ key: 'p', code: 'KeyP' });
    expect(selectItem).toHaveBeenCalledWith('sprinkle:one');
  });

  it('] closes the open right-hand panel, and reopens the last one', () => {
    const h = harness({ activeDock: 'memory' });
    // The real `<slicc-dock>` clears `active` when it collapses; the stub has
    // to be told, or the second press would just collapse again.
    h.collapse.mockImplementation(() => {
      h.dock.active = null;
    });
    escape();
    press({ key: ']', code: 'BracketRight' });
    expect(h.collapse).toHaveBeenCalledTimes(1);
    // A chrome toggle is navigation, so the mode survives it — as with `b`.
    expect(h.handles.active()).toBe(true);
    press({ key: ']', code: 'BracketRight' });
    expect(h.selectItem).toHaveBeenCalledWith('memory');
  });

  it('] falls back to Files on a shell that has never opened a panel', () => {
    const { selectItem } = harness({ activeDock: null });
    escape();
    press({ key: ']', code: 'BracketRight' });
    expect(selectItem).toHaveBeenCalledWith('files');
  });

  it('] reopens the surface a letter key last went to', () => {
    const { selectItem } = harness({ activeDock: null });
    escape();
    press({ key: 't', code: 'KeyT' }); // terminal
    escape();
    press({ key: ']', code: 'BracketRight' });
    expect(selectItem).toHaveBeenLastCalledWith('term');
  });

  it('l opens the model picker', () => {
    const { openMenu, handles } = harness();
    escape();
    press({ key: 'l', code: 'KeyL' });
    expect(openMenu).toHaveBeenCalledTimes(1);
    expect(handles.active()).toBe(false);
  });

  it('l routes to accounts when no account is connected, like clicking the pill', () => {
    const { openMenu, accounts } = harness({ models: [] });
    escape();
    press({ key: 'l', code: 'KeyL' });
    expect(openMenu).not.toHaveBeenCalled();
    expect(accounts).toHaveBeenCalledTimes(1);
  });

  it(', opens accounts through the registered action', () => {
    const { accounts, handles } = harness();
    escape();
    press({ key: ',', code: 'Comma' });
    expect(accounts).toHaveBeenCalledTimes(1);
    expect(handles.active()).toBe(false);
  });

  it.each(['?'])('%s toggles the help overlay', (key) => {
    const { handles } = harness();
    escape();
    press({ key, code: 'Slash', shiftKey: true });
    const overlay = handles.helpOverlay();
    expect(overlay?.getAttribute('heading')).toBe('Keyboard mode');
    expect(overlay?.querySelectorAll('.wcsc__row')).toHaveLength(shortcutRows().length);
    press({ key, code: 'Slash', shiftKey: true });
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
    expect(press({ key: 'q', code: 'KeyQ' })).toBe(false);
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
    for (const key of ['f', 'b', 'n', 's', 'i', 'y', 'z', 'u']) {
      expect(() => press({ key, code: `Key${key.toUpperCase()}` })).not.toThrow();
    }
    expect(handles.helpOverlay()).toBeNull();
  });
});

describe('the key HUD', () => {
  const caps = () =>
    [...document.querySelectorAll('[data-wc-shortcuts="keys"] .wcsc-badge__press')].map((p) => ({
      keys: [...p.querySelectorAll('kbd')].map((k) => k.textContent).join(''),
      bound: (p as HTMLElement).dataset.bound,
      age: (p as HTMLElement).dataset.age,
    }));
  const hint = () => document.querySelector<HTMLElement>('.wcsc-badge__hint');

  it('prints the press that opened the mode', () => {
    harness();
    escape();
    expect(caps()).toEqual([{ keys: 'Esc', bound: 'true', age: undefined }]);
    // The hint gives way to the strip; they never share the pill.
    expect(hint()?.hidden).toBe(true);
  });

  it('accumulates presses left to right, staling everything but the newest', () => {
    harness();
    escape();
    press({ key: 's', code: 'KeyS' });
    press({ key: '2', code: 'Digit2' });
    expect(caps()).toEqual([
      { keys: 'Esc', bound: 'true', age: 'stale' },
      { keys: 's', bound: 'true', age: 'stale' },
      { keys: '2', bound: 'true', age: undefined },
    ]);
  });

  it('shows an unbound key dimmed rather than not at all', () => {
    harness();
    escape();
    press({ key: 'q', code: 'KeyQ' });
    expect(caps().at(-1)).toEqual({ keys: 'q', bound: 'false', age: undefined });
  });

  it('shows a digit past the end of the strip as unbound', () => {
    harness({ tabs: ['only'] });
    escape();
    press({ key: '4', code: 'Digit4' });
    expect(caps().at(-1)).toEqual({ keys: '4', bound: 'false', age: undefined });
  });

  it('marks a press suspended behind a modal as unbound', () => {
    harness();
    escape();
    const dialog = document.createElement('slicc-dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    press({ key: 'f', code: 'KeyF' });
    expect(caps().at(-1)).toEqual({ keys: 'f', bound: 'false', age: undefined });
  });

  it('keeps only the last few presses', () => {
    harness();
    escape();
    for (const key of ['s', 'q', 's', 'q', 's']) press({ key, code: `Key${key.toUpperCase()}` });
    expect(caps()).toHaveLength(4);
    expect(caps().at(-1)?.keys).toBe('s');
  });

  it('clears itself after a quiet spell and the hint returns', () => {
    vi.useFakeTimers();
    try {
      harness();
      escape();
      press({ key: 's', code: 'KeyS' });
      expect(caps()).toHaveLength(2);
      vi.advanceTimersByTime(1000);
      // Still within the linger window, and a new press restarts it.
      press({ key: 's', code: 'KeyS' });
      vi.advanceTimersByTime(1000);
      expect(caps()).toHaveLength(3);
      vi.advanceTimersByTime(1000);
      expect(caps()).toHaveLength(0);
      expect(hint()?.hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes away with the mode', () => {
    const { handles } = harness();
    escape();
    press({ key: 's', code: 'KeyS' });
    handles.setActive(false);
    expect(document.querySelector('[data-wc-shortcuts="keys"]')).toBeNull();
  });

  it('never announces the typing — only the mode is a live region', () => {
    harness();
    escape();
    expect(document.querySelector('[data-wc-shortcuts="badge"]')?.getAttribute('aria-live')).toBe(
      'polite'
    );
    expect(document.querySelector('[data-wc-shortcuts="keys"]')?.getAttribute('aria-hidden')).toBe(
      'true'
    );
  });
});

describe('describeKey', () => {
  const ev = (init: Partial<KeyboardEvent>) =>
    ({ key: 'a', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }) as Pick<
      KeyboardEvent,
      'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
    >;

  it('prints a plain key as itself', () => {
    expect(describeKey(ev({ key: 'b' }))).toEqual(['b']);
  });

  it('names the keys that have no glyph', () => {
    expect(describeKey(ev({ key: 'Escape' }))).toEqual(['Esc']);
    expect(describeKey(ev({ key: 'Enter' }))).toEqual(['⏎']);
    expect(describeKey(ev({ key: ' ' }))).toEqual(['Space']);
    expect(describeKey(ev({ key: 'ArrowLeft' }))).toEqual(['←']);
  });

  it('spells modifiers as caps, in one press', () => {
    expect(describeKey(ev({ key: 'k', ctrlKey: true }))).toEqual(['⌃', 'k']);
    expect(describeKey(ev({ key: 'k', metaKey: true, altKey: true }))).toEqual(['⌥', '⌘', 'k']);
  });

  it('leaves Shift off a printed character, which already carries it', () => {
    expect(describeKey(ev({ key: '?', shiftKey: true }))).toEqual(['?']);
    expect(describeKey(ev({ key: 'Tab', shiftKey: true }))).toEqual(['⇧', '⇥']);
  });
});

describe('the keymap', () => {
  it('every command has at least one default key', () => {
    const bound = new Set(Object.values(DEFAULT_KEYMAP));
    expect([...COMMAND_IDS].filter((id) => !bound.has(id))).toEqual([]);
  });

  it('a rebind moves the command to the new key and frees the old one', () => {
    const { handles, toggle, selectItem } = harness();
    handles.setKeymap({ q: 'leftRail' });
    escape();
    press({ key: 'q', code: 'KeyQ' });
    expect(toggle).toHaveBeenCalledTimes(1);
    // `b` was not in the new map at all, so it now does nothing.
    press({ key: 'b', code: 'KeyB' });
    expect(toggle).toHaveBeenCalledTimes(1);
    // …and neither does a command the map dropped entirely.
    press({ key: 'f', code: 'KeyF' });
    expect(selectItem).not.toHaveBeenCalled();
  });

  it('is applied whole, not merged — the loader owns merging', () => {
    const { handles } = harness();
    handles.setKeymap({ q: 'help' });
    expect(handles.keymap()).toEqual({ q: 'help' });
  });

  it('the help sheet follows the live keymap', () => {
    const { handles } = harness();
    handles.setKeymap({ q: 'help', z: 'help', w: 'terminal' });
    handles.showHelp();
    const rows = [...(handles.helpOverlay()?.querySelectorAll('.wcsc__row') ?? [])].map(
      (r) => r.textContent
    );
    expect(rows.some((t) => t?.includes('This help') && t.includes('q') && t.includes('z'))).toBe(
      true
    );
    expect(rows.some((t) => t?.includes('Terminal') && t.includes('w'))).toBe(true);
    // A command nobody has a key for is not printed as if it were reachable.
    expect(rows.some((t) => t?.includes('File browser'))).toBe(false);
  });

  it('shortcutRows keeps Esc and the digits, whatever the keymap says', () => {
    const rows = shortcutRows({ q: 'help' });
    expect(rows[0].keys).toEqual(['Esc']);
    expect(rows[1].keys).toEqual(['1 – 9']);
    expect(rows).toHaveLength(3);
  });
});

describe('while a modal is open', () => {
  /**
   * Codex P2: `c` reached the composer BEHIND an open dialog, leaving the
   * modal up and the caret in obscured UI.
   */
  it('suspends the commands that would act behind it', () => {
    const { handles, focusComposer, select, selectItem } = harness();
    escape();
    const dialog = document.createElement('slicc-dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    expect(press({ key: 'c', code: 'KeyC' })).toBe(false);
    expect(press({ key: '2', code: 'Digit2' })).toBe(false);
    expect(press({ key: 'f', code: 'KeyF' })).toBe(false);
    expect(focusComposer).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(selectItem).not.toHaveBeenCalled();
    // The mode survives — the modal is a suspension, not an exit.
    expect(handles.active()).toBe(true);
  });

  it('still lets ? close the help overlay it opened', () => {
    const { handles } = harness();
    escape();
    press({ key: '?', code: 'Slash', shiftKey: true });
    const overlay = handles.helpOverlay();
    expect(overlay).not.toBeNull();
    // jsdom never upgrades `<slicc-dialog>`, so `show()` cannot set `open`;
    // mark it the way the real component would, to prove the gate lets the
    // toggle through the very overlay it is guarding.
    overlay?.setAttribute('open', '');
    press({ key: '?', code: 'Slash', shiftKey: true });
    expect(handles.helpOverlay()).toBeNull();
  });

  it('does not let h stack a second overlay on someone else’s modal', () => {
    const { handles } = harness();
    escape();
    const dialog = document.createElement('slicc-dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    press({ key: '?', code: 'Slash', shiftKey: true });
    expect(handles.helpOverlay()).toBeNull();
  });
});

describe('deepActiveElement', () => {
  it('reaches the field inside a shadow root, not its host', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const field = document.createElement('textarea');
    root.append(field);
    field.focus();
    expect(document.activeElement).toBe(host);
    expect(deepActiveElement(document)).toBe(field);
    expect(isTypingTarget(deepActiveElement(document))).toBe(true);
  });

  it('is the body when nothing is focused', () => {
    expect(deepActiveElement(document)).toBe(document.body);
  });
});

describe('isActivationTarget', () => {
  it('knows the controls a bare Enter belongs to', () => {
    const button = document.createElement('button');
    const link = Object.assign(document.createElement('a'), { href: '#x' });
    const bare = document.createElement('a');
    const role = document.createElement('div');
    role.setAttribute('role', 'menuitem');
    expect(isActivationTarget(button)).toBe(true);
    expect(isActivationTarget(link)).toBe(true);
    // An anchor with no href is not focusable and activates nothing.
    expect(isActivationTarget(bare)).toBe(false);
    expect(isActivationTarget(role)).toBe(true);
    expect(isActivationTarget(document.createElement('div'))).toBe(false);
    expect(isActivationTarget(null)).toBe(false);
  });
});

describe('the mode is the resting state', () => {
  it('turns itself on once nothing holds the focus', async () => {
    const { handles } = harness();
    expect(handles.active()).toBe(false);
    await flush();
    expect(handles.active()).toBe(true);
    expect(handles.intent()).toBe('keyboard');
  });

  it('stays off while a text field has the focus', async () => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();
    const { handles } = harness();
    await flush();
    expect(handles.active()).toBe(false);
    expect(handles.intent()).toBe('composer');
  });

  it('comes on when the composer loses the focus to nothing', async () => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();
    const { handles } = harness();
    await flush();
    expect(handles.active()).toBe(false);
    textarea.blur();
    await flush();
    expect(handles.active()).toBe(true);
    expect(handles.intent()).toBe('keyboard');
  });

  it('goes off again the moment a field takes the focus back', async () => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    const { handles } = harness();
    await flush();
    expect(handles.active()).toBe(true);
    textarea.focus();
    // Inline, not on the settle: a keystroke can arrive in the same task as
    // the click that focused the field, and it must be typed.
    expect(handles.active()).toBe(false);
    await flush();
    expect(handles.intent()).toBe('composer');
  });

  it('leaves an open modal in charge of the keyboard', async () => {
    const dialog = document.createElement('slicc-dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    const { handles } = harness();
    await flush();
    expect(handles.active()).toBe(false);
  });

  it('does not dress a document nobody is looking at', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    const { handles } = harness();
    await flush();
    expect(handles.active()).toBe(false);
  });

  /**
   * Codex P2: `holdsMode: false` is a PREDICTION that the surface will take the
   * focus. `dock.selectItem()` only emits a selection, and the files and memory
   * panels focus nothing — so the mode was left off with nothing focused, badge
   * gone and letters dead.
   */
  it('settles again after a command whose surface never took the focus', async () => {
    const { handles, selectItem } = harness();
    escape();
    // The terminal is the honest case: it is expected to take the focus, so
    // the mode drops for it — and in a test (as in a panel that has not
    // mounted yet) nothing does.
    expect(press({ key: 't', code: 'KeyT' })).toBe(true);
    expect(selectItem).toHaveBeenCalledWith('term');
    // Dropped for the surface that was about to autofocus...
    expect(handles.active()).toBe(false);
    await flush();
    // ...and taken back, because nothing did.
    expect(handles.active()).toBe(true);
  });

  it('stays off when the surface really does take the focus', async () => {
    const { handles, composerField } = harness();
    escape();
    // `c` focuses the composer for real, which is the case `holdsMode: false`
    // was written for.
    press({ key: 'i', code: 'KeyI' });
    await flush();
    expect(handles.active()).toBe(false);
    expect(deepActiveElement(document)).toBe(composerField);
  });

  /**
   * Codex P2: with the focus already on nothing there is no `focusout` to fire,
   * so nothing else notices the window going away.
   */
  it('drops the mode when the window loses the keyboard, and takes it back', async () => {
    const { handles } = harness();
    await flush();
    expect(handles.active()).toBe(true);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    expect(handles.active()).toBe(false);
    expect(document.querySelector('[data-wc-shortcuts="badge"]')).toBeNull();
    // A suspension, not a decision: the intent the user left is untouched.
    expect(handles.intent()).toBe('keyboard');
    vi.mocked(document.hasFocus).mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(handles.active()).toBe(true);
  });

  it('does not take the Enter a focused button is waiting for', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    const { handles, focusComposer } = harness();
    await flush();
    expect(handles.active()).toBe(true);
    expect(press({ key: 'Enter', code: 'Enter' }, button)).toBe(false);
    expect(focusComposer).not.toHaveBeenCalled();
    // A letter is still the mode's, though — only activation keys are spared.
    expect(press({ key: 'b', code: 'KeyB' }, button)).toBe(true);
  });
});

describe('carrying the mode across a unit switch', () => {
  it('gives the caret back to the composer you switched away from', async () => {
    const { handles, composerField, focusComposer, switchTo } = harness();
    composerField.focus();
    await flush();
    expect(handles.intent()).toBe('composer');
    // What a tab click does: blur first, then move the selection.
    composerField.blur();
    await switchTo('cone_2');
    expect(focusComposer).toHaveBeenCalledTimes(1);
    expect(handles.active()).toBe(false);
  });

  it('stays in keyboard mode when that is where you started', async () => {
    const { handles, focusComposer, switchTo } = harness();
    escape();
    await switchTo('cone_2');
    expect(focusComposer).not.toHaveBeenCalled();
    expect(handles.active()).toBe(true);
  });

  it('ignores a selection re-asserted onto the same unit', async () => {
    const { focusComposer, switcher } = harness();
    await flush();
    switcher.setAttribute('active', 'cone_1');
    await flush();
    expect(focusComposer).not.toHaveBeenCalled();
  });

  /**
   * The hard half of #2312: a scoop's transcript is read-only and has no
   * composer at all, so the keyboard mode it forces is not a choice — and the
   * cone on the far side of the detour has to get its caret back.
   */
  it('holds the composer intent across a read-only scoop', async () => {
    let available = true;
    const { handles, composerField, focusComposer, switchTo } = harness({
      composerAvailable: () => available,
    });
    composerField.focus();
    await flush();
    expect(handles.intent()).toBe('composer');

    // Cone → scoop: the band is hidden, so the caret is dropped by the DOM.
    available = false;
    composerField.blur();
    await switchTo('scoop_a');
    expect(handles.active()).toBe(true);
    expect(handles.intent()).toBe('composer');
    expect(focusComposer).not.toHaveBeenCalled();

    // Scoop → cone: the band is back, and so is the caret.
    available = true;
    await switchTo('cone_2');
    expect(focusComposer).toHaveBeenCalledTimes(1);
  });

  it('a scoop detour cannot invent a composer intent either', async () => {
    let available = true;
    const { handles, focusComposer, switchTo } = harness({
      composerAvailable: () => available,
    });
    escape();
    expect(handles.intent()).toBe('keyboard');
    available = false;
    await switchTo('scoop_a');
    expect(handles.intent()).toBe('keyboard');
    available = true;
    await switchTo('cone_2');
    expect(focusComposer).not.toHaveBeenCalled();
    expect(handles.active()).toBe(true);
  });
});

describe('one installation per document', () => {
  /**
   * Codex P2: `mountWcShell` is idempotent, but these listeners are on the
   * DOCUMENT — a remount used to leave the first wiring installed, running
   * first, and driving the detached shell.
   */
  it('a second wiring replaces the first', () => {
    const first = harness();
    const second = harness();
    escape();
    press({ key: '2', code: 'Digit2' });
    expect(second.select).toHaveBeenCalledWith('cone_2');
    expect(first.select).not.toHaveBeenCalled();
  });

  it('disposing a superseded handle does not evict its successor', () => {
    const first = harness();
    const second = harness();
    first.handles.dispose();
    escape();
    press({ key: '2', code: 'Digit2' });
    expect(second.select).toHaveBeenCalledWith('cone_2');
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

describe('indexForDigit', () => {
  it('indexes from 1 and maps 9 onto the last item, whatever the list is', () => {
    expect(indexForDigit(4, 1)).toBe(0);
    expect(indexForDigit(4, 3)).toBe(2);
    expect(indexForDigit(4, 9)).toBe(3);
    // The rule holds for a list shorter than nine, which is the common case
    // everywhere except the tab strip.
    expect(indexForDigit(2, 9)).toBe(1);
  });

  it('is null past the end and on an empty list', () => {
    expect(indexForDigit(2, 3)).toBeNull();
    expect(indexForDigit(0, 1)).toBeNull();
    expect(indexForDigit(0, 9)).toBeNull();
  });
});

describe('prevInCycle', () => {
  it('mirrors nextInCycle, wrapping past the front', () => {
    expect(prevInCycle(['a', 'b', 'c'], 'a')).toBe('c');
    expect(prevInCycle(['a', 'b', 'c'], 'c')).toBe('b');
  });

  /** With nothing selected the two keys must still be inverses. */
  it('starts at the last entry when the current one is unknown', () => {
    expect(prevInCycle(['a', 'b'], null)).toBe('b');
    expect(prevInCycle(['a', 'b'], 'gone')).toBe('b');
  });

  it('is null only for an empty list', () => {
    expect(prevInCycle([], 'a')).toBeNull();
  });
});

describe('the turn keys', () => {
  it('s stops the running turn and stays in the mode', () => {
    const { stopTurn, handles } = harness();
    escape();
    press({ key: 's', code: 'KeyS' });
    expect(stopTurn).toHaveBeenCalledTimes(1);
    // Stopping is not going anywhere: the keyboard is still yours afterwards.
    expect(handles.active()).toBe(true);
  });

  it('a goes to the pending approval without answering it', () => {
    const { focusApproval, handles } = harness();
    escape();
    press({ key: 'a', code: 'KeyA' });
    expect(focusApproval).toHaveBeenCalledTimes(1);
    // A focused button keeps its own Enter, so the mode has to survive to let
    // the user press it.
    expect(handles.active()).toBe(true);
  });

  it('u opens the add menu and leaves the mode for its search field', () => {
    const { openAttachMenu, handles } = harness();
    escape();
    press({ key: 'u', code: 'KeyU' });
    expect(openAttachMenu).toHaveBeenCalledTimes(1);
    expect(handles.active()).toBe(false);
  });

  it('y copies the last reply and Y the whole chat', () => {
    const { copyReply, copyChat } = harness();
    escape();
    press({ key: 'y', code: 'KeyY' });
    press({ key: 'Y', code: 'KeyY', shiftKey: true });
    expect(copyReply).toHaveBeenCalledTimes(1);
    expect(copyChat).toHaveBeenCalledTimes(1);
  });

  it('z full-screens the open panel', () => {
    const { zoomSurface } = harness();
    escape();
    press({ key: 'z', code: 'KeyZ' });
    expect(zoomSurface).toHaveBeenCalledTimes(1);
  });
});

describe('the conversation keys', () => {
  it('N erases the chat where n saves it', () => {
    const { newChat, erase } = harness();
    escape();
    press({ key: 'N', code: 'KeyN', shiftKey: true });
    expect(erase).toHaveBeenCalledTimes(1);
    expect(newChat).not.toHaveBeenCalled();
  });

  it("c and C fire the rail row's own cone events", () => {
    const { newCone, dropCone } = harness();
    escape();
    press({ key: 'c', code: 'KeyC' });
    escape();
    press({ key: 'C', code: 'KeyC', shiftKey: true });
    expect(newCone).toHaveBeenCalledTimes(1);
    expect(dropCone).toHaveBeenCalledTimes(1);
  });

  it('r opens the rail rather than toggling it', () => {
    const { toggle, handles } = harness();
    escape();
    press({ key: 'r', code: 'KeyR' });
    press({ key: 'r', code: 'KeyR' });
    // Twice, and still open: the point of the key is to look at the list.
    expect(toggle).toHaveBeenNthCalledWith(1, true);
    expect(toggle).toHaveBeenNthCalledWith(2, true);
    expect(handles.active()).toBe(true);
  });
});

describe('chords', () => {
  it('sends the digit after a list command to that list, not the strip', () => {
    const h = harness({ files: ['/a.ts', '/b.ts', '/c.ts'] });
    escape();
    press({ key: 'f', code: 'KeyF' });
    expect(press({ key: '2', code: 'Digit2' })).toBe(true);
    expect(h.selectFile).toHaveBeenCalledWith('/b.ts');
    expect(h.select).not.toHaveBeenCalled();
  });

  it('maps 9 onto the last row, exactly as it does for agents', () => {
    const h = harness({ sessions: ['jan.json', 'feb.json', 'mar.json'] });
    escape();
    press({ key: 'r', code: 'KeyR' });
    press({ key: '9', code: 'Digit9' });
    expect(h.selectSession).toHaveBeenCalledWith('mar.json');
  });

  it('is one key wide — a digit two keys later is the strip again', () => {
    const h = harness({ files: ['/a.ts'] });
    escape();
    press({ key: 'f', code: 'KeyF' });
    press({ key: 'q', code: 'KeyQ' });
    press({ key: '1', code: 'Digit1' });
    expect(h.selectFile).not.toHaveBeenCalled();
    expect(h.select).toHaveBeenCalledWith('cone_1');
  });

  it('expires, handing the digit back to the strip', () => {
    vi.useFakeTimers();
    try {
      const h = harness({ files: ['/a.ts'] });
      escape();
      press({ key: 'f', code: 'KeyF' });
      vi.advanceTimersByTime(1200);
      press({ key: '1', code: 'Digit1' });
      expect(h.selectFile).not.toHaveBeenCalled();
      expect(h.select).toHaveBeenCalledWith('cone_1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a digit pressed on its own to the strip', () => {
    const h = harness({ files: ['/a.ts'] });
    escape();
    press({ key: '1', code: 'Digit1' });
    expect(h.selectFile).not.toHaveBeenCalled();
    expect(h.select).toHaveBeenCalledWith('cone_1');
  });

  /**
   * A panel that is still mounting has no rows yet. The press is shown dimmed
   * rather than queued, and — the part that matters — it does NOT fall through
   * to the tab strip, where it would switch agents behind the user's back.
   */
  it('does nothing at all when the list is empty', () => {
    const h = harness({ files: [] });
    escape();
    press({ key: 'f', code: 'KeyF' });
    expect(press({ key: '2', code: 'Digit2' })).toBe(false);
    expect(h.selectFile).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
  });

  it('indexes the sprinkle launchers off the dock rail itself', () => {
    const { selectItem } = harness({
      dockItems: [
        { id: 'files', kind: 'tool' },
        { id: 'sprinkle:one', kind: 'sprinkle' },
        { id: 'sprinkle:two', kind: 'sprinkle' },
        { id: 'new', kind: 'sprinkle' },
      ],
    });
    escape();
    press({ key: 'p', code: 'KeyP' });
    press({ key: '2', code: 'Digit2' });
    expect(selectItem).toHaveBeenLastCalledWith('sprinkle:two');
  });

  it('follows a rebound key, because the chord belongs to the command', () => {
    const h = harness({ files: ['/a.ts', '/b.ts'] });
    h.handles.setKeymap({ q: 'files' });
    escape();
    press({ key: 'q', code: 'KeyQ' });
    press({ key: '2', code: 'Digit2' });
    expect(h.selectFile).toHaveBeenCalledWith('/b.ts');
  });

  it('is dropped by Escape, so the mode key never leaves one armed', () => {
    const h = harness({ files: ['/a.ts'] });
    escape();
    press({ key: 'f', code: 'KeyF' });
    escape();
    press({ key: '1', code: 'Digit1' });
    expect(h.selectFile).not.toHaveBeenCalled();
    expect(h.select).toHaveBeenCalledWith('cone_1');
  });

  it('degrades to nothing on a float with no lists wired', () => {
    const { handles } = harness({ noDock: true });
    handles.setKeymap({ f: 'files' });
    escape();
    press({ key: 'f', code: 'KeyF' });
    expect(() => press({ key: '2', code: 'Digit2' })).not.toThrow();
  });
});
