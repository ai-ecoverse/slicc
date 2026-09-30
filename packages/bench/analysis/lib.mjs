// Shared helpers for the read-depth analyses: shell splitting and Markdown tables.

/** Splits `text` outside quotes on the given separators (list longer ones first). */
export function splitShell(text, seps) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const escaped = ch === '\\' && quote !== "'";
    if (escaped) {
      cur += ch + (text[++i] ?? '');
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    const sep = quote ? undefined : seps.find((sp) => text.startsWith(sp, i));
    if (sep) {
      out.push(cur);
      cur = '';
      i += sep.length - 1;
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');

/** Linear-interpolated quantile; NaN for an empty list. */
export function quantile(xs, p) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}

export const median = (xs) => quantile(xs, 0.5);
export const fmt = (x, digits = 0) => (Number.isFinite(x) ? x.toFixed(digits) : '–');

export const table = (head, rows) =>
  [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

/** Adds `x` to the list stored under `key`. */
export function pushTo(map, key, x) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(x);
}

/** Counts values into a Map and returns the top `n` as "`k` share" strings. */
export function topShares(values, n, label = (k) => k) {
  const c = new Map();
  for (const v of values) c.set(v, (c.get(v) ?? 0) + 1);
  return [...c]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, x]) => `${label(k)} ${pct(x, values.length)}`)
    .join(', ');
}

export const readJsonl = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
