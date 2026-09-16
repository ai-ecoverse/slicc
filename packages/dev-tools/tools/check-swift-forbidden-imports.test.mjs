import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkForbiddenImports, FORBIDDEN_IMPORT_RULES } from './check-swift-forbidden-imports.mjs';
import { collectImportSites } from './check-swift-unused-deps-lib.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-swift-forbidden-imports.mjs');

const WIDGET_RULE = {
  id: 'widget-no-webrtc',
  roots: ['packages/ios-app/SliccWidgets'],
  modules: ['WebRTC'],
  reason: 'WidgetKit extensions have a tight memory budget',
};

describe('FORBIDDEN_IMPORT_RULES', () => {
  it('forbids WebRTC under SliccWidgets', () => {
    const rule = FORBIDDEN_IMPORT_RULES.find((r) => r.modules.includes('WebRTC'));
    expect(rule).toBeDefined();
    expect(rule.roots).toContain('packages/ios-app/SliccWidgets');
  });
});

describe('collectImportSites', () => {
  it('records the line of a real import after a comment and a blank', () => {
    const source = ['import Foundation', '// import Logging', '', 'import WebRTC', ''].join('\n');
    expect(collectImportSites(source)).toEqual([
      { module: 'Foundation', line: 1, kind: 'import' },
      { module: 'WebRTC', line: 4, kind: 'import' },
    ]);
  });

  it('records canImport sites with their kind', () => {
    expect(collectImportSites('#if canImport(WebRTC)\n#endif\n')).toEqual([
      { module: 'WebRTC', line: 1, kind: 'canImport' },
    ]);
  });
});

describe('checkForbiddenImports against a scratch tree', () => {
  const roots = [];

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function scratchRepo(sources) {
    const root = mkdtempSync(resolve(tmpdir(), 'slicc-swift-forbidden-'));
    roots.push(root);
    for (const [rel, body] of Object.entries(sources)) {
      const abs = resolve(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return root;
  }

  it('flags a WebRTC import in SliccWidgets', () => {
    const root = scratchRepo({
      'packages/ios-app/SliccWidgets/SliccWidgetsBundle.swift':
        'import SwiftUI\nimport WebRTC\nimport WidgetKit\n',
    });
    const { findings } = checkForbiddenImports(root, [WIDGET_RULE]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'forbidden-import',
      file: 'packages/ios-app/SliccWidgets/SliccWidgetsBundle.swift',
      line: 2,
    });
    expect(findings[0].message).toContain('WebRTC');
    expect(findings[0].message).toContain('packages/ios-app/SliccWidgets');
  });

  it('flags @preconcurrency and canImport probes of WebRTC', () => {
    const root = scratchRepo({
      'packages/ios-app/SliccWidgets/Probe.swift':
        '@preconcurrency import WebRTC\n#if canImport(WebRTC)\n#endif\n',
    });
    const { findings } = checkForbiddenImports(root, [WIDGET_RULE]);
    expect(findings.map((f) => f.line).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(findings.every((f) => f.code === 'forbidden-import')).toBe(true);
  });

  it('ignores a commented-out or string-literal WebRTC import', () => {
    const root = scratchRepo({
      'packages/ios-app/SliccWidgets/SliccWidgetsBundle.swift': [
        'import SwiftUI',
        '// import WebRTC',
        'let snippet = "import WebRTC"',
        '',
      ].join('\n'),
    });
    expect(checkForbiddenImports(root, [WIDGET_RULE]).findings).toEqual([]);
  });

  it('does not flag WebRTC outside the widget root', () => {
    const root = scratchRepo({
      'packages/ios-app/SliccWidgets/SliccWidgetsBundle.swift':
        'import SwiftUI\nimport WidgetKit\n',
      'packages/ios-app/SliccFollower/Call.swift': 'import WebRTC\n',
    });
    expect(checkForbiddenImports(root, [WIDGET_RULE]).findings).toEqual([]);
  });

  it('fails closed when a configured root is missing', () => {
    const root = scratchRepo({
      'packages/ios-app/SliccFollower/Call.swift': 'import WebRTC\n',
    });
    const { findings } = checkForbiddenImports(root, [WIDGET_RULE]);
    expect(findings).toEqual([
      expect.objectContaining({
        code: 'forbidden-import-root-missing',
        file: 'packages/ios-app/SliccWidgets',
      }),
    ]);
  });

  it('fails closed when a configured root has no Swift files', () => {
    const root = scratchRepo({
      'packages/ios-app/SliccWidgets/Info.plist': '<plist></plist>\n',
    });
    const { findings } = checkForbiddenImports(root, [WIDGET_RULE]);
    expect(findings).toEqual([
      expect.objectContaining({
        code: 'forbidden-import-root-empty',
        file: 'packages/ios-app/SliccWidgets',
      }),
    ]);
  });

  it('exits non-zero with a GitHub annotation when a finding exists', () => {
    const root = scratchRepo({
      'packages/ios-app/SliccWidgets/SliccWidgetsBundle.swift': 'import WebRTC\n',
      'packages/swift-launcher/SliccstartWidgets/Bundle.swift': 'import SwiftUI\n',
      'packages/swift-widgetkit/Sources/SliccWidgetKit/Kit.swift': 'import SwiftUI\n',
    });
    const { status, stderr } = runCli(root);
    expect(status).toBe(1);
    expect(stderr).toContain('::error file=packages/ios-app/SliccWidgets/SliccWidgetsBundle.swift');
    expect(stderr).toContain('forbidden-import');
  });
});

describe('end-to-end against the repo', () => {
  it('passes for the checked-in widget surfaces', () => {
    const out = execFileSync('node', [scriptPath], { encoding: 'utf8' });
    expect(out).toMatch(/^ok: no forbidden Swift imports in \d+ files across \d+ roots/);
    const { findings, scannedRoots } = checkForbiddenImports(repoRoot);
    expect(findings).toEqual([]);
    expect(scannedRoots).toEqual(
      expect.arrayContaining([
        'packages/ios-app/SliccWidgets',
        'packages/swift-launcher/SliccstartWidgets',
        'packages/swift-widgetkit/Sources/SliccWidgetKit',
      ])
    );
  });
});

function runCli(root) {
  try {
    return {
      status: 0,
      stderr: '',
      stdout: execFileSync('node', [scriptPath, '--root', root], { encoding: 'utf8' }),
    };
  } catch (err) {
    return { status: err.status, stderr: String(err.stderr), stdout: String(err.stdout) };
  }
}
