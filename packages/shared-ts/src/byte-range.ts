export interface ByteRange {
  start: number;
  end: number;
}

export function parseByteRange(
  header: string | null | undefined,
  size: number
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
