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
