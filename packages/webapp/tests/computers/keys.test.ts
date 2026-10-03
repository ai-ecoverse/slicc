import { describe, expect, it } from 'vitest';
import {
  chordToScancodes,
  keysymFromKeyEvent,
  parseKeysym,
  toCdpKeyEvents,
  toTouchAction,
  toXdotoolKey,
  toYdotoolKey,
} from '../../src/computers/keys.js';

describe('computer keys', () => {
  it('parses xdotool chords and historical v86 names', () => {
    expect(parseKeysym('Return')?.key).toBe('Enter');
    expect(parseKeysym('enter')?.key).toBe('Enter');
    expect(parseKeysym('ctrl+alt+Delete')?.modifiers).toEqual({
      ctrl: true,
      alt: true,
      shift: false,
      meta: false,
    });
    expect(parseKeysym('super+space')?.modifiers.meta).toBe(true);
    expect(parseKeysym('F5')?.code).toBe('F5');
    expect(parseKeysym('KEYCODE_BACK')?.native).toBe('KEYCODE_BACK');
  });

  it('emits PS/2 scancodes for ctrl-c and ctrl-alt-del', () => {
    expect(chordToScancodes('ctrl-c')).toEqual([0x1d, 0x2e, 0xae, 0x9d]);
    expect(chordToScancodes('ctrl+alt+Delete')).not.toBeNull();
    expect(chordToScancodes('bogus-key')).toBeNull();
  });

  it('maps a keypress to CDP down/up events', () => {
    const parsed = parseKeysym('a');
    expect(parsed).not.toBeNull();
    const events = toCdpKeyEvents(parsed!);
    expect(events.map((e) => e.type)).toEqual(['keyDown', 'keyUp']);
    expect(events[0]).toEqual({
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 0,
      windowsVirtualKeyCode: 65,
      text: 'a',
      unmodifiedText: 'a',
    });
    expect(events[1]).toEqual({
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      modifiers: 0,
      windowsVirtualKeyCode: 65,
    });
    expect(events[0]).not.toHaveProperty('nativeVirtualKeyCode');
    expect(events[1]).not.toHaveProperty('nativeVirtualKeyCode');
  });

  it('Enter includes windowsVirtualKeyCode 13 and text \\r on keyDown only', () => {
    const parsed = parseKeysym('Return');
    expect(parsed).not.toBeNull();
    const [keyDown, keyUp] = toCdpKeyEvents(parsed!);
    expect(keyDown).toEqual({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      modifiers: 0,
      windowsVirtualKeyCode: 13,
      text: '\r',
      unmodifiedText: '\r',
    });
    expect(keyUp).toEqual({
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      modifiers: 0,
      windowsVirtualKeyCode: 13,
    });
    expect(keyUp).not.toHaveProperty('text');
    expect(toCdpKeyEvents(parseKeysym('enter')!)[0].windowsVirtualKeyCode).toBe(13);
    expect(toCdpKeyEvents(parseKeysym('enter')!)[0].text).toBe('\r');
  });

  it('maps shifted US symbols to the physical code and Windows VK', () => {
    const bang = parseKeysym('!');
    expect(bang).not.toBeNull();
    expect(bang).toMatchObject({ key: '!', code: 'Digit1' });
    const [bangDown] = toCdpKeyEvents(bang!);
    expect(bangDown).toMatchObject({
      key: '!',
      code: 'Digit1',
      windowsVirtualKeyCode: 49,
      text: '!',
    });
    expect(bangDown.code).not.toBe('');
    expect(bangDown.windowsVirtualKeyCode).not.toBe(33);

    const question = toCdpKeyEvents(parseKeysym('?')!);
    expect(question[0]).toMatchObject({
      key: '?',
      code: 'Slash',
      windowsVirtualKeyCode: 191,
      text: '?',
    });

    const fromLightbox = keysymFromKeyEvent({
      key: '!',
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      metaKey: false,
    });
    expect(fromLightbox).toBe('!');
    const [lightboxDown] = toCdpKeyEvents(parseKeysym(fromLightbox!)!);
    expect(lightboxDown.code).toBe('Digit1');
    expect(lightboxDown.windowsVirtualKeyCode).toBe(49);
  });

  it('preserves modifiers and omits insert text on chords', () => {
    const parsed = parseKeysym('ctrl+alt+Delete');
    expect(parsed).not.toBeNull();
    const [keyDown, keyUp] = toCdpKeyEvents(parsed!);
    expect(keyDown.modifiers).toBe(1 + 2);
    expect(keyDown.windowsVirtualKeyCode).toBe(46);
    expect(keyDown).not.toHaveProperty('text');
    expect(keyUp.modifiers).toBe(keyDown.modifiers);
    const ctrlC = toCdpKeyEvents(parseKeysym('ctrl+c')!);
    expect(ctrlC[0].windowsVirtualKeyCode).toBe(67);
    expect(ctrlC[0].modifiers).toBe(2);
    expect(ctrlC[0]).not.toHaveProperty('text');
  });

  it('maps click/hold/scroll onto touch actions', () => {
    expect(toTouchAction({ type: 'click', button: 1, count: 1, x: 1, y: 2 })).toEqual({
      kind: 'tap',
      x: 1,
      y: 2,
    });
    expect(toTouchAction({ type: 'click', button: 1, count: 1, x: 1, y: 2, holdMs: 400 })).toEqual({
      kind: 'long-press',
      x: 1,
      y: 2,
      holdMs: 400,
    });
    expect(toTouchAction({ type: 'mousemove', x: 0, y: 0 })).toEqual({ kind: 'noop' });
    expect(toTouchAction({ type: 'drag', x1: 1, y1: 2, x2: 8, y2: 9 })).toEqual({
      kind: 'swipe',
      x1: 1,
      y1: 2,
      x2: 8,
      y2: 9,
    });
  });

  it('emits xdotool and ydotool chords', () => {
    const parsed = parseKeysym('ctrl+alt+Delete');
    expect(parsed).not.toBeNull();
    expect(toXdotoolKey(parsed!)).toBe('ctrl+alt+Delete');
    expect(toYdotoolKey(parsed!)).toContain('29:1');
    expect(toYdotoolKey(parsed!)).toContain('111:');
    expect(toXdotoolKey(parseKeysym('Return')!)).toBe('Return');
  });

  it('rebuilds xdotool chords from browser key events and skips Escape', () => {
    const none = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    expect(keysymFromKeyEvent({ ...none, key: 'a' })).toBe('a');
    expect(keysymFromKeyEvent({ ...none, key: 'Enter' })).toBe('Return');
    expect(keysymFromKeyEvent({ ...none, key: ' ' })).toBe('space');
    expect(keysymFromKeyEvent({ ...none, key: 'ArrowUp' })).toBe('Up');
    expect(keysymFromKeyEvent({ ...none, key: 'F5' })).toBe('F5');
    expect(keysymFromKeyEvent({ ...none, ctrlKey: true, key: 'c' })).toBe('ctrl+c');
    expect(keysymFromKeyEvent({ ...none, shiftKey: true, key: 'Tab' })).toBe('shift+Tab');
    expect(keysymFromKeyEvent({ ...none, shiftKey: true, key: 'A' })).toBe('A');
    expect(keysymFromKeyEvent({ ...none, key: 'Escape' })).toBeNull();
    expect(keysymFromKeyEvent({ ...none, key: 'Shift' })).toBeNull();
    expect(keysymFromKeyEvent({ ...none, key: 'Dead' })).toBeNull();
  });
});
