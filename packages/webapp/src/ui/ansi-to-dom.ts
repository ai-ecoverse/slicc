const ESC = '\x1b';

const STD = [
  '#0c0c0e',
  '#f43f5e',
  '#5bd17b',
  '#f59e0b',
  '#3b82f6',
  '#8b5cf6',
  '#06b6d4',
  '#e7e7ea',
];
const BRIGHT = [
  '#8a8a93',
  '#fb7185',
  '#86efac',
  '#fbbf24',
  '#60a5fa',
  '#a78bfa',
  '#22d3ee',
  '#ffffff',
];
const CUBE = [0, 95, 135, 175, 215, 255];

interface Style {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  fg: string | null;
  bg: string | null;
}

function freshStyle(): Style {
  return { bold: false, dim: false, italic: false, underline: false, fg: null, bg: null };
}

function isDefault(s: Style): boolean {
  return !s.bold && !s.dim && !s.italic && !s.underline && s.fg === null && s.bg === null;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function color256(n: number): string | null {
  if (n < 0) return null;
  if (n < 16) return [...STD, ...BRIGHT][n] ?? null;
  if (n < 232) {
    const c = n - 16;
    return `rgb(${CUBE[Math.floor(c / 36)]}, ${CUBE[Math.floor((c % 36) / 6)]}, ${CUBE[c % 6]})`;
  }
  if (n <= 255) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v}, ${v}, ${v})`;
  }
  return null;
}

function readExtended(codes: number[], k: number): { color: string; next: number } | null {
  const mode = codes[k + 1];
  if (mode === 5) {
    const color = color256(codes[k + 2] ?? Number.NaN);
    return color ? { color, next: k + 2 } : null;
  }
  if (mode === 2) {
    const [r, g, b] = [codes[k + 2], codes[k + 3], codes[k + 4]];
    if ([r, g, b].some((v) => typeof v !== 'number' || Number.isNaN(v))) return null;
    return { color: `rgb(${clamp(r!)}, ${clamp(g!)}, ${clamp(b!)})`, next: k + 4 };
  }
  return null;
}

const ATTR: Record<number, (s: Style) => void> = {
  0: (s) => Object.assign(s, freshStyle()),
  1: (s) => {
    s.bold = true;
  },
  2: (s) => {
    s.dim = true;
  },
  3: (s) => {
    s.italic = true;
  },
  4: (s) => {
    s.underline = true;
  },
  22: (s) => {
    s.bold = s.dim = false;
  },
  23: (s) => {
    s.italic = false;
  },
  24: (s) => {
    s.underline = false;
  },
  39: (s) => {
    s.fg = null;
  },
  49: (s) => {
    s.bg = null;
  },
};

function applyBasicColor(style: Style, c: number): boolean {
  if (c >= 30 && c <= 37) style.fg = STD[c - 30]!;
  else if (c >= 40 && c <= 47) style.bg = STD[c - 40]!;
  else if (c >= 90 && c <= 97) style.fg = BRIGHT[c - 90]!;
  else if (c >= 100 && c <= 107) style.bg = BRIGHT[c - 100]!;
  else return false;
  return true;
}

function applySgr(style: Style, params: string): void {
  const codes = (params === '' ? '0' : params)
    .split(';')
    .map((p) => (p === '' ? 0 : parseInt(p, 10)));
  for (let k = 0; k < codes.length; k++) {
    const c = codes[k]!;
    if (Number.isNaN(c)) continue;
    const attr = ATTR[c];
    if (attr) {
      attr(style);
    } else if (c === 38 || c === 48) {
      const r = readExtended(codes, k);
      if (r) {
        if (c === 38) style.fg = r.color;
        else style.bg = r.color;
        k = r.next;
      }
    } else {
      applyBasicColor(style, c);
    }
  }
}

function styleNode(text: string, style: Style): Node {
  if (isDefault(style)) return document.createTextNode(text);
  const span = document.createElement('span');
  span.textContent = text;
  const s = span.style;
  if (style.fg) s.color = style.fg;
  if (style.bg) s.backgroundColor = style.bg;
  if (style.bold) s.fontWeight = 'bold';
  if (style.dim) s.opacity = '0.6';
  if (style.italic) s.fontStyle = 'italic';
  if (style.underline) s.textDecoration = 'underline';
  return span;
}

function scanEscape(input: string, i: number): { next: number; sgr: string | null } {
  const n = input.length;
  const kind = input[i + 1];
  if (kind === '[') {
    let j = i + 2;
    while (j < n && input.charCodeAt(j) >= 0x30 && input.charCodeAt(j) <= 0x3f) j++;
    while (j < n && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j++;
    if (j < n && input[j] === 'm') return { next: j + 1, sgr: input.slice(i + 2, j) };
    return { next: j < n ? j + 1 : n, sgr: null };
  }
  if (kind === ']') {
    let j = i + 2;
    while (j < n && input.charCodeAt(j) !== 0x07 && !(input[j] === ESC && input[j + 1] === '\\'))
      j++;
    return { next: j < n && input[j] === ESC ? j + 2 : j + 1, sgr: null };
  }

  let j = i + 1;
  while (j < n && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j++;
  return { next: j < n ? j + 1 : n, sgr: null };
}

export function ansiToDom(input: string): Node {
  if (!input.includes(ESC)) return document.createTextNode(input);
  const frag = document.createDocumentFragment();
  const style = freshStyle();
  let text = '';
  const flush = (): void => {
    if (text) frag.appendChild(styleNode(text, style));
    text = '';
  };
  const n = input.length;
  let i = 0;
  while (i < n) {
    if (input[i] !== ESC) {
      text += input[i];
      i++;
      continue;
    }
    const { next, sgr } = scanEscape(input, i);
    if (sgr !== null) {
      flush();
      applySgr(style, sgr);
    }
    i = next;
  }
  flush();
  return frag;
}
