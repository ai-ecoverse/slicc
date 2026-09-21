/**
 * Statement coverage for the `tst` runner.
 *
 * nyc/c8 wrap a Node child and read V8's inspector coverage. The tst
 * command does not spawn Node: each file is an AsyncFunction in a
 * DedicatedWorker realm (`executeJsCode`). There is no `inspector`
 * module in that realm, and `Profiler.takePreciseCoverage` is CDP-only
 * from outside the page.
 *
 * istanbul-lib-instrument pulls Babel, which we will not put on the
 * webapp boot path (size-limit). TypeScript is already loaded for
 * transpile, so we walk the source AST, insert `globalThis.__sliccCov.hit(file, id)`
 * before each statement, and map ids back to original line numbers.
 *
 * This is statement coverage of files the runner actually executes
 * (the test file and its relative `require()` graph). It does not
 * cover `.jsh` scripts unless a test imports them as a local module.
 */
import type { TypeScriptModule } from './shared.js';

export interface StatementHit {
  id: number;
  line: number;
  endLine: number;
}

export type StatementMap = StatementHit[];

export const COVERAGE_MARKER = '__SLICC_COVERAGE__';

const RUNTIME = `
globalThis.__sliccCov = globalThis.__sliccCov || {
  counts: Object.create(null),
  init: function (file, n) {
    if (!this.counts[file]) this.counts[file] = Array.from({ length: n }, function () { return 0; });
  },
  hit: function (file, id) {
    var c = this.counts[file];
    if (c) c[id]++;
  },
};
`.trim();

function shouldSkipStatement(ts: TypeScriptModule, stmt: import('typescript-js').Statement): boolean {
  return (
    ts.isImportDeclaration(stmt) ||
    ts.isExportDeclaration(stmt) ||
    ts.isImportEqualsDeclaration(stmt) ||
    ts.isInterfaceDeclaration(stmt) ||
    ts.isTypeAliasDeclaration(stmt) ||
    ts.isDebuggerStatement(stmt) ||
    (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression))
  );
}

function hitCall(ts: TypeScriptModule, filename: string, id: number) {
  const f = ts.factory;
  return f.createExpressionStatement(
    f.createCallExpression(
      f.createPropertyAccessExpression(
        f.createPropertyAccessExpression(f.createIdentifier('globalThis'), f.createIdentifier('__sliccCov')),
        f.createIdentifier('hit')
      ),
      undefined,
      [f.createStringLiteral(filename), f.createNumericLiteral(id)]
    )
  );
}

/**
 * Insert a `globalThis.__sliccCov.hit(file, id)` call before every
 * executable statement. Returns the printed source (still TS/JS, not
 * yet CJS) and a statement map keyed by original line numbers.
 */
export function instrumentSource(
  ts: TypeScriptModule,
  source: string,
  filename: string
): { source: string; map: StatementMap } {
  const scriptKind = filename.endsWith('.ts') || filename.endsWith('.tsx') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKind);
  const map: StatementMap = [];

  const transformer: import('typescript-js').TransformerFactory<import('typescript-js').SourceFile> = (
    ctx
  ) => {
    const visitStatements = (
      statements: import('typescript-js').NodeArray<import('typescript-js').Statement>
    ): import('typescript-js').Statement[] => {
      const out: import('typescript-js').Statement[] = [];
      for (const stmt of statements) {
        const visited = ts.visitNode(stmt, visit) as import('typescript-js').Statement;
        if (shouldSkipStatement(ts, visited)) {
          out.push(visited);
          continue;
        }
        const start = sf.getLineAndCharacterOfPosition(stmt.getStart(sf, false));
        const end = sf.getLineAndCharacterOfPosition(stmt.getEnd());
        const id = map.length;
        map.push({ id, line: start.line + 1, endLine: end.line + 1 });
        out.push(hitCall(ts, filename, id));
        out.push(visited);
      }
      return out;
    };

    const visit = (node: import('typescript-js').Node): import('typescript-js').Node => {
      if (ts.isBlock(node)) {
        return ctx.factory.updateBlock(node, visitStatements(node.statements));
      }
      if (ts.isModuleBlock(node)) {
        return ctx.factory.updateModuleBlock(node, visitStatements(node.statements));
      }
      if (ts.isSourceFile(node)) {
        return ctx.factory.updateSourceFile(node, visitStatements(node.statements));
      }
      if (ts.isCaseClause(node)) {
        return ctx.factory.updateCaseClause(
          node,
          node.expression,
          visitStatements(node.statements as unknown as import('typescript-js').NodeArray<import('typescript-js').Statement>)
        );
      }
      if (ts.isDefaultClause(node)) {
        return ctx.factory.updateDefaultClause(
          node,
          visitStatements(node.statements as unknown as import('typescript-js').NodeArray<import('typescript-js').Statement>)
        );
      }
      return ts.visitEachChild(node, visit, ctx);
    };

    return (node) => ts.visitNode(node, visit) as import('typescript-js').SourceFile;
  };

  const result = ts.transform(sf, [transformer]);
  const printed = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(result.transformed[0]);
  result.dispose();
  const prelude = `globalThis.__sliccCov && globalThis.__sliccCov.init(${JSON.stringify(filename)}, ${map.length});\n`;
  return { source: prelude + printed, map };
}

export function coverageRuntimeSource(): string {
  return RUNTIME;
}

export function coverageDumpSource(): string {
  return `if (globalThis.__sliccCov && globalThis.__sliccCov.counts) {
  console.log(${JSON.stringify(COVERAGE_MARKER)} + JSON.stringify(globalThis.__sliccCov.counts));
}`;
}

/** Pull the coverage JSON line out of TAP stdout so reporters stay clean. */
export function extractCoverageCounts(stdout: string): {
  stdout: string;
  counts: Record<string, number[]>;
} {
  const idx = stdout.lastIndexOf(COVERAGE_MARKER);
  if (idx === -1) return { stdout, counts: {} };
  const lineStart = stdout.lastIndexOf('\n', idx - 1) + 1;
  const lineEnd = stdout.indexOf('\n', idx);
  const json = stdout.slice(idx + COVERAGE_MARKER.length, lineEnd === -1 ? stdout.length : lineEnd);
  const cleaned =
    stdout.slice(0, lineStart) + (lineEnd === -1 || lineEnd === stdout.length - 1 ? '' : stdout.slice(lineEnd + 1));
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { stdout, counts: {} };
    }
    return { stdout: cleaned, counts: parsed as Record<string, number[]> };
  } catch {
    return { stdout, counts: {} };
  }
}

export function mergeCounts(
  into: Record<string, number[]>,
  add: Record<string, number[]>
): void {
  for (const [file, counts] of Object.entries(add)) {
    const existing = into[file];
    if (!existing) {
      into[file] = counts.slice();
      continue;
    }
    for (let i = 0; i < counts.length; i++) {
      existing[i] = (existing[i] ?? 0) + (counts[i] ?? 0);
    }
  }
}

/** Istanbul-compatible lcov for statement hits. One DA line per source line. */
export function toLcov(counts: Record<string, number[]>, maps: Record<string, StatementMap>): string {
  const chunks: string[] = [];
  for (const file of Object.keys(counts).sort()) {
    const hits = counts[file] ?? [];
    const map = maps[file] ?? [];
    const byLine = new Map<number, number>();
    for (const stmt of map) {
      const n = hits[stmt.id] ?? 0;
      byLine.set(stmt.line, (byLine.get(stmt.line) ?? 0) + n);
    }
    const lines = [...byLine.keys()].sort((a, b) => a - b);
    const found = lines.length;
    const hit = lines.filter((l) => (byLine.get(l) ?? 0) > 0).length;
    chunks.push('TN:');
    chunks.push(`SF:${file}`);
    for (const line of lines) chunks.push(`DA:${line},${byLine.get(line) ?? 0}`);
    chunks.push(`LF:${found}`);
    chunks.push(`LH:${hit}`);
    chunks.push('end_of_record');
  }
  return chunks.join('\n') + (chunks.length ? '\n' : '');
}

export function coverageSummary(counts: Record<string, number[]>, maps: Record<string, StatementMap>): string {
  const rows: string[] = [];
  let hitAll = 0;
  let foundAll = 0;
  for (const file of Object.keys(counts).sort()) {
    const hits = counts[file] ?? [];
    const map = maps[file] ?? [];
    const found = map.length;
    const hit = map.filter((s) => (hits[s.id] ?? 0) > 0).length;
    hitAll += hit;
    foundAll += found;
    const pct = found === 0 ? 100 : Math.round((1000 * hit) / found) / 10;
    rows.push(`  ${file}  ${pct}% (${hit}/${found})`);
  }
  const pct = foundAll === 0 ? 100 : Math.round((1000 * hitAll) / foundAll) / 10;
  return `coverage statements ${pct}% (${hitAll}/${foundAll})\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
}
