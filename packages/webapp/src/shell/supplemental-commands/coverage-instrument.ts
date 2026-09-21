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
 * transpile, so we walk the source AST, insert `__slicc_cov.hit(file, id)`
 * before each statement, and map ids back to original line numbers.
 *
 * Counters close over the runner's `__slicc_cov` binding rather than
 * `globalThis.__sliccCov`, so a user `const globalThis = {}` or a
 * parameter named `globalThis` cannot divert or TDZ the probes.
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
export const COVERAGE_IDENT = '__slicc_cov';

const RUNTIME = `
const ${COVERAGE_IDENT} = {
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

function shouldSkipStatement(
  ts: TypeScriptModule,
  stmt: import('typescript-js').Statement
): boolean {
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
        f.createIdentifier(COVERAGE_IDENT),
        f.createIdentifier('hit')
      ),
      undefined,
      [f.createStringLiteral(filename), f.createNumericLiteral(id)]
    )
  );
}

/**
 * Insert a `__slicc_cov.hit(file, id)` call before every executable
 * statement. Unbraced `if`/`else`/loop bodies are wrapped in a block
 * so the body gets its own counter. Returns the printed source (still
 * TS/JS, not yet CJS) and a statement map keyed by original lines.
 */
export function instrumentSource(
  ts: TypeScriptModule,
  source: string,
  filename: string
): { source: string; map: StatementMap } {
  const scriptKind =
    filename.endsWith('.ts') || filename.endsWith('.tsx') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKind);
  const map: StatementMap = [];

  const transformer: import('typescript-js').TransformerFactory<
    import('typescript-js').SourceFile
  > = (ctx) => {
    const f = ctx.factory;
    const visitStatements = (
      statements: readonly import('typescript-js').Statement[]
    ): import('typescript-js').Statement[] => {
      const out: import('typescript-js').Statement[] = [];
      for (const stmt of statements) {
        const visited = (ts.visitNode(stmt, visit) ?? stmt) as import('typescript-js').Statement;
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

    const wrapBody = (
      stmt: import('typescript-js').Statement
    ): import('typescript-js').Statement => {
      if (ts.isBlock(stmt)) {
        return (ts.visitNode(stmt, visit) ?? stmt) as import('typescript-js').Statement;
      }
      const block = f.createBlock([stmt], true);
      return (ts.visitNode(block, visit) ?? block) as import('typescript-js').Statement;
    };

    const expr = (node: import('typescript-js').Expression): import('typescript-js').Expression =>
      (ts.visitNode(node, visit) ?? node) as import('typescript-js').Expression;

    const rewriteIf = (node: import('typescript-js').IfStatement) =>
      f.updateIfStatement(
        node,
        expr(node.expression),
        wrapBody(node.thenStatement),
        node.elseStatement ? wrapBody(node.elseStatement) : undefined
      );

    const rewriteWhile = (node: import('typescript-js').WhileStatement) =>
      f.updateWhileStatement(node, expr(node.expression), wrapBody(node.statement));

    const rewriteDo = (node: import('typescript-js').DoStatement) =>
      f.updateDoStatement(node, wrapBody(node.statement), expr(node.expression));

    const rewriteFor = (node: import('typescript-js').ForStatement) =>
      f.updateForStatement(
        node,
        node.initializer ? ts.visitNode(node.initializer, visit) : undefined,
        node.condition ? ts.visitNode(node.condition, visit) : undefined,
        node.incrementor ? ts.visitNode(node.incrementor, visit) : undefined,
        wrapBody(node.statement)
      ) as import('typescript-js').Node;

    const rewriteForInOf = (
      node: import('typescript-js').ForInStatement | import('typescript-js').ForOfStatement
    ) => {
      const initializer = (ts.visitNode(node.initializer, visit) ??
        node.initializer) as import('typescript-js').ForInitializer;
      const expression = expr(node.expression);
      if (ts.isForInStatement(node)) {
        return f.updateForInStatement(node, initializer, expression, wrapBody(node.statement));
      }
      return f.updateForOfStatement(
        node,
        node.awaitModifier,
        initializer,
        expression,
        wrapBody(node.statement)
      );
    };

    const rewriteContainer = (node: import('typescript-js').Node) => {
      if (ts.isBlock(node)) return f.updateBlock(node, visitStatements(node.statements));
      if (ts.isModuleBlock(node))
        return f.updateModuleBlock(node, visitStatements(node.statements));
      if (ts.isSourceFile(node)) return f.updateSourceFile(node, visitStatements(node.statements));
      if (ts.isCaseClause(node)) {
        return f.updateCaseClause(node, node.expression, visitStatements(node.statements));
      }
      if (ts.isDefaultClause(node)) {
        return f.updateDefaultClause(node, visitStatements(node.statements));
      }
      return undefined;
    };

    const visit = (node: import('typescript-js').Node): import('typescript-js').Node => {
      if (ts.isIfStatement(node)) return rewriteIf(node);
      if (ts.isWhileStatement(node)) return rewriteWhile(node);
      if (ts.isDoStatement(node)) return rewriteDo(node);
      if (ts.isForStatement(node)) return rewriteFor(node);
      if (ts.isForInStatement(node) || ts.isForOfStatement(node)) return rewriteForInOf(node);
      return rewriteContainer(node) ?? ts.visitEachChild(node, visit, ctx);
    };

    return (node) => ts.visitNode(node, visit) as import('typescript-js').SourceFile;
  };

  const result = ts.transform(sf, [transformer]);
  const printed = ts
    .createPrinter({ newLine: ts.NewLineKind.LineFeed })
    .printFile(result.transformed[0]);
  result.dispose();
  const prelude = `${COVERAGE_IDENT}.init(${JSON.stringify(filename)}, ${map.length});\n`;
  return { source: prelude + printed, map };
}

export function coverageRuntimeSource(): string {
  return RUNTIME;
}

export function coverageDumpSource(): string {
  return `if (${COVERAGE_IDENT} && ${COVERAGE_IDENT}.counts) {
  console.log(${JSON.stringify(COVERAGE_MARKER)} + JSON.stringify(${COVERAGE_IDENT}.counts));
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
    stdout.slice(0, lineStart) +
    (lineEnd === -1 || lineEnd === stdout.length - 1 ? '' : stdout.slice(lineEnd + 1));
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

export function mergeCounts(into: Record<string, number[]>, add: Record<string, number[]>): void {
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
export function toLcov(
  counts: Record<string, number[]>,
  maps: Record<string, StatementMap>
): string {
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

export function coverageSummary(
  counts: Record<string, number[]>,
  maps: Record<string, StatementMap>
): string {
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

/** Resolve `--coverage-dir` like other shell paths: relative to cwd, absolute as-is. */
export function resolveCoverageDir(
  cwd: string,
  coverageDir: string,
  resolvePath: (base: string, path: string) => string
): string {
  const raw = coverageDir || 'coverage';
  const resolved = raw.startsWith('/') ? raw : resolvePath(cwd, raw);
  return resolved.replace(/\/$/, '') || '/';
}
