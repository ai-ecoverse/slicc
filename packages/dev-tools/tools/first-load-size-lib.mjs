export function parseStaticImports(source) {
  const specifiers = new Set();

  const fromRe = /\bfrom\s*["'](\.\.?\/[^"']+)["']/g;

  const bareRe = /\bimport\s*["'](\.\.?\/[^"']+)["']/g;
  for (const re of [fromRe, bareRe]) {
    let m;
    while ((m = re.exec(source)) !== null) specifiers.add(m[1]);
  }
  return [...specifiers];
}

export function manifestEagerClosure(manifest, entryKey) {
  if (!manifest[entryKey]) {
    throw new Error(`manifest has no entry for ${entryKey}`);
  }
  const seenKeys = new Set();
  const stack = [entryKey];
  while (stack.length > 0) {
    const key = stack.pop();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const chunk = manifest[key];
    if (!chunk) continue;
    for (const imp of chunk.imports ?? []) stack.push(imp);
  }
  const files = new Set();
  for (const key of seenKeys) {
    const chunk = manifest[key];
    if (chunk?.file) files.add(chunk.file);
    for (const css of chunk?.css ?? []) files.add(css);
  }
  return [...files];
}

export function chunkEagerClosure(entryFile, readChunk) {
  const seen = new Set();
  const stack = [entryFile];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    const source = readChunk(file);
    if (source === null) continue;
    seen.add(file);
    for (const spec of parseStaticImports(source)) {
      stack.push(spec.replace(/^(\.\.?\/)+/, ''));
    }
  }
  return [...seen];
}

export const EAGER_GRAPHS = ['page', 'worker'];

export function ceilingKeyFor(graph) {
  return `${graph}EagerCeilingKb`;
}

export function bytesToKb(bytes) {
  return Math.round(bytes / 1024);
}

export function checkFirstLoad(limits, measuredBytes, baselineBytes, options = {}) {
  const failures = [];
  const notes = [];
  const rows = [];
  const { maxDeltaKb } = limits;
  if (typeof maxDeltaKb !== 'number') {
    failures.push('limits file is missing a numeric "maxDeltaKb"');
  }
  if (!baselineBytes) {
    notes.push(
      options.baselineNote ??
        'baseline unavailable — the merge-base could not be measured, so the per-change delta ' +
          'check was SKIPPED and only the absolute ceilings were enforced.'
    );
  }
  for (const graph of EAGER_GRAPHS) {
    const row = gradeGraph(graph, limits, measuredBytes, baselineBytes);
    rows.push(row);
    failures.push(...row.failures);
  }
  return { failures, notes, rows };
}

function gradeGraph(graph, limits, measuredBytes, baselineBytes) {
  const ceilingKey = ceilingKeyFor(graph);
  const ceiling = limits[ceilingKey];
  const bytes = measuredBytes[graph];
  const kb = bytesToKb(bytes);
  const baseBytes = baselineBytes?.[graph] ?? null;
  const deltaKb = baseBytes === null ? null : (bytes - baseBytes) / 1024;
  const failures = [];

  if (typeof ceiling !== 'number') {
    failures.push(`limits file is missing a numeric "${ceilingKey}"`);
    return { graph, kb, deltaKb, ceiling: null, headroomKb: null, failures };
  }
  if (deltaKb !== null && typeof limits.maxDeltaKb === 'number' && deltaKb > limits.maxDeltaKb) {
    failures.push(
      `${graph} graph: this change adds ${deltaKb.toFixed(1)} kB to the eager first-load ` +
        `closure (merge-base ${bytesToKb(baseBytes)} kB -> ${kb} kB), over the ` +
        `${limits.maxDeltaKb} kB per-change allowance. A static import is hoisting a chunk ` +
        `into the boot-critical graph — make it lazy. If the growth is genuinely required, ` +
        `justify it in the PR body.`
    );
  }
  if (kb > ceiling) {
    failures.push(
      `${graph} graph: eager first-load payload is ${kb} kB, over the ${ceiling} kB ceiling ` +
        `("${ceilingKey}"). The ceiling is a deliberate cold-boot limit, not a number to nudge ` +
        `when a build goes red: pay down the eager graph, or raise it with a reason in the PR body.`
    );
  }
  return { graph, kb, deltaKb, ceiling, headroomKb: ceiling - kb, failures };
}
