/**
 * Pure helpers for bundle-budget-reconcile.mjs: parse size-limit budgets,
 * decide which exceeded budgets a dependency bump may raise, and rewrite the
 * `limit` strings in a package.json without reformatting the file.
 *
 * size-limit parses decimal units (1 kB = 1000 B, 1 MB = 1000 kB, so
 * "25.917 MB" is 25,917,000 bytes) and binary units (1 KiB = 1024 B,
 * 1 MiB = 1024 KiB). Raised limits keep the unit the budget was written in and
 * are rounded UP.
 */

const UNIT_BYTES = { b: 1, kb: 1000, mb: 1000 ** 2, kib: 1024, mib: 1024 ** 2 };
const UNIT_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|kib|mib)\s*$/i;

/** Parse a size-limit `limit` string ("25.917 MB", "27 MiB", "60 kB") to bytes. */
export function parseLimit(limit) {
  const match = UNIT_PATTERN.exec(String(limit));
  if (!match) throw new Error(`Unsupported size-limit limit: ${JSON.stringify(limit)}`);
  return Math.round(Number(match[1]) * UNIT_BYTES[match[2].toLowerCase()]);
}

/**
 * Format `bytes` in the same unit as `previous`, rounded UP (three decimals for
 * MB/MiB, whole units otherwise) so the result is never below `bytes`.
 */
export function formatLimit(bytes, previous) {
  const unit = UNIT_PATTERN.exec(String(previous))?.[2] ?? 'kB';
  const lower = unit.toLowerCase();
  const scale = lower === 'mb' || lower === 'mib' ? 1000 : 1;
  // The epsilon keeps an exact fit (e.g. 25,923,000 B → 25.923 MB) from
  // ceiling up a step on floating-point noise.
  const value = Math.ceil((bytes / UNIT_BYTES[lower]) * scale - 1e-9) / scale;
  return `${value.toFixed(scale === 1 ? 0 : 3)} ${unit}`;
}

/**
 * Compare size-limit results to the configured budgets.
 *
 * @param {Array<{name: string, limit: string}>} budgets  `size-limit` entries from package.json
 * @param {Array<{name: string, size: number}>} results   `size-limit --json` output
 * @param {{maxGrowthBytes: number}} options               largest overshoot a bump may absorb
 * @returns {{raises: Array<{name: string, from: string, to: string, size: number, overBy: number}>,
 *            blocked: Array<{name: string, from: string, size: number, overBy: number}>}}
 */
export function planBudgetRaises(budgets, results, { maxGrowthBytes }) {
  const raises = [];
  const blocked = [];
  for (const budget of budgets) {
    const result = results.find((r) => r.name === budget.name);
    if (!result || typeof result.size !== 'number') {
      throw new Error(`size-limit reported no size for budget "${budget.name}"`);
    }
    const limitBytes = parseLimit(budget.limit);
    const overBy = result.size - limitBytes;
    if (overBy <= 0) continue;
    const entry = { name: budget.name, from: budget.limit, size: result.size, overBy };
    if (overBy > maxGrowthBytes) blocked.push(entry);
    else raises.push({ ...entry, to: formatLimit(result.size, budget.limit) });
  }
  return { raises, blocked };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite the `limit` of each raised budget in the package.json text, leaving
 * every other byte (key order, indentation) untouched.
 */
export function applyBudgetRaises(packageJsonText, raises) {
  let text = packageJsonText;
  for (const { name, from, to } of raises) {
    const pattern = new RegExp(
      `("name"\\s*:\\s*${escapeRegExp(JSON.stringify(name))}[^}]*?"limit"\\s*:\\s*)${escapeRegExp(JSON.stringify(from))}`
    );
    if (!pattern.test(text)) {
      throw new Error(`Could not find the "${name}" budget (limit ${from}) in package.json`);
    }
    text = text.replace(pattern, `$1${JSON.stringify(to)}`);
  }
  return text;
}
