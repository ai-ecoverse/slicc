const UNIT_BYTES = { b: 1, kb: 1000, mb: 1000 * 1000 };

export function parseLimit(limit) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb)\s*$/i.exec(String(limit));
  if (!match) throw new Error(`Unsupported size-limit limit: ${JSON.stringify(limit)}`);
  return Math.round(Number(match[1]) * UNIT_BYTES[match[2].toLowerCase()]);
}

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
