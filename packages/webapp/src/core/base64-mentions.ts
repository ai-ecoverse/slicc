import { normalizeBase64 } from '@slicc/shared-ts';

export const MIN_PAYLOAD_CHARS = 128;

export interface Base64Candidate {
  raw: string;

  data: string;

  declaredMime?: string;

  start: number;

  end: number;
}

const DATA_URL_RE = /data:([\w.+-]+\/[\w.+-]+)(?:;[\w.+-]+=[^;,]*)*;base64,([A-Za-z0-9+/=]+)/g;

const RUN_OPENERS = '\\s"\'`(\\[{<,;:=';
const RUN_CLOSERS = '\\s"\'`)\\]}>,;:.!?';

const BARE_RUN_RE = new RegExp(
  `(?:^|[${RUN_OPENERS}])([A-Za-z0-9+/]{${MIN_PAYLOAD_CHARS},}={0,2})(?=$|[${RUN_CLOSERS}])`,
  'g'
);

const MIN_WRAP_COLUMNS = 16;

interface SourceLine {
  start: number;
  end: number;
  text: string;
}

function scanLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (;;) {
    const br = text.indexOf('\n', start);
    const end = br < 0 ? text.length : br;

    const trimmed = text[end - 1] === '\r' ? end - 1 : end;
    lines.push({ start, end: trimmed, text: text.slice(start, trimmed) });
    if (br < 0) return lines;
    start = br + 1;
  }
}

const PURE_ALPHABET_RE = /^[A-Za-z0-9+/]+$/;
const PADDED_TAIL_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function findWrappedBlocks(text: string): Base64Candidate[] {
  const lines = scanLines(text);
  const blocks: Base64Candidate[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const width = wrapWidthAt(lines, i);
    if (width === null) continue;
    const tail = blockEnd(lines, i, width);
    if (tail === i) continue;
    const pieces = lines.slice(i, tail + 1);
    const lead = precedingFragment(lines, i, width);
    if (lead) pieces.unshift(lead);
    const block = claimBlock(text, pieces);
    if (block) blocks.push(block);
    i = tail;
  }

  return blocks;
}

function wrapWidthAt(lines: readonly SourceLine[], i: number): number | null {
  const first = lines[i];
  if (!first) return null;
  const width = first.text.length;
  if (width < MIN_WRAP_COLUMNS || width % 4 !== 0) return null;
  return PURE_ALPHABET_RE.test(first.text) ? width : null;
}

function blockEnd(lines: readonly SourceLine[], i: number, width: number): number {
  let last = i;
  for (let j = i + 1; j < lines.length; j += 1) {
    const line = lines[j];
    if (!line || line.text.length !== width || !PURE_ALPHABET_RE.test(line.text)) break;
    last = j;
  }
  const next = lines[last + 1];
  if (!next || next.text.length === 0 || next.text.length >= width) return last;
  if (!PADDED_TAIL_RE.test(next.text)) return last;
  const after = lines[last + 2];
  const blockContinues =
    after !== undefined && after.text.length === width && PURE_ALPHABET_RE.test(after.text);
  return blockContinues ? last : last + 1;
}

function precedingFragment(
  lines: readonly SourceLine[],
  i: number,
  width: number
): SourceLine | null {
  const prev = lines[i - 1];
  if (!prev || prev.text.length <= width) return null;
  const cut = prev.text.length - width;
  const suffix = prev.text.slice(cut);
  if (!PURE_ALPHABET_RE.test(suffix)) return null;
  if (PURE_ALPHABET_RE.test(prev.text[cut - 1] ?? ' ')) return null;
  return { start: prev.start + cut, end: prev.end, text: suffix };
}

function claimBlock(text: string, block: readonly SourceLine[]): Base64Candidate | null {
  const joined = block.map((line) => line.text).join('');
  if (joined.replace(/=+$/, '').length < MIN_PAYLOAD_CHARS) return null;
  if (joined.length % 4 !== 0) return null;
  const data = normalizeBase64(joined);
  if (!data) return null;
  const start = block[0]?.start ?? 0;
  const end = block[block.length - 1]?.end ?? start;
  return { raw: text.slice(start, end), data, start, end };
}

export function findBase64Mentions(text: string): Base64Candidate[] {
  const found: Base64Candidate[] = [];
  const claimed: Array<[number, number]> = [];

  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s);

  DATA_URL_RE.lastIndex = 0;
  for (const match of text.matchAll(DATA_URL_RE)) {
    const payload = match[2] ?? '';
    if (payload.length < MIN_PAYLOAD_CHARS) continue;
    const data = normalizeBase64(payload);
    if (!data) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    found.push({ raw: match[0], data, declaredMime: match[1] ?? '', start, end });
    claimed.push([start, end]);
  }

  for (const block of findWrappedBlocks(text)) {
    if (overlaps(block.start, block.end)) continue;
    found.push(block);
    claimed.push([block.start, block.end]);
  }

  BARE_RUN_RE.lastIndex = 0;
  for (const match of text.matchAll(BARE_RUN_RE)) {
    const raw = match[1] ?? '';

    const start = (match.index ?? 0) + (match[0].length - raw.length);
    const end = start + raw.length;
    if (overlaps(start, end)) continue;

    if (raw.length % 4 !== 0) continue;
    const data = normalizeBase64(raw);
    if (!data) continue;
    found.push({ raw, data, start, end });
    claimed.push([start, end]);
  }

  return found.sort((a, b) => a.start - b.start);
}
