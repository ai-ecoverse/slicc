/**
 * Pure helpers for bundle-budget-reconcile.mjs: parse size-limit budgets,
 * decide which exceeded budgets a dependency bump may raise, and rewrite the
 * `limit` strings in a package.json without reformatting the file.
 *
 * size-limit parses limits with decimal units (1 kB = 1000 B, 1 MB = 1000 kB),
 * so "25.917 MB" is 25,917,000 bytes. Raised limits are rounded UP to whole
 * kilobytes and keep the unit the budget was written in.
 */

const UNIT_BYTES = { b: 1, kb: 1000, mb: 1000 * 1000 };

/** Parse a size-limit `limit` string ("25.917 MB", "60 kB", "512 B") to bytes. */
export function parseLimit(limit) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb)\s*$/i.exec(String(limit));
  if (!match) throw new Error(`Unsupported size-limit limit: ${JSON.stringify(limit)}`);
  return Math.round(Number(match[1]) * UNIT_BYTES[match[2].toLowerCase()]);
}

/**
 * Format `bytes` in the same unit as `previous`, rounded up to the next whole
 * kilobyte so the result is never below the measured size.
 */
export function formatLimit(bytes, previous) {
  const unit = /(b|kb|mb)\s*$/i.exec(String(previous))?.[1] ?? 'kB';
  const kb = Math.ceil(bytes / 1000);
  switch (unit.toLowerCase()) {
    case 'mb':
      return `${(kb / 1000).toFixed(3)} MB`;
    case 'b':
      return `${kb * 1000} B`;
    default:
      return `${kb} kB`;
  }
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
