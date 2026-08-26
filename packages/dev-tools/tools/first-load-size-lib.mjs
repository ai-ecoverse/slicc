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
 * owns filesystem access and process exit codes, and
 * `first-load-baseline.mjs` owns the merge-base worktree build.
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
 * manifest, starting from `entryKey`. Returns emitted file names —
 * each visited chunk's `file` plus its `css` outputs (stylesheets a
 * statically imported chunk forces the page to fetch at boot are
 * recorded in the chunk's `css` array, not as a manifest key of their
 * own). Entry included; deduped.
 *
 * @param {Record<string, {file: string, css?: string[], imports?: string[]}>} manifest
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
  const files = new Set();
  for (const key of seenKeys) {
    const chunk = manifest[key];
    if (chunk?.file) files.add(chunk.file);
    for (const css of chunk?.css ?? []) files.add(css);
  }
  return [...files];
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

/** The two eager graphs the gate measures, in report order. */
export const EAGER_GRAPHS = ['page', 'worker'];

/** `page` -> `pageEagerCeilingKb`. */
export function ceilingKeyFor(graph) {
  return `${graph}EagerCeilingKb`;
}

/** Whole kB, rounded — the unit every limit and report is expressed in. */
export function bytesToKb(bytes) {
  return Math.round(bytes / 1024);
}

/**
 * Gate a measured build against its merge-base and against the ceilings.
 *
 * Two independent checks, deliberately different in kind:
 *
 *  - **Delta** (primary): `measured - baseline` per graph, computed in
 *    bytes, must not exceed `limits.maxDeltaKb`. Both sides are built on
 *    the same machine in the same run, so this is platform-independent and
 *    has a zero noise floor (the webapp build is byte-for-byte
 *    deterministic for a given tree). It fails exactly the changes that
 *    regress cold boot, and never fires on inherited state.
 *  - **Ceiling** (secondary): an absolute cap per graph. A delta gate alone
 *    would let many small under-threshold changes creep the graph upward
 *    forever; the ceiling bounds the total and forces a deliberate decision
 *    once it is reached.
 *
 * `baselineBytes` may be null when the merge-base could not be built
 * (shallow clone, unresolvable ref, broken base). The delta check is then
 * skipped and reported as skipped, while the ceilings still apply — a
 * degraded run rather than a silently green one.
 *
 * @param {{maxDeltaKb: number, pageEagerCeilingKb: number, workerEagerCeilingKb: number}} limits
 * @param {{page: number, worker: number}} measuredBytes eager closure sizes in BYTES
 * @param {{page: number, worker: number} | null} baselineBytes merge-base sizes in BYTES
 * @returns {{failures: string[], notes: string[], rows: Array<object>}}
 */
export function checkFirstLoad(limits, measuredBytes, baselineBytes) {
  const failures = [];
  const notes = [];
  const rows = [];
  const { maxDeltaKb } = limits;
  if (typeof maxDeltaKb !== 'number') {
    failures.push('limits file is missing a numeric "maxDeltaKb"');
  }
  if (!baselineBytes) {
    notes.push(
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

/**
 * Grade one graph against its delta allowance and its ceiling. Split out of
 * `checkFirstLoad` so both stay small and under the complexity gate.
 */
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
