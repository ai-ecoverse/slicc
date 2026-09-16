import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkRepo } from './check-swift-forbidden-imports.mjs';
import {
  analyzeSource,
  analyzeXcodegenTarget,
  FORBIDDEN_IMPORT_RULES,
  formatHelp,
  hasPublicSurface,
  WIDGET_FORBIDDEN_MODULES,
  xcodegenTargetDependencies,
} from './check-swift-forbidden-imports-lib.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-swift-forbidden-imports.mjs');

const WIDGET_RULE = FORBIDDEN_IMPORT_RULES.find((r) => r.id === 'ios-widgets-no-webrtc');
const WIDGETKIT_RULE = FORBIDDEN_IMPORT_RULES.find((r) => r.id === 'widgetkit-no-webrtc');

function runCli(args) {
  try {
    return {
      status: 0,
      stdout: execFileSync('node', [scriptPath, ...args], { encoding: 'utf8' }),
      stderr: '',
    };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
}

describe('FORBIDDEN_IMPORT_RULES', () => {
  it('covers the iOS widget host, the macOS widget host, and SliccWidgetKit', () => {
    expect(FORBIDDEN_IMPORT_RULES.map((r) => r.id).sort()).toEqual([
      'ios-widgets-no-webrtc',
      'sliccstart-widgets-no-webrtc',
      'widgetkit-no-webrtc',
    ]);
  });

  it('forbids WebRTC and the tray-follower modules that pull it in', () => {
    expect(WIDGET_FORBIDDEN_MODULES).toEqual([
      'WebRTC',
      'SliccTrayFollower',
      'SliccTrayVFS',
      'SliccTrayKit',
    ]);
    for (const rule of FORBIDDEN_IMPORT_RULES) {
      expect(rule.forbidden).toEqual(WIDGET_FORBIDDEN_MODULES);
    }
  });

  it('points the iOS rule at SliccWidgets sources and the xcodegen target', () => {
    expect(WIDGET_RULE.roots).toEqual(['packages/ios-app/SliccWidgets']);
    expect(WIDGET_RULE.projectYml).toEqual({
      file: 'packages/ios-app/project.yml',
      target: 'SliccWidgets',
    });
  });

  it('does not scan the AppKit widget-gallery executable as a widget process', () => {
    expect(WIDGETKIT_RULE.roots.join('\n')).not.toContain('slicc-widget-gallery');
    expect(WIDGETKIT_RULE.requirePublicSurface).toBe(true);
  });
});

describe('analyzeSource', () => {
  it('flags a plain WebRTC import with its line number', () => {
    const source = 'import Foundation\nimport WebRTC\nimport SwiftUI\n';
    const findings = analyzeSource({
      relPath: 'packages/ios-app/SliccWidgets/Bundle.swift',
      source,
      rule: WIDGET_RULE,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'forbidden-import',
      line: 2,
      ruleId: 'ios-widgets-no-webrtc',
    });
    expect(findings[0].message).toContain("'WebRTC'");
  });

  it('flags @_exported import and canImport of a tray-follower module', () => {
    const source = [
      '@_exported import SliccTrayFollower',
      '#if canImport(SliccTrayKit)',
      'import SliccTrayKit',
      '#endif',
    ].join('\n');
    const findings = analyzeSource({
      relPath: 'SliccWidgets/Leak.swift',
      source,
      rule: WIDGET_RULE,
    });
    expect(findings.map((f) => `${f.line}:${f.message}`).join('\n')).toMatch(/SliccTrayFollower/);
    expect(findings.some((f) => f.message.includes('canImport'))).toBe(true);
    expect(findings.some((f) => f.message.includes("'SliccTrayKit'"))).toBe(true);
  });

  it('ignores a commented-out import and a string-literal fixture', () => {
    const source = [
      'import SliccWidgetKit',
      '// import WebRTC',
      'let snippet = "import SliccTrayFollower"',
      'let generated = """',
      'import WebRTC',
      '"""',
    ].join('\n');
    expect(
      analyzeSource({ relPath: 'SliccWidgets/Bundle.swift', source, rule: WIDGET_RULE })
    ).toEqual([]);
  });

  it('does not flag the modules a widget is allowed to import', () => {
    const source = 'import SliccWidgetKit\nimport SwiftUI\nimport WidgetKit\n';
    expect(
      analyzeSource({ relPath: 'SliccWidgets/Bundle.swift', source, rule: WIDGET_RULE })
    ).toEqual([]);
  });
});

describe('hasPublicSurface', () => {
  it('accepts a public type that is the cross-module API', () => {
    expect(hasPublicSurface('public struct WidgetHost: Equatable {}\n')).toBe(true);
    expect(hasPublicSurface('    open class UnitsTimelineProvider {}\n')).toBe(true);
  });

  it('does not treat a comment or a string as a public surface', () => {
    expect(hasPublicSurface('// public struct WidgetHost {}\nstruct Internal {}\n')).toBe(false);
    expect(hasPublicSurface('let docs = "public struct WidgetHost"\n')).toBe(false);
  });
});

describe('xcodegenTargetDependencies', () => {
  const yml = `name: Demo
targets:
  SliccWidgets:
    type: app-extension
    sources:
      - path: SliccWidgets
    dependencies:
      - package: SliccWidgetKit
      - sdk: WidgetKit.framework
      - package: WebRTC
        product: WebRTC
      - target: SliccTrayKit
  SliccFollower:
    dependencies:
      - package: WebRTC
`;

  it('reads package, product and target entries with line numbers', () => {
    const deps = xcodegenTargetDependencies(yml, 'SliccWidgets');
    expect(deps).toEqual([
      { kind: 'package', name: 'SliccWidgetKit', line: 8 },
      { kind: 'package', name: 'WebRTC', line: 10 },
      { kind: 'product', name: 'WebRTC', line: 11 },
      { kind: 'target', name: 'SliccTrayKit', line: 12 },
    ]);
  });

  it('does not leak a sibling target’s dependencies', () => {
    const follower = xcodegenTargetDependencies(yml, 'SliccFollower');
    expect(follower).toEqual([{ kind: 'package', name: 'WebRTC', line: 15 }]);
  });

  it('returns null when the target is missing', () => {
    expect(xcodegenTargetDependencies(yml, 'Missing')).toBeNull();
  });
});

describe('analyzeXcodegenTarget', () => {
  it('flags a WebRTC package link on the widget target', () => {
    const yml = `targets:
  SliccWidgets:
    dependencies:
      - package: SliccWidgetKit
      - package: WebRTC
`;
    const findings = analyzeXcodegenTarget({
      relPath: 'packages/ios-app/project.yml',
      yml,
      rule: WIDGET_RULE,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'forbidden-target-dependency',
      line: 5,
      ruleId: 'ios-widgets-no-webrtc',
    });
    expect(findings[0].message).toContain("'WebRTC'");
  });

  it('accepts the widgetkit package the extension is supposed to link', () => {
    const yml = `targets:
  SliccWidgets:
    dependencies:
      - package: SliccWidgetKit
      - sdk: WidgetKit.framework
`;
    expect(
      analyzeXcodegenTarget({
        relPath: 'packages/ios-app/project.yml',
        yml,
        rule: WIDGET_RULE,
      })
    ).toEqual([]);
  });

  it('reports a missing xcodegen target instead of passing the rule', () => {
    const findings = analyzeXcodegenTarget({
      relPath: 'packages/ios-app/project.yml',
      yml: 'targets:\n  Other:\n    dependencies: []\n',
      rule: WIDGET_RULE,
    });
    expect(findings.map((f) => f.code)).toEqual(['unresolved-xcodegen-target']);
  });
});

describe('formatHelp', () => {
  it('names every rule and the WebRTC denylist so --help does the thing', () => {
    const help = formatHelp();
    expect(help).toContain('Usage:');
    expect(help).toContain('--help');
    expect(help).toContain('ios-widgets-no-webrtc');
    expect(help).toContain('packages/ios-app/SliccWidgets');
    expect(help).toContain('WebRTC');
    expect(help).toContain('public');
  });
});

describe('end-to-end against the repo', () => {
  it('passes for the checked-in widget sources and project.yml targets', () => {
    const { findings, scannedFiles, ruleCount } = checkRepo(repoRoot);
    expect(findings).toEqual([]);
    expect(ruleCount).toBe(3);
    expect(scannedFiles).toBeGreaterThan(0);
  });

  it('prints ok when invoked as the entry script', () => {
    const { status, stdout } = runCli([]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^ok: 3 forbidden-import rule\(s\) clean \(\d+ Swift files scanned\)/);
  });

  it('prints the rule list on --help without scanning', () => {
    const { status, stdout } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('ios-widgets-no-webrtc');
    expect(stdout).toContain('WebRTC');
  });
});

describe('checkRepo against a scratch tree', () => {
  const roots = [];

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function scratch(layout) {
    const root = mkdtempSync(resolve(tmpdir(), 'slicc-swift-forbidden-'));
    roots.push(root);
    for (const [rel, body] of Object.entries(layout)) {
      const abs = resolve(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return root;
  }

  const cleanYml = `targets:
  SliccWidgets:
    dependencies:
      - package: SliccWidgetKit
`;

  const widgetRule = {
    id: 'ios-widgets-no-webrtc',
    roots: ['packages/ios-app/SliccWidgets'],
    forbidden: WIDGET_FORBIDDEN_MODULES,
    reason: 'test',
    projectYml: { file: 'packages/ios-app/project.yml', target: 'SliccWidgets' },
  };

  it('reports a forbidden import found in the real file layout', () => {
    const root = scratch({
      'packages/ios-app/SliccWidgets/Bundle.swift': 'import WebRTC\n',
      'packages/ios-app/project.yml': cleanYml,
    });
    const { findings } = checkRepo(root, [widgetRule]);
    expect(findings.map((f) => f.code)).toEqual(['forbidden-import']);
    expect(findings[0].file).toBe('packages/ios-app/SliccWidgets/Bundle.swift');
  });

  it('reports a WebRTC xcodegen dependency even without an import', () => {
    const root = scratch({
      'packages/ios-app/SliccWidgets/Bundle.swift': 'import SliccWidgetKit\n',
      'packages/ios-app/project.yml': `targets:
  SliccWidgets:
    dependencies:
      - package: WebRTC
`,
    });
    const { findings } = checkRepo(root, [widgetRule]);
    expect(findings.map((f) => f.code)).toEqual(['forbidden-target-dependency']);
  });

  it('fails when a required public surface is missing', () => {
    const root = scratch({
      'packages/swift-widgetkit/Sources/SliccWidgetKit/Kit.swift': 'struct Hidden {}\n',
    });
    const { findings } = checkRepo(root, [
      {
        id: 'widgetkit-no-webrtc',
        roots: ['packages/swift-widgetkit/Sources/SliccWidgetKit'],
        forbidden: WIDGET_FORBIDDEN_MODULES,
        reason: 'test',
        requirePublicSurface: true,
      },
    ]);
    expect(findings.map((f) => f.code)).toEqual(['missing-public-surface']);
  });

  it('fails when a scan root is missing rather than skipping the rule', () => {
    const root = scratch({});
    const { findings } = checkRepo(root, [widgetRule]);
    expect(findings.map((f) => f.code).sort()).toEqual([
      'unresolved-scan-root',
      'unresolved-xcodegen-target',
    ]);
  });

  it('exits non-zero with a GitHub annotation when a finding exists', () => {
    const root = scratch({
      'packages/ios-app/SliccWidgets/Bundle.swift': 'import WebRTC\n',
      'packages/ios-app/project.yml': cleanYml,
    });
    const { status, stderr } = runCli(['--root', root]);
    expect(status).toBe(1);
    expect(stderr).toContain('::error file=packages/ios-app/SliccWidgets/Bundle.swift,line=1');
    expect(stderr).toContain('forbidden-import');
  });
});
