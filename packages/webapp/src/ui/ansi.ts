/**
 * ANSI escape-sequence renderer for bash tool output.
 *
 * Converts a string containing ANSI CSI/SGR sequences (colors, bold,
 * underline, etc.) into a sanitized HTML fragment. Text content is
 * HTML-escaped; styles are emitted as inline `style=` on `<span>` wrappers.
 * Non-SGR CSI sequences (cursor movement, erase) and OSC sequences are
 * stripped silently.
 */

import { escapeHtml } from './message-renderer.js';

interface SgrState {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

const BASIC = [
  '#000000',
  '#cd3131',
  '#0dbc79',
  '#e5e510',
  '#2472c8',
  '#bc3fbc',
  '#11a8cd',
  '#e5e5e5',
];
const BRIGHT = [
  '#666666',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#ffffff',
];

const initial = (): SgrState => ({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
});

const clamp = (n: number): number => Math.max(0, Math.min(255, Math.floor(n) || 0));

function xterm256(n: number): string {
  if (n < 0 || n > 255) return '';
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const k = n - 16;
    const map = [0, 95, 135, 175, 215, 255];
    return `rgb(${map[Math.floor(k / 36)]},${map[Math.floor((k % 36) / 6)]},${map[k % 6]})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

/** Resolve an extended-color token starting at `params[i]` (38 or 48). */
function extendedColor(params: number[], i: number): { color: string | null; consumed: number } {
  const mode = params[i + 1];
  if (mode === 5) {
    const n = params[i + 2];
    return { color: typeof n === 'number' ? xterm256(n) : null, consumed: 3 };
  }
  if (mode === 2) {
    const r = clamp(params[i + 2] ?? 0);
    const g = clamp(params[i + 3] ?? 0);
    const b = clamp(params[i + 4] ?? 0);
    return { color: `rgb(${r},${g},${b})`, consumed: 5 };
  }
  // Unknown extended-color mode: skip the 38/48 and the mode byte together
  // so the mode parameter is not re-interpreted as a standalone SGR code.
  return { color: null, consumed: 2 };
}

function applyParams(prev: SgrState, params: number[]): SgrState {
  const s = { ...prev };
  const arr = params.length === 0 ? [0] : params;
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    if (p === 0) Object.assign(s, initial());
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 9) s.strike = true;
    else if (p === 22) {
      s.bold = false;
      s.dim = false;
    } else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.inverse = false;
    else if (p === 29) s.strike = false;
    else if (p >= 30 && p <= 37) s.fg = BASIC[p - 30];
    else if (p === 38) {
      const r = extendedColor(arr, i);
      if (r.color) s.fg = r.color;
      i += r.consumed - 1;
    } else if (p === 39) s.fg = null;
    else if (p >= 40 && p <= 47) s.bg = BASIC[p - 40];
    else if (p === 48) {
      const r = extendedColor(arr, i);
      if (r.color) s.bg = r.color;
      i += r.consumed - 1;
    } else if (p === 49) s.bg = null;
    else if (p >= 90 && p <= 97) s.fg = BRIGHT[p - 90];
    else if (p >= 100 && p <= 107) s.bg = BRIGHT[p - 100];
  }
  return s;
}

function styleFor(state: SgrState): string {
  let fg = state.fg;
  let bg = state.bg;
  if (state.inverse) {
    const swap = fg;
    fg = bg ?? '#e6e6e6';
    bg = swap ?? '#0d0d0f';
  }
  const parts: string[] = [];
  if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background-color:${bg}`);
  if (state.bold) parts.push('font-weight:600');
  if (state.dim) parts.push('opacity:.7');
  if (state.italic) parts.push('font-style:italic');
  const deco: string[] = [];
  if (state.underline) deco.push('underline');
  if (state.strike) deco.push('line-through');
  if (deco.length) parts.push(`text-decoration:${deco.join(' ')}`);
  return parts.join(';');
}

const hasStyle = (s: SgrState): boolean =>
  !!(s.fg || s.bg || s.bold || s.dim || s.italic || s.underline || s.strike || s.inverse);

const wrap = (chunk: string, state: SgrState): string => {
  const safe = escapeHtml(chunk);
  return hasStyle(state) ? `<span style="${styleFor(state)}">${safe}</span>` : safe;
};

// CSI final byte per ECMA-48 is any 0x40-0x7E (`@` through `~`), which
// covers letters plus `~` (bracketed paste, function keys), `@`, `` ` ``, etc.
const ESC_PATTERN = /\x1b\[[?!#>]?[\d;]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const SGR_PATTERN = /^\x1b\[([\d;]*)m$/;

/**
 * Convert an ANSI-escaped string into a sanitized HTML fragment. The
 * returned string is safe to assign to `innerHTML`: every text segment
 * is HTML-escaped; only `<span>` wrappers with inline styles are added.
 */
export function ansiToHtml(text: string): string {
  if (!text) return '';
  let out = '';
  let last = 0;
  let state = initial();
  ESC_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ESC_PATTERN.exec(text)) !== null) {
    const chunk = text.slice(last, m.index);
    if (chunk) out += wrap(chunk, state);
    const sgr = SGR_PATTERN.exec(m[0]);
    if (sgr) {
      const params = sgr[1] === '' ? [] : sgr[1].split(';').map((n) => Number(n) || 0);
      state = applyParams(state, params);
    }
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  if (tail) out += wrap(tail, state);
  return out;
}
