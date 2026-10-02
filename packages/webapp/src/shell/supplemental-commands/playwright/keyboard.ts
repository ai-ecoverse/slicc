export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;

  text?: string;
}

export interface CdpKeyEventParams {
  type: 'keyDown' | 'keyUp';
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
  unmodifiedText?: string;

  [key: string]: unknown;
}

const NAMED_KEYS: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  '\r': { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  '\n': { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
};

for (let i = 1; i <= 12; i++) {
  NAMED_KEYS[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
}

const PRINTABLE: Record<string, KeyDefinition> = {
  ';': { key: ';', code: 'Semicolon', keyCode: 186, text: ';' },
  '=': { key: '=', code: 'Equal', keyCode: 187, text: '=' },
  ',': { key: ',', code: 'Comma', keyCode: 188, text: ',' },
  '-': { key: '-', code: 'Minus', keyCode: 189, text: '-' },
  '.': { key: '.', code: 'Period', keyCode: 190, text: '.' },
  '/': { key: '/', code: 'Slash', keyCode: 191, text: '/' },
  '`': { key: '`', code: 'Backquote', keyCode: 192, text: '`' },
  '[': { key: '[', code: 'BracketLeft', keyCode: 219, text: '[' },
  '\\': { key: '\\', code: 'Backslash', keyCode: 220, text: '\\' },
  ']': { key: ']', code: 'BracketRight', keyCode: 221, text: ']' },
  "'": { key: "'", code: 'Quote', keyCode: 222, text: "'" },
  ':': { key: ':', code: 'Semicolon', keyCode: 186, text: ':' },
  '+': { key: '+', code: 'Equal', keyCode: 187, text: '+' },
  '<': { key: '<', code: 'Comma', keyCode: 188, text: '<' },
  _: { key: '_', code: 'Minus', keyCode: 189, text: '_' },
  '>': { key: '>', code: 'Period', keyCode: 190, text: '>' },
  '?': { key: '?', code: 'Slash', keyCode: 191, text: '?' },
  '~': { key: '~', code: 'Backquote', keyCode: 192, text: '~' },
  '{': { key: '{', code: 'BracketLeft', keyCode: 219, text: '{' },
  '|': { key: '|', code: 'Backslash', keyCode: 220, text: '|' },
  '}': { key: '}', code: 'BracketRight', keyCode: 221, text: '}' },
  '"': { key: '"', code: 'Quote', keyCode: 222, text: '"' },
  ')': { key: ')', code: 'Digit0', keyCode: 48, text: ')' },
  '!': { key: '!', code: 'Digit1', keyCode: 49, text: '!' },
  '@': { key: '@', code: 'Digit2', keyCode: 50, text: '@' },
  '#': { key: '#', code: 'Digit3', keyCode: 51, text: '#' },
  $: { key: '$', code: 'Digit4', keyCode: 52, text: '$' },
  '%': { key: '%', code: 'Digit5', keyCode: 53, text: '%' },
  '^': { key: '^', code: 'Digit6', keyCode: 54, text: '^' },
  '&': { key: '&', code: 'Digit7', keyCode: 55, text: '&' },
  '*': { key: '*', code: 'Digit8', keyCode: 56, text: '*' },
  '(': { key: '(', code: 'Digit9', keyCode: 57, text: '(' },
};

export function resolveKeyDefinition(keyName: string): KeyDefinition {
  const named = NAMED_KEYS[keyName];
  if (named) return named;

  if (keyName.length > 1) {
    const folded = Object.keys(NAMED_KEYS).find((k) => k.toLowerCase() === keyName.toLowerCase());
    if (folded) return NAMED_KEYS[folded];
  }

  if (keyName.length === 1) {
    const printable = PRINTABLE[keyName];
    if (printable) return printable;

    const ch = keyName;
    const lower = ch.toLowerCase();
    if (lower >= 'a' && lower <= 'z') {
      return {
        key: ch,
        code: `Key${lower.toUpperCase()}`,
        keyCode: lower.toUpperCase().charCodeAt(0),
        text: ch,
      };
    }
    if (ch >= '0' && ch <= '9') {
      return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
    }

    return { key: ch, code: ch, keyCode: ch.charCodeAt(0), text: ch };
  }

  return { key: keyName, code: keyName, keyCode: 0 };
}

export function keyEventParams(keyName: string, type: 'keyDown' | 'keyUp'): CdpKeyEventParams {
  const def = resolveKeyDefinition(keyName);
  const base: CdpKeyEventParams = {
    type,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
  };

  if (type === 'keyDown' && def.text !== undefined) {
    base.text = def.text;
    base.unmodifiedText = def.text;
  }
  return base;
}

export function pressKeyParams(keyName: string): [CdpKeyEventParams, CdpKeyEventParams] {
  return [keyEventParams(keyName, 'keyDown'), keyEventParams(keyName, 'keyUp')];
}
