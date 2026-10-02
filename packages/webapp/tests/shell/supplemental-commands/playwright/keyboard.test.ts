import { describe, expect, it } from 'vitest';
import {
  keyEventParams,
  pressKeyParams,
  resolveKeyDefinition,
} from '../../../../src/shell/supplemental-commands/playwright/keyboard.js';

describe('playwright keyboard CDP payloads', () => {
  it('Enter includes text \\r and keyCode 13 on keyDown only', () => {
    const [keyDown, keyUp] = pressKeyParams('Enter');
    expect(keyDown).toEqual({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r',
      unmodifiedText: '\r',
    });
    expect(keyUp).toEqual({
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    expect(keyUp).not.toHaveProperty('text');
  });

  it('accepts enter / Return aliases', () => {
    expect(resolveKeyDefinition('enter').keyCode).toBe(13);
    expect(resolveKeyDefinition('Return').text).toBe('\r');
  });

  it('Escape and arrows have key codes but no text', () => {
    expect(keyEventParams('Escape', 'keyDown')).toEqual({
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    expect(keyEventParams('ArrowLeft', 'keyDown').windowsVirtualKeyCode).toBe(37);
    expect(keyEventParams('ArrowLeft', 'keyDown')).not.toHaveProperty('text');
  });

  it('Space and Tab carry character text', () => {
    expect(keyEventParams('Space', 'keyDown').text).toBe(' ');
    expect(keyEventParams('Tab', 'keyDown').text).toBe('\t');
  });

  it('printable characters map code and text', () => {
    expect(resolveKeyDefinition('a')).toEqual({
      key: 'a',
      code: 'KeyA',
      keyCode: 65,
      text: 'a',
    });
    expect(resolveKeyDefinition('5')).toEqual({
      key: '5',
      code: 'Digit5',
      keyCode: 53,
      text: '5',
    });
  });
});
