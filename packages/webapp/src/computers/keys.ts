/**
 * xdotool keysym parser and per-adapter emitters.
 *
 * Parse `ctrl+alt+Delete`, `F5`, `Return`, `super+space`, plus the historical
 * v86 chord names (`ctrl-alt-del`, `enter`, `esc`) into `{ key, code, modifiers }`.
 * `UPPERCASE_NATIVE` tokens (`KEYCODE_BACK`) pass through for Android / cliclick.
 */

import type { ComputerInputEvent } from '@slicc/shared-ts';

export interface KeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface ParsedKey {
  /** KeyboardEvent.key (CDP `key`). */
  key: string;
  /** KeyboardEvent.code (CDP `code`). */
  code: string;
  modifiers: KeyModifiers;
  /** Last token of the chord, xdotool spelling. */
  keysym: string;
  /** Set when the token is an UPPERCASE_NATIVE passthrough. */
  native?: string;
}

const EMPTY_MODS: KeyModifiers = { ctrl: false, alt: false, shift: false, meta: false };

const MOD_ALIASES: Record<string, keyof KeyModifiers> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  meta: 'meta',
  super: 'meta',
  win: 'meta',
  cmd: 'meta',
  command: 'meta',
};

interface KeyDef {
  key: string;
  code: string;
}

/** Named keys (xdotool + historical v86 aliases), keyed lowercase. */
const NAMED: Record<string, KeyDef> = {
  return: { key: 'Enter', code: 'Enter' },
  enter: { key: 'Enter', code: 'Enter' },
  kp_enter: { key: 'Enter', code: 'NumpadEnter' },
  tab: { key: 'Tab', code: 'Tab' },
  escape: { key: 'Escape', code: 'Escape' },
  esc: { key: 'Escape', code: 'Escape' },
  space: { key: ' ', code: 'Space' },
  backspace: { key: 'Backspace', code: 'Backspace' },
  delete: { key: 'Delete', code: 'Delete' },
  del: { key: 'Delete', code: 'Delete' },
  insert: { key: 'Insert', code: 'Insert' },
  home: { key: 'Home', code: 'Home' },
  end: { key: 'End', code: 'End' },
  pageup: { key: 'PageUp', code: 'PageUp' },
  page_up: { key: 'PageUp', code: 'PageUp' },
  prior: { key: 'PageUp', code: 'PageUp' },
  pagedown: { key: 'PageDown', code: 'PageDown' },
  page_down: { key: 'PageDown', code: 'PageDown' },
  next: { key: 'PageDown', code: 'PageDown' },
  up: { key: 'ArrowUp', code: 'ArrowUp' },
  down: { key: 'ArrowDown', code: 'ArrowDown' },
  left: { key: 'ArrowLeft', code: 'ArrowLeft' },
  right: { key: 'ArrowRight', code: 'ArrowRight' },
  menu: { key: 'ContextMenu', code: 'ContextMenu' },
  caps_lock: { key: 'CapsLock', code: 'CapsLock' },
  num_lock: { key: 'NumLock', code: 'NumLock' },
  scroll_lock: { key: 'ScrollLock', code: 'ScrollLock' },
  print: { key: 'PrintScreen', code: 'PrintScreen' },
  pause: { key: 'Pause', code: 'Pause' },
};

for (let i = 1; i <= 12; i++) {
  NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}` };
}

const PS2_NAMED: Record<string, number[]> = {
  enter: [0x1c],
  tab: [0x0f],
  esc: [0x01],
  escape: [0x01],
  space: [0x39],
  backspace: [0x0e],
  delete: [0xe0, 0x53],
  del: [0xe0, 0x53],
  up: [0xe0, 0x48],
  down: [0xe0, 0x50],
  left: [0xe0, 0x4b],
  right: [0xe0, 0x4d],
  home: [0xe0, 0x47],
  end: [0xe0, 0x4f],
  pageup: [0xe0, 0x49],
  pagedown: [0xe0, 0x51],
  insert: [0xe0, 0x52],
  f1: [0x3b],
  f2: [0x3c],
  f3: [0x3d],
  f4: [0x3e],
  f5: [0x3f],
  f6: [0x40],
  f7: [0x41],
  f8: [0x42],
  f9: [0x43],
  f10: [0x44],
  f11: [0x57],
  f12: [0x58],
};

const PS2_MOD: Record<string, number[]> = {
  ctrl: [0x1d],
  alt: [0x38],
  shift: [0x2a],
  meta: [0xe0, 0x5b],
};

const ANDROID_KEYS: Record<string, string> = {
  return: 'KEYCODE_ENTER',
  enter: 'KEYCODE_ENTER',
  tab: 'KEYCODE_TAB',
  escape: 'KEYCODE_ESCAPE',
  esc: 'KEYCODE_ESCAPE',
  space: 'KEYCODE_SPACE',
  backspace: 'KEYCODE_DEL',
  delete: 'KEYCODE_FORWARD_DEL',
  del: 'KEYCODE_FORWARD_DEL',
  home: 'KEYCODE_HOME',
  end: 'KEYCODE_MOVE_END',
  insert: 'KEYCODE_INSERT',
  pageup: 'KEYCODE_PAGE_UP',
  pagedown: 'KEYCODE_PAGE_DOWN',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  menu: 'KEYCODE_MENU',
};

for (let i = 1; i <= 12; i++) ANDROID_KEYS[`f${i}`] = `KEYCODE_F${i}`;

const CLICK_NAMED: Record<string, string> = {
  return: 'return',
  enter: 'return',
  tab: 'tab',
  escape: 'esc',
  esc: 'esc',
  space: 'space',
  backspace: 'delete',
  delete: 'fwd-delete',
  del: 'fwd-delete',
  home: 'home',
  end: 'end',
  pageup: 'page-up',
  pagedown: 'page-down',
  up: 'arrow-up',
  down: 'arrow-down',
  left: 'arrow-left',
  right: 'arrow-right',
};

function isNativeToken(token: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/u.test(token);
}

function splitChord(raw: string): string[] {
  return raw.split(/[-+]/u).filter(Boolean);
}

function namedDef(token: string): KeyDef | null {
  const lower = token.toLowerCase();
  if (NAMED[lower]) return NAMED[lower];
  if (token.length === 1) {
    const ch = token;
    if (/[A-Za-z]/u.test(ch)) {
      const upper = ch.toUpperCase();
      return { key: ch, code: `Key${upper}` };
    }
    if (/[0-9]/u.test(ch)) return { key: ch, code: `Digit${ch}` };
    const punct: Record<string, KeyDef> = {
      '.': { key: '.', code: 'Period' },
      ',': { key: ',', code: 'Comma' },
      '/': { key: '/', code: 'Slash' },
      ';': { key: ';', code: 'Semicolon' },
      "'": { key: "'", code: 'Quote' },
      '[': { key: '[', code: 'BracketLeft' },
      ']': { key: ']', code: 'BracketRight' },
      '\\': { key: '\\', code: 'Backslash' },
      '`': { key: '`', code: 'Backquote' },
      '-': { key: '-', code: 'Minus' },
      '=': { key: '=', code: 'Equal' },
    };
    return punct[ch] ?? { key: ch, code: '' };
  }
  return null;
}

/**
 * Parse one xdotool keysym / historical v86 chord into a structured key.
 * Returns `null` when nothing usable remains.
 */
export function parseKeysym(chord: string): ParsedKey | null {
  const trimmed = chord.trim();
  if (!trimmed) return null;
  if (isNativeToken(trimmed)) {
    return {
      key: trimmed,
      code: trimmed,
      modifiers: { ...EMPTY_MODS },
      keysym: trimmed,
      native: trimmed,
    };
  }
  const parts = splitChord(trimmed);
  if (parts.length === 0) return null;
  const modifiers: KeyModifiers = { ...EMPTY_MODS };
  let final: string | null = null;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    const mod = MOD_ALIASES[part.toLowerCase()];
    if (mod && !isLast) {
      modifiers[mod] = true;
      continue;
    }
    if (mod && isLast && parts.length > 1) {
      // `ctrl` as a key of its own after modifiers isn't a thing; treat as key.
    }
    final = part;
  }
  if (!final) return null;
  if (isNativeToken(final)) {
    return { key: final, code: final, modifiers, keysym: final, native: final };
  }
  const def = namedDef(final);
  if (!def) return null;
  const shiftLetter = final.length === 1 && /[A-Z]/u.test(final);
  if (shiftLetter) modifiers.shift = true;
  return { key: def.key, code: def.code, modifiers, keysym: final };
}

function ps2CharMake(ch: string): number[] | null {
  const row = '1234567890'.indexOf(ch);
  if (row !== -1) return [row === 9 ? 0x0b : 0x02 + row];
  const letters = 'qwertyuiopasdfghjklzxcvbnm';
  const scan = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23,
    0x24, 0x25, 0x26, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32,
  ];
  const idx = letters.indexOf(ch.toLowerCase());
  return idx === -1 ? null : [scan[idx]];
}

function ps2Release(make: number[]): number[] {
  return make.length === 2 ? [make[0], make[1] | 0x80] : [make[0] | 0x80];
}

/**
 * Translate a chord like `ctrl-alt-del`, `alt-tab`, `ctrl-c`, or `enter`
 * into press+release PS/2 set-1 scancodes. Historical v86 helper — kept
 * as a named export so existing tests and the v86 command stay valid.
 */
export function chordToScancodes(chord: string): number[] | null {
  const parts = chord.toLowerCase().split(/[-+]/u).filter(Boolean);
  if (parts.length === 0) return null;
  const modifiers: number[][] = [];
  const finals: number[][] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    if (!isLast && PS2_MOD[part]) {
      modifiers.push(PS2_MOD[part]);
      continue;
    }
    const named = PS2_NAMED[part];
    const code = named ?? PS2_MOD[part] ?? (part.length === 1 ? ps2CharMake(part) : null);
    if (!code) return null;
    finals.push(code);
  }
  if (finals.length === 0) return null;
  const codes: number[] = [];
  for (const m of modifiers) codes.push(...m);
  for (const f of finals) codes.push(...f, ...ps2Release(f));
  for (const m of [...modifiers].reverse()) codes.push(...ps2Release(m));
  return codes;
}

/** CDP `Input.dispatchKeyEvent` modifiers bitfield: Alt=1 Ctrl=2 Meta=4 Shift=8. */
export function cdpModifiers(mods: KeyModifiers): number {
  return (mods.alt ? 1 : 0) + (mods.ctrl ? 2 : 0) + (mods.meta ? 4 : 0) + (mods.shift ? 8 : 0);
}

export interface CdpKeyEvent {
  type: 'keyDown' | 'keyUp';
  key: string;
  code: string;
  modifiers: number;
  text?: string;
}

export function toCdpKeyEvents(parsed: ParsedKey, down?: boolean): CdpKeyEvent[] {
  const modifiers = cdpModifiers(parsed.modifiers);
  const printable =
    parsed.key.length === 1 &&
    !parsed.modifiers.ctrl &&
    !parsed.modifiers.alt &&
    !parsed.modifiers.meta
      ? parsed.key
      : undefined;
  const make = (type: 'keyDown' | 'keyUp'): CdpKeyEvent => ({
    type,
    key: parsed.key,
    code: parsed.code,
    modifiers,
    ...(type === 'keyDown' && printable ? { text: printable } : {}),
  });
  if (down === true) return [make('keyDown')];
  if (down === false) return [make('keyUp')];
  return [make('keyDown'), make('keyUp')];
}

export function toAndroidKeycode(parsed: ParsedKey): string {
  if (parsed.native) return parsed.native;
  const named = ANDROID_KEYS[parsed.keysym.toLowerCase()];
  if (named) return named;
  if (parsed.key.length === 1 && /[A-Za-z0-9]/u.test(parsed.key)) {
    return `KEYCODE_${parsed.key.toUpperCase()}`;
  }
  return `KEYCODE_${parsed.keysym.toUpperCase()}`;
}

/** cliclick tokens: `kp:return`, with `kd:`/`ku:` for down/up. */
export function toCliclickToken(
  parsed: ParsedKey,
  phase: 'press' | 'down' | 'up' = 'press'
): string {
  const prefix = phase === 'down' ? 'kd' : phase === 'up' ? 'ku' : 'kp';
  if (parsed.native) return `${prefix}:${parsed.native}`;
  const named = CLICK_NAMED[parsed.keysym.toLowerCase()];
  const token = named ?? (parsed.key.length === 1 ? parsed.key : parsed.keysym.toLowerCase());
  const mods: string[] = [];
  if (parsed.modifiers.ctrl) mods.push('ctrl');
  if (parsed.modifiers.alt) mods.push('alt');
  if (parsed.modifiers.shift) mods.push('shift');
  if (parsed.modifiers.meta) mods.push('cmd');
  const body = mods.length > 0 ? `${mods.join(',')},${token}` : token;
  return `${prefix}:${body}`;
}

export type TouchAction =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'long-press'; x: number; y: number; holdMs: number }
  | { kind: 'swipe'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'noop' };

/**
 * Touch mapping: click → tap, `--hold` → long press, drag/scroll → swipe,
 * mousemove is a no-op.
 */
export function toTouchAction(event: ComputerInputEvent): TouchAction {
  if (
    event.type === 'mousemove' ||
    event.type === 'wait' ||
    event.type === 'key' ||
    event.type === 'text'
  ) {
    return { kind: 'noop' };
  }
  if (event.type === 'click') {
    const x = event.x ?? 0;
    const y = event.y ?? 0;
    if (event.holdMs && event.holdMs > 0) return { kind: 'long-press', x, y, holdMs: event.holdMs };
    return { kind: 'tap', x, y };
  }
  if (event.type === 'drag') {
    return { kind: 'swipe', x1: event.x1, y1: event.y1, x2: event.x2, y2: event.y2 };
  }
  if (event.type === 'button') {
    const x = event.x ?? 0;
    const y = event.y ?? 0;
    return event.down ? { kind: 'tap', x, y } : { kind: 'noop' };
  }
  const x = event.x ?? 0;
  const y = event.y ?? 0;
  return { kind: 'swipe', x1: x, y1: y, x2: x + event.dx, y2: y + event.dy };
}

export function formatModifiers(mods: KeyModifiers): string {
  const parts: string[] = [];
  if (mods.ctrl) parts.push('ctrl');
  if (mods.alt) parts.push('alt');
  if (mods.shift) parts.push('shift');
  if (mods.meta) parts.push('super');
  return parts.join('+');
}
