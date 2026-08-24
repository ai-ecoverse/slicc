// @vitest-environment jsdom
/**
 * WC shell keyboard shortcuts: the help overlay (`?` / `/`), unit switching
 * (Ctrl+digit on macOS, Ctrl+Shift+digit elsewhere), and the typing guard
 * that keeps bare letters out of the composer's way.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectMac,
  digitFor,
  hasSwitchModifier,
  isTypingTarget,
  shortcutRows,
  unitKeyForDigit,
  wireKeyboardShortcuts,
} from '../../../src/ui/wc/wc-shortcuts.js';

/** Every wiring made by a test, torn down after it — a leaked document
 *  listener from one test claims (and `preventDefault`s) the next one's keys. */
const wired: Array<{ dispose(): void }> = [];

function harness(options: { isMac?: boolean; tabs?: string[]; noComposer?: boolean } = {}) {
  const keys = options.tabs ?? ['cone_1', 'cone_2', 'scoop_a'];
  const select = vi.fn();
  const focusComposer = vi.fn();
  const switcher = {
    scoops: keys.map((key) => ({ key, label: key })),
    select,
  };
  const handles = wireKeyboardShortcuts({
    switcher,
    ...(options.noComposer ? {} : { focusComposer }),
    doc: document,
    isMac: options.isMac ?? true,
  });
  wired.push(handles);
  return { handles, select, focusComposer };
}

/** Dispatch a keydown on `target` (bubbling, so the document listener sees it). */
function press(init: KeyboardEventInit, target: EventTarget = document.body): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

afterEach(() => {
  while (wired.length > 0) wired.pop()?.dispose();
  document.body.innerHTML = '';
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

describe('hasSwitchModifier', () => {
  const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('takes bare Ctrl on macOS', () => {
    expect(hasSwitchModifier(ev({ ctrlKey: true }), true)).toBe(true);
  });

  it('demands Shift off macOS, where Ctrl+digit is the browser tab switcher', () => {
    expect(hasSwitchModifier(ev({ ctrlKey: true }), false)).toBe(false);
    expect(hasSwitchModifier(ev({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
  });

  it('never claims a chord the OS or browser owns', () => {
    expect(hasSwitchModifier(ev({ metaKey: true }), true)).toBe(false);
    expect(hasSwitchModifier(ev({ ctrlKey: true, metaKey: true }), true)).toBe(false);
    expect(hasSwitchModifier(ev({ ctrlKey: true, altKey: true }), true)).toBe(false);
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
    expect(unitKeyForDigit([], 1)).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('sees a textarea inside a shadow root through composedPath', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const textarea = document.createElement('textarea');
    root.append(textarea);
    document.body.append(host);
    let seen: boolean | null = null;
    document.addEventListener('keydown', (e) => {
      seen = isTypingTarget(e);
    });
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true }));
    expect(seen).toBe(true);
  });

  it('is false for a plain element', () => {
    const div = document.createElement('div');
    document.body.append(div);
    const event = new KeyboardEvent('keydown', { bubbles: true });
    div.dispatchEvent(event);
    expect(isTypingTarget(event)).toBe(false);
  });

  it('counts a contenteditable', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', '');
    const span = document.createElement('span');
    div.append(span);
    document.body.append(div);
    const event = new KeyboardEvent('keydown', { bubbles: true });
    span.dispatchEvent(event);
    expect(isTypingTarget(event)).toBe(true);
  });
});

describe('detectMac', () => {
  it('prefers userAgentData over the deprecated platform', () => {
    expect(detectMac({ userAgentData: { platform: 'macOS' }, platform: 'Win32' } as never)).toBe(
      true
    );
    expect(detectMac({ platform: 'MacIntel' } as never)).toBe(true);
    expect(detectMac({ platform: 'Win32', userAgent: 'Windows NT' } as never)).toBe(false);
    expect(detectMac(undefined)).toBe(false);
  });
});

describe('shortcutRows', () => {
  it('spells the modifier per platform', () => {
    expect(shortcutRows(true)[0].keys).toEqual(['Ctrl', '1']);
    expect(shortcutRows(false)[0].keys).toEqual(['Ctrl', 'Shift', '1']);
  });
});

describe('wireKeyboardShortcuts', () => {
  it('switches units through the strip, not around it', () => {
    const { select } = harness();
    expect(press({ code: 'Digit2', key: '2', ctrlKey: true })).toBe(true);
    expect(select).toHaveBeenCalledWith('cone_2');
  });

  it('ignores the browser-owned Cmd+digit on macOS', () => {
    const { select } = harness();
    expect(press({ code: 'Digit2', key: '2', metaKey: true })).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it('needs Shift off macOS', () => {
    const { select } = harness({ isMac: false });
    press({ code: 'Digit2', key: '2', ctrlKey: true });
    expect(select).not.toHaveBeenCalled();
    press({ code: 'Digit2', key: '@', ctrlKey: true, shiftKey: true });
    expect(select).toHaveBeenCalledWith('cone_2');
  });

  it('switches even while the composer has focus — the chord types nothing', () => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    const { select } = harness();
    press({ code: 'Digit3', key: '3', ctrlKey: true }, textarea);
    expect(select).toHaveBeenCalledWith('scoop_a');
  });

  it('does nothing when the digit is past the end of the strip', () => {
    const { select } = harness({ tabs: ['only'] });
    expect(press({ code: 'Digit4', key: '4', ctrlKey: true })).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it('opens, toggles, and closes the help overlay', () => {
    const { handles } = harness();
    press({ key: '?', shiftKey: true });
    const overlay = handles.helpOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute('heading')).toBe('Keyboard shortcuts');
    expect(document.body.contains(overlay)).toBe(true);
    // Every documented binding is listed.
    expect(overlay?.querySelectorAll('.wcsc__row')).toHaveLength(shortcutRows(true).length);
    press({ key: '?', shiftKey: true });
    expect(handles.helpOverlay()).toBeNull();
    expect(document.body.querySelector('slicc-dialog')).toBeNull();
  });

  it('opens on / as well', () => {
    const { handles } = harness();
    press({ key: '/' });
    expect(handles.helpOverlay()).not.toBeNull();
  });

  it('forgets an overlay that dismissed itself', () => {
    const { handles } = harness();
    handles.showHelp();
    const overlay = handles.helpOverlay();
    overlay?.dispatchEvent(new CustomEvent('slicc-dialog-close', { detail: { reason: 'escape' } }));
    expect(handles.helpOverlay()).toBeNull();
    press({ key: '?', shiftKey: true });
    expect(handles.helpOverlay()).not.toBeNull();
  });

  it('leaves bare letters alone while typing', () => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    const { handles, focusComposer } = harness();
    press({ key: '?', shiftKey: true }, textarea);
    expect(handles.helpOverlay()).toBeNull();
    press({ key: 'c' }, textarea);
    expect(focusComposer).not.toHaveBeenCalled();
  });

  it('respects a handler that already claimed the key', () => {
    const { handles } = harness();
    const event = new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true });
    event.preventDefault();
    document.body.dispatchEvent(event);
    expect(handles.helpOverlay()).toBeNull();
  });

  it('focuses the composer on c', () => {
    const { focusComposer } = harness();
    expect(press({ key: 'c' })).toBe(true);
    expect(focusComposer).toHaveBeenCalled();
  });

  it('leaves c alone on a float with no composer', () => {
    harness({ noComposer: true });
    expect(press({ key: 'c' })).toBe(false);
  });

  it('dispose removes the listener and any open overlay', () => {
    const { handles, select } = harness();
    handles.showHelp();
    handles.dispose();
    expect(document.body.querySelector('slicc-dialog')).toBeNull();
    press({ code: 'Digit1', key: '1', ctrlKey: true });
    expect(select).not.toHaveBeenCalled();
  });
});
