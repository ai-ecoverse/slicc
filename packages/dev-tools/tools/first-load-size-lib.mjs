/**
 * First-load size accounting for the webapp build (dist/ui).
 *
 * "First load" = the EAGER import closure actually fetched before the app
 * is interactive on a cold cache: the page entry's static import graph
 * plus the kernel worker entry's static import graph. Lazy `import()`
 * chunks (wasm glue consumers, pdfjs, kokoro, shiki grammars, provider
 * modules, vfs-root seed content, …) are excluded — they load on demand.
 *
 * Two graph sources:
 *  - Page graph: Vite's `.vite/manifest.json` records per-chunk static
 *    `imports`, so the closure is a straight graph walk from the HTML
 *    entry.
 *  - Worker graph: the kernel worker is bundled as a separate Rollup
 *    graph that the manifest does NOT cover, so we parse static import /
 *    export-from specifiers out of the emitted ES chunks and walk those.
 *
 * Pure functions only — the CLI wrapper (`check-first-load-size.mjs`)
 * owns filesystem access and process exit codes.
 */

/**
 * Extract relative static-import specifiers from emitted (minified) ES
 * module code. Matches `import ... from "./x.js"`, `export ... from
 * "./x.js"`, and bare `import "./x.js"`. Dynamic `import("./x.js")` and
 * template-literal imports are intentionally NOT matched (parens /
 * backticks never fit the patterns). Callers must filter the result
 * against files that actually exist in the bundle — arbitrary string
 * content (e.g. inlined docs) can contain lookalike fragments.
 *
 * @param {string} source
 * @returns {string[]} deduped specifiers as written (e.g. `./chunk-abc.js`)
 */
export function parseStaticImports(source) {
  const specifiers = new Set();
  // `from "./x"` — covers import-from and export-from forms.
  const fromRe = /\bfrom\s*["'](\.\.?\/[^"']+)["']/g;
  // Bare side-effect import: `import"./x"` (no `from`, no parens).
  const bareRe = /\bimport\s*["'](\.\.?\/[^"']+)["']/g;
  for (const re of [fromRe, bareRe]) {
    let m;
    while ((m = re.exec(source)) !== null) specifiers.add(m[1]);
  }
  return [...specifiers];
}

/**
 * Walk the page graph: transitive closure of `imports` in a Vite
 * manifest, starting from `entryKey`. Returns emitted file names
 * (manifest `file` values), entry included.
 *
 * @param {Record<string, {file: string, imports?: string[]}>} manifest
 * @param {string} entryKey
 * @returns {string[]}
 */
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
  return [...seenKeys].map((key) => manifest[key]?.file).filter(Boolean);
}

/**
 * Walk a bundled ES-chunk graph by parsing static imports out of the
 * emitted files themselves (used for the worker graph, which the Vite
 * manifest does not cover).
 *
 * @param {string} entryFile file name relative to the assets dir
 * @param {(file: string) => string | null} readChunk returns source, or
 *   null when the file does not exist in the bundle (specifier is then
 *   ignored — see parseStaticImports on lookalike string content)
 * @returns {string[]} file names in the closure, entry included
 */
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
      // Specifiers are sibling-relative (`./name-hash.js`); normalize to
      // a bare file name within the same assets dir.
      stack.push(spec.replace(/^(\.\.?\/)+/, ''));
    }
  }
  return [...seen];
}

/**
 * Compare measured eager sizes against budgets.
 *
 * @param {{pageEagerKb: number, workerEagerKb: number}} budgets
 * @param {{pageEagerKb: number, workerEagerKb: number}} measured
 * @param {number} [ratchetSlackPct] headroom percentage above which the
 *   budget should be tightened (default 5)
 * @returns {{failures: string[], ratchetHints: string[]}}
 */
export function checkBudgets(budgets, measured, ratchetSlackPct = 5) {
  const failures = [];
  const ratchetHints = [];
  for (const key of ['pageEagerKb', 'workerEagerKb']) {
    const limit = budgets[key];
    const actual = measured[key];
    if (typeof limit !== 'number') {
      failures.push(`budget file is missing a numeric "${key}"`);
      continue;
    }
    if (actual > limit) {
      failures.push(
        `${key}: eager first-load payload is ${actual} kB, over the ${limit} kB budget. ` +
          `A static import is hoisting a chunk into the boot-critical graph — make it lazy, ` +
          `or (with a reason in the PR body) raise the budget.`
      );
    } else if (actual < limit * (1 - ratchetSlackPct / 100)) {
      ratchetHints.push(
        `${key}: measured ${actual} kB vs ${limit} kB budget — tighten the budget (ratchet).`
      );
    }
  }
  return { failures, ratchetHints };
}
