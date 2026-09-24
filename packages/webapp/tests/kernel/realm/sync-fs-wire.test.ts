import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// typescript-js is the v6 compiler that exposes the AST API (the v7 `typescript`
// package is the native port with no createSourceFile — see webapp CLAUDE.md).
import ts from 'typescript-js';
import { describe, expect, it } from 'vitest';
import {
  SYNC_EXEC_CHANNEL,
  SYNC_EXEC_MAX_TIMEOUT_MS,
  SYNC_FS_ROUTE_PREFIX,
} from '../../../src/kernel/realm/sync-fs-wire.js';

const WIRE_SRC = fileURLToPath(
  new URL('../../../src/kernel/realm/sync-fs-wire.ts', import.meta.url)
);

/**
 * Collect every relative module specifier in `src`, across ALL edge forms —
 * `import … from`, side-effect `import`, `export … from` re-exports, and dynamic
 * `import()` — by walking the TypeScript AST rather than matching one import
 * syntax. A regex that only saw `import … from` would let a re-export or dynamic
 * import recreate the exact back-edge this guard exists to prevent.
 */
function relativeModuleSpecifiers(src: string): string[] {
  const sf = ts.createSourceFile(
    'sync-fs-wire.ts',
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs.filter((s) => s.startsWith('.'));
}

/**
 * The wire module advertises itself as the dependency-free leaf of the sync
 * subsystem — every side imports it, so it must import nothing back from its
 * own consumers (the dispatch modules + token registry), else the fan-in
 * inverts into a cycle cluster no lint here can see (kernel/ is unranked). This
 * guard fails closed if any relative module edge ever creeps back in.
 */
describe('sync-fs-wire — dependency-free leaf', () => {
  it('imports nothing from sibling realm modules (no back-edges)', () => {
    const src = readFileSync(WIRE_SRC, 'utf8');
    expect(relativeModuleSpecifiers(src)).toEqual([]);
  });

  it('rejects every relative module edge form, not just `import … from`', () => {
    // Guards the guard: a re-export, side-effect import, or dynamic import must
    // each be reported so no back-edge form slips past.
    expect(relativeModuleSpecifiers("export type { X } from './sync-exec-dispatch.js';")).toEqual([
      './sync-exec-dispatch.js',
    ]);
    expect(relativeModuleSpecifiers("import './sync-fs-dispatch.js';")).toEqual([
      './sync-fs-dispatch.js',
    ]);
    expect(
      relativeModuleSpecifiers("async function f() { await import('./sync-fs-dispatch.js'); }")
    ).toEqual(['./sync-fs-dispatch.js']);
  });

  it('owns the wire-payload contract it composes from', () => {
    // The `SyncFsReqMsg` union is composed here from `SyncFsRequest` /
    // `SyncExecRequest`, so those types must be defined in this module, not
    // re-imported from a consumer.
    const src = readFileSync(WIRE_SRC, 'utf8');
    expect(src).toMatch(/export interface SyncFsRequest\b/);
    expect(src).toMatch(/export interface SyncExecRequest\b/);
    expect(src).toMatch(/export type SyncFsResult\b/);
    expect(src).toMatch(/export const SYNC_EXEC_CHANNEL\b/);
    // Runtime constants stay live and importable.
    expect(SYNC_EXEC_CHANNEL).toBe('exec');
    expect(SYNC_EXEC_MAX_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SYNC_FS_ROUTE_PREFIX).toBe('/__slicc/fs-sync/');
  });
});
