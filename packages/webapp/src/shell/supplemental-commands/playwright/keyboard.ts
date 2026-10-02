/**
 * CDP key payloads for playwright-cli press / keydown / keyup / --submit.
 *
 * Chrome ignores bare `{ key: 'Enter' }` for form submit: without
 * `text: '\r'` there is no keypress/char, and without
 * `windowsVirtualKeyCode: 13` the DOM `keyCode` is 0. Matches the
 * Playwright / Puppeteer US keyboard layout fields that matter for CDP.
 */

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  /** Present for keys that emit a character / form-submit text. */
  text?: string;
}

/** Params for one `Input.dispatchKeyEvent` call. */
export interface CdpKeyEventParams {
  type: 'keyDown' | 'keyUp';
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  text?: string;
  unmodifiedText?: string;
  /** Satisfies CDP transport `CdpPayload` / `CDPPayload` index signatures. */
  [key: string]: unknown;
}

/**
 * Named keys commonly passed to `press` / `keydown` / `keyup`.
 * Printable single characters are resolved separately.
 */
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

/** Resolve a playwright-cli key name to a layout definition. */
export function resolveKeyDefinition(keyName: string): KeyDefinition {
  const named = NAMED_KEYS[keyName];
  if (named) return named;

  // Case-insensitive match for common names (enter, escape, …).
  if (keyName.length > 1) {
    const folded = Object.keys(NAMED_KEYS).find((k) => k.toLowerCase() === keyName.toLowerCase());
    if (folded) return NAMED_KEYS[folded];
  }

  if (keyName.length === 1) {
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
    // Punctuation / other printable: emit text; code unknown → reuse key.
    return { key: ch, code: ch, keyCode: ch.charCodeAt(0), text: ch };
  }

  // Unknown named key: pass through so callers still dispatch something.
  return { key: keyName, code: keyName, keyCode: 0 };
}

/** Build keyDown (and optionally keyUp) CDP params for a key name. */
export function keyEventParams(keyName: string, type: 'keyDown' | 'keyUp'): CdpKeyEventParams {
  const def = resolveKeyDefinition(keyName);
  const base: CdpKeyEventParams = {
    type,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
  };
  // text/unmodifiedText only on keyDown — that is what produces keypress/char
  // and triggers Chrome's implicit form submit for Enter.
  if (type === 'keyDown' && def.text !== undefined) {
    base.text = def.text;
    base.unmodifiedText = def.text;
  }
  return base;
}

/** keyDown + keyUp pair (press / --submit). */
export function pressKeyParams(keyName: string): [CdpKeyEventParams, CdpKeyEventParams] {
  return [keyEventParams(keyName, 'keyDown'), keyEventParams(keyName, 'keyUp')];
}
