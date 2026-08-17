import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkRepo, findManifests, targetSourceRoots } from './check-swift-unused-deps.mjs';
import {
  analyzeManifest,
  blankStringLiterals,
  collectImports,
  matchBracket,
  moduleName,
  packageIdentity,
  packageModuleIndex,
  parseManifest,
  stripComments,
} from './check-swift-unused-deps-lib.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-swift-unused-deps.mjs');

const MANIFEST = `// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Demo",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "DemoKit", targets: ["DemoKit", "DemoSupport"])
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-log", from: "1.15.0"),
        .package(url: "https://github.com/stasel/WebRTC.git", .upToNextMajor(from: "150.0.0")),
        .package(path: "../swift-optel"),
    ],
    targets: [
        .executableTarget(
            name: "demo-tool",
            dependencies: [
                .product(name: "Logging", package: "swift-log"),
                .product(name: "SwiftOptel", package: "swift-optel"),
                "WebRTC",
            ],
            path: "Sources"
        ),
        .testTarget(
            name: "demo-toolTests",
            dependencies: ["demo-tool"],
            path: "Tests"
        ),
    ]
)
`;

function parsed() {
  return parseManifest(MANIFEST);
}

/** `swift-optel` as a local dependency: one product, one module. */
const LOCAL_PACKAGES = new Map([
  [
    'swift-optel',
    {
      products: new Map([['SwiftOptel', new Set(['SwiftOptel'])]]),
      modules: new Set(['SwiftOptel']),
    },
  ],
]);

/** Analyse MANIFEST with a caller-supplied import map. */
function analyze(importsByTarget, manifest = parsed(), localPackages = LOCAL_PACKAGES) {
  return analyzeManifest({
    manifest,
    importsByTarget: new Map(Object.entries(importsByTarget).map(([k, v]) => [k, new Set(v)])),
    localPackages,
  });
}

const CLEAN_IMPORTS = {
  'demo-tool': ['Foundation', 'Logging', 'SwiftOptel', 'WebRTC'],
  'demo-toolTests': ['XCTest', 'demo_tool'],
};

describe('stripComments', () => {
  it('blanks line comments but keeps offsets and newlines', () => {
    const stripped = stripComments('let a = 1 // note\nlet b = 2\n');
    expect(stripped).toHaveLength('let a = 1 // note\nlet b = 2\n'.length);
    expect(stripped).toContain('let a = 1');
    expect(stripped).not.toContain('note');
    expect(stripped.split('\n')).toHaveLength(3);
  });

  it('blanks nested block comments without swallowing the code after them', () => {
    const stripped = stripComments('a /* x /* y */ z */ b');
    expect(stripped.replace(/\s+/g, ' ')).toBe('a b');
  });

  it('preserves string literals that look like comments', () => {
    expect(stripComments('let u = "https://x.dev/a" // trailing')).toContain('"https://x.dev/a"');
  });
});

describe('matchBracket', () => {
  it('skips brackets inside string literals', () => {
    const text = '(url: "a)b", x: 1)';
    expect(matchBracket(text, 0)).toBe(text.length - 1);
  });

  it('returns -1 for an unbalanced group', () => {
    expect(matchBracket('(a, b', 0)).toBe(-1);
  });
});

describe('packageIdentity / moduleName', () => {
  it('derives identity from a git URL', () => {
    expect(packageIdentity({ url: 'https://github.com/stasel/WebRTC.git' })).toBe('WebRTC');
  });

  it('derives identity from a local path', () => {
    expect(packageIdentity({ path: '../swift-traysession' })).toBe('swift-traysession');
  });

  it('prefers an explicit name', () => {
    expect(packageIdentity({ url: 'https://x.dev/a.git', name: 'Aliased' })).toBe('Aliased');
  });

  it('maps illegal identifier characters to underscores', () => {
    expect(moduleName('slicc-server')).toBe('slicc_server');
    expect(moduleName('SwiftOptel')).toBe('SwiftOptel');
  });
});

describe('parseManifest', () => {
  it('reads the package name, products and dependencies', () => {
    const manifest = parsed();
    expect(manifest.packageName).toBe('Demo');
    expect(manifest.dependencies.map((d) => d.identity)).toEqual([
      'swift-log',
      'WebRTC',
      'swift-optel',
    ]);
    expect(manifest.dependencies[2]).toMatchObject({ kind: 'path', path: '../swift-optel' });
  });

  it('reads targets with their kind, path and dependency forms', () => {
    const [tool, tests] = parsed().targets;
    expect(tool).toMatchObject({ name: 'demo-tool', kind: 'executableTarget', path: 'Sources' });
    expect(tool.dependencies).toEqual([
      expect.objectContaining({ module: 'Logging', package: 'swift-log', form: 'product' }),
      expect.objectContaining({ module: 'SwiftOptel', package: 'swift-optel' }),
      expect.objectContaining({ module: 'WebRTC', package: null, form: 'byName' }),
    ]);
    expect(tests).toMatchObject({ name: 'demo-toolTests', isTest: true });
  });

  it('does not mistake a nested .product name for the target name', () => {
    expect(parsed().targets.map((t) => t.name)).toEqual(['demo-tool', 'demo-toolTests']);
  });

  it('records line numbers pointing at the declaration', () => {
    const manifest = parsed();
    const lines = MANIFEST.split('\n');
    expect(lines[manifest.dependencies[0].line - 1]).toContain('swift-log');
    const logging = manifest.targets[0].dependencies[0];
    expect(lines[logging.line - 1]).toContain('Logging');
  });

  it('parses exclude and sources lists', () => {
    const manifest = parseManifest(`
let package = Package(
    name: "X",
    targets: [
        .target(name: "X", path: "X", exclude: ["Legacy", "X.entitlements"], sources: ["Core"])
    ]
)
`);
    expect(manifest.targets[0].exclude).toEqual(['Legacy', 'X.entitlements']);
    expect(manifest.targets[0].sources).toEqual(['Core']);
  });

  it('throws on a manifest without a Package clause', () => {
    expect(() => parseManifest('import PackageDescription\n')).toThrow(/no `let package/);
  });
});

describe('collectImports', () => {
  it('collects plain, attributed, testable and scoped imports', () => {
    const modules = collectImports(
      [
        'import Foundation',
        '@_exported import SliccTrayFollower',
        '@preconcurrency import WebRTC',
        '@testable import slicc_server',
        'import struct Hummingbird.Request',
        'import os.log',
      ].join('\n')
    );
    expect(modules).toEqual(
      new Set(['Foundation', 'SliccTrayFollower', 'WebRTC', 'slicc_server', 'Hummingbird', 'os'])
    );
  });

  it('counts modules named in a canImport check', () => {
    expect(collectImports('#if canImport(AppKit)\n#endif\n')).toEqual(new Set(['AppKit']));
  });

  it('ignores commented-out imports and unrelated text', () => {
    expect(collectImports('// import Logging\nlet importer = 1\n')).toEqual(new Set());
  });

  it('ignores an import inside a multiline string fixture', () => {
    const source = [
      'import Foundation',
      'let generated = """',
      'import Logging',
      'let x = 1',
      '"""',
    ].join('\n');
    expect(collectImports(source)).toEqual(new Set(['Foundation']));
  });

  it('ignores an import inside a single-line string literal', () => {
    expect(collectImports('let snippet = "import Logging"\n')).toEqual(new Set());
  });
});

describe('blankStringLiterals', () => {
  it('blanks the literal but keeps length and line boundaries', () => {
    const source = 'let a = """\nimport Logging\n"""\nimport Foundation\n';
    const blanked = blankStringLiterals(source);
    expect(blanked).toHaveLength(source.length);
    expect(blanked.split('\n')).toHaveLength(source.split('\n').length);
    expect(blanked).not.toContain('import Logging');
    expect(blanked).toContain('import Foundation');
  });

  it('leaves code outside literals untouched', () => {
    expect(blankStringLiterals('let n = 1 + 2').trim()).toBe('let n = 1 + 2');
  });
});

describe('packageModuleIndex', () => {
  it('maps each product to the modules it alone vends', () => {
    const manifest = parseManifest(`
let package = Package(
    name: "Multi",
    products: [
        .library(name: "Foo", targets: ["FooCore"]),
        .library(name: "Bar", targets: ["BarCore"]),
    ],
    targets: [
        .target(name: "FooCore", path: "Sources/FooCore"),
        .target(name: "BarCore", path: "Sources/BarCore"),
    ]
)
`);
    const index = packageModuleIndex(manifest);
    expect(index.products.get('Foo')).toEqual(new Set(['FooCore']));
    expect(index.products.get('Bar')).toEqual(new Set(['BarCore']));
    expect(index.modules).toEqual(new Set(['Foo', 'FooCore', 'Bar', 'BarCore']));
  });

  it('falls back to the product name when a product lists no targets', () => {
    const manifest = parseManifest(`
let package = Package(
    name: "Solo",
    products: [.library(name: "Solo", targets: [])],
    targets: [.target(name: "Solo", path: "Sources/Solo")]
)
`);
    expect(packageModuleIndex(manifest).products.get('Solo')).toEqual(new Set(['Solo']));
  });
});

describe('analyzeManifest', () => {
  it('reports nothing when every dependency is imported', () => {
    expect(analyze(CLEAN_IMPORTS)).toEqual([]);
  });

  it('flags a target dependency no source imports', () => {
    const findings = analyze({
      ...CLEAN_IMPORTS,
      'demo-tool': ['Foundation', 'SwiftOptel', 'WebRTC'],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'unused-target-dependency' });
    expect(findings[0].message).toContain("'Logging'");
  });

  it('flags a package dependency no target consumes', () => {
    const manifest = parsed();
    manifest.targets[0].dependencies = manifest.targets[0].dependencies.filter(
      (d) => d.module !== 'WebRTC'
    );
    const findings = analyze(
      { ...CLEAN_IMPORTS, 'demo-tool': ['Foundation', 'Logging', 'SwiftOptel'] },
      manifest
    );
    expect(findings.map((f) => f.code)).toContain('unused-package-dependency');
    expect(findings.find((f) => f.code === 'unused-package-dependency').message).toContain(
      'WebRTC'
    );
  });

  it('accepts a bare string dependency as consuming its package', () => {
    // `"WebRTC"` (no `.product(package:)`) still consumes the WebRTC package.
    expect(analyze(CLEAN_IMPORTS).map((f) => f.code)).not.toContain('unused-package-dependency');
  });

  it('flags a module reachable only transitively', () => {
    const findings = analyze({
      ...CLEAN_IMPORTS,
      'demo-toolTests': ['XCTest', 'demo_tool', 'SwiftOptel'],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'unlisted-dependency' });
    expect(findings[0].message).toContain("target 'demo-toolTests' imports 'SwiftOptel'");
  });

  it('does not flag system or unresolvable modules as unlisted', () => {
    expect(
      analyze({ ...CLEAN_IMPORTS, 'demo-toolTests': ['XCTest', 'demo_tool', 'Version'] })
    ).toEqual([]);
  });

  it('matches a hyphenated target name against its underscored module', () => {
    expect(analyze(CLEAN_IMPORTS).map((f) => f.code)).not.toContain('unused-target-dependency');
  });

  it('honours an unused-dep-ok waiver on the dependency line', () => {
    const waived = MANIFEST.replace(
      '.product(name: "Logging", package: "swift-log"),',
      '.product(name: "Logging", package: "swift-log"),  // unused-dep-ok: linked for its plugin'
    );
    const findings = analyze(
      { ...CLEAN_IMPORTS, 'demo-tool': ['Foundation', 'SwiftOptel', 'WebRTC'] },
      parseManifest(waived)
    );
    expect(findings).toEqual([]);
  });

  it('honours a waiver on the line above a multi-line dependency', () => {
    const waived = MANIFEST.replace(
      '        .package(url: "https://github.com/apple/swift-log", from: "1.15.0"),',
      [
        '        // unused-dep-ok: kept for the vendored patch set',
        '        .package(',
        '            url: "https://github.com/apple/swift-log", from: "1.15.0"),',
      ].join('\n')
    );
    const manifest = parseManifest(waived);
    manifest.targets[0].dependencies = manifest.targets[0].dependencies.filter(
      (d) => d.package !== 'swift-log'
    );
    const findings = analyze(
      { ...CLEAN_IMPORTS, 'demo-tool': ['Foundation', 'SwiftOptel', 'WebRTC'] },
      manifest
    );
    expect(findings).toEqual([]);
  });

  it('skips platform-conditional dependencies', () => {
    const conditional = MANIFEST.replace(
      '.product(name: "Logging", package: "swift-log"),',
      '.product(name: "Logging", package: "swift-log", condition: .when(platforms: [.linux])),'
    );
    const findings = analyze(
      { ...CLEAN_IMPORTS, 'demo-tool': ['Foundation', 'SwiftOptel', 'WebRTC'] },
      parseManifest(conditional)
    );
    expect(findings).toEqual([]);
  });

  it('skips targets that carry no Swift sources', () => {
    const manifest = parseManifest(`
let package = Package(
    name: "X",
    targets: [
        .binaryTarget(name: "Prebuilt", path: "Prebuilt.xcframework")
    ]
)
`);
    expect(analyzeManifest({ manifest, importsByTarget: new Map() })).toEqual([]);
  });
});

describe('analyzeManifest: multi-product local dependencies', () => {
  const MULTI = `
let package = Package(
    name: "Consumer",
    dependencies: [
        .package(path: "../multi")
    ],
    targets: [
        .target(
            name: "Consumer",
            dependencies: [.product(name: "Foo", package: "multi")],
            path: "Sources/Consumer"
        )
    ]
)
`;
  // One local package, two products, each vending its own module.
  const MULTI_LOCAL = new Map([
    [
      'multi',
      {
        products: new Map([
          ['Foo', new Set(['FooCore'])],
          ['Bar', new Set(['BarCore'])],
        ]),
        modules: new Set(['Foo', 'FooCore', 'Bar', 'BarCore']),
      },
    ],
  ]);

  /** Analyse MULTI with `Consumer` importing `modules`. */
  function analyzeMulti(modules) {
    return analyzeManifest({
      manifest: parseManifest(MULTI),
      importsByTarget: new Map([['Consumer', new Set(modules)]]),
      localPackages: MULTI_LOCAL,
    });
  }

  it('accepts the module vended by the declared product', () => {
    expect(analyzeMulti(['Foundation', 'FooCore'])).toEqual([]);
  });

  it('does not credit a sibling product of the same package', () => {
    const findings = analyzeMulti(['Foundation', 'BarCore']);
    expect(findings.map((f) => f.code).sort()).toEqual([
      'unlisted-dependency',
      'unused-target-dependency',
    ]);
    expect(findings.find((f) => f.code === 'unused-target-dependency').message).toContain("'Foo'");
    expect(findings.find((f) => f.code === 'unlisted-dependency').message).toContain("'BarCore'");
  });
});

describe('source-root resolution', () => {
  it('uses the explicit path when the manifest sets one', () => {
    expect(targetSourceRoots('/pkg', { name: 'T', path: 'Sources/T' })).toEqual(['/pkg/Sources/T']);
  });

  it('resolves the conventional per-target directory', () => {
    const pkgDir = resolve(repoRoot, 'packages/swift-optel');
    expect(targetSourceRoots(pkgDir, { name: 'SwiftOptel', path: null, isTest: false })).toEqual([
      resolve(pkgDir, 'Sources/SwiftOptel'),
    ]);
  });

  it('returns a single root, never a union with the enclosing Sources dir', () => {
    const pkgDir = resolve(repoRoot, 'packages/swift-optel');
    const roots = targetSourceRoots(pkgDir, { name: 'SwiftOptel', path: null, isTest: false });
    expect(roots).toHaveLength(1);
    expect(roots).not.toContain(resolve(pkgDir, 'Sources'));
  });

  it('returns nothing when no conventional root exists', () => {
    expect(
      targetSourceRoots('/nonexistent/slicc-swift-deps-pkg', {
        name: 'Absent',
        path: null,
        isTest: false,
      })
    ).toEqual([]);
  });
});

describe('end-to-end against the repo', () => {
  it('discovers every Swift package manifest', () => {
    const names = findManifests(repoRoot).map((p) => p.split('/').at(-2));
    expect(names).toEqual(
      expect.arrayContaining([
        'ios-app',
        'swift-launcher',
        'swift-optel',
        'swift-server',
        'swift-traysession',
        'swift-trayfollower',
      ])
    );
  });

  it('passes for the checked-in manifests', () => {
    const out = execFileSync('node', [scriptPath], { encoding: 'utf8' });
    expect(out).toMatch(/^ok: \d+ SPM package dependencies across \d+ manifests/);
  });
});

describe('checkRepo against a scratch tree', () => {
  const roots = [];

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  /** Lay out `packages/<pkg>/` with a manifest and Swift sources. */
  function scratchRepo(manifest, sources) {
    const root = mkdtempSync(resolve(tmpdir(), 'slicc-swift-deps-'));
    roots.push(root);
    const pkgDir = resolve(root, 'packages/demo');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(resolve(pkgDir, 'Package.swift'), manifest);
    for (const [rel, body] of Object.entries(sources)) {
      const abs = resolve(pkgDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return root;
  }

  const SCRATCH_MANIFEST = `// swift-tools-version: 5.10
let package = Package(
    name: "Demo",
    dependencies: [
        .package(url: "https://github.com/apple/swift-log", from: "1.15.0")
    ],
    targets: [
        .target(
            name: "DemoKit",
            dependencies: [.product(name: "Logging", package: "swift-log")],
            path: "Sources/DemoKit"
        )
    ]
)
`;

  it('reports an unused dependency found in the real file layout', () => {
    const root = scratchRepo(SCRATCH_MANIFEST, {
      'Sources/DemoKit/Kit.swift': 'import Foundation\nlet answer = 42\n',
    });
    const { findings } = checkRepo(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'unused-target-dependency',
      file: 'packages/demo/Package.swift',
    });
  });

  it('reports nothing once the module is imported', () => {
    const root = scratchRepo(SCRATCH_MANIFEST, {
      'Sources/DemoKit/Kit.swift': 'import Foundation\nimport Logging\n',
    });
    const { findings, packages } = checkRepo(root);
    expect(findings).toEqual([]);
    expect(packages).toEqual([
      expect.objectContaining({ name: 'Demo', targets: 1, dependencies: 1, scannedFiles: 1 }),
    ]);
  });

  it('flags a target whose sources cannot be resolved instead of passing it', () => {
    const root = scratchRepo(SCRATCH_MANIFEST, { 'Sources/Other/Kit.swift': 'import Logging\n' });
    const { findings } = checkRepo(root);
    expect(findings.map((f) => f.code)).toEqual(['unresolved-target-sources']);
  });

  it('excludes the paths listed in `exclude:` from the import scan', () => {
    const manifest = SCRATCH_MANIFEST.replace(
      'path: "Sources/DemoKit"',
      'path: "Sources/DemoKit",\n            exclude: ["Vendored"]'
    );
    const root = scratchRepo(manifest, {
      'Sources/DemoKit/Kit.swift': 'import Foundation\n',
      'Sources/DemoKit/Vendored/Vendored.swift': 'import Logging\n',
    });
    const { findings } = checkRepo(root);
    expect(findings.map((f) => f.code)).toEqual(['unused-target-dependency']);
  });

  it('exits non-zero with a GitHub annotation when a finding exists', () => {
    const root = scratchRepo(SCRATCH_MANIFEST, {
      'Sources/DemoKit/Kit.swift': 'import Foundation\n',
    });
    const { status, stderr } = runCli(root);
    expect(status).toBe(1);
    expect(stderr).toContain('::error file=packages/demo/Package.swift,line=');
    expect(stderr).toContain('unused-target-dependency');
  });

  // Conventional layout (no `path:`), two targets: a sibling's import must not
  // satisfy this target's dependency.
  const CONVENTIONAL_MANIFEST = `// swift-tools-version: 5.10
let package = Package(
    name: "Demo",
    dependencies: [
        .package(url: "https://github.com/apple/swift-log", from: "1.15.0")
    ],
    targets: [
        .target(name: "Quiet", dependencies: [.product(name: "Logging", package: "swift-log")]),
        .target(name: "Loud", dependencies: [.product(name: "Logging", package: "swift-log")]),
    ]
)
`;

  it('does not credit a sibling target’s import under the conventional layout', () => {
    const root = scratchRepo(CONVENTIONAL_MANIFEST, {
      'Sources/Quiet/Quiet.swift': 'import Foundation\n',
      'Sources/Loud/Loud.swift': 'import Logging\n',
    });
    const { findings } = checkRepo(root);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('unused-target-dependency');
    expect(findings[0].message).toContain("target 'Quiet'");
  });

  it('does not let a string-literal import mask an unused dependency', () => {
    const root = scratchRepo(SCRATCH_MANIFEST, {
      'Sources/DemoKit/Kit.swift': 'import Foundation\nlet fixture = """\nimport Logging\n"""\n',
    });
    const { findings } = checkRepo(root);
    expect(findings.map((f) => f.code)).toEqual(['unused-target-dependency']);
  });
});

/** Run the gate as CI does, with `--root` pointed at a scratch tree. */
function runCli(root) {
  try {
    return { status: 0, stderr: '', stdout: execFileSync('node', [scriptPath, '--root', root]) };
  } catch (err) {
    return { status: err.status, stderr: String(err.stderr), stdout: String(err.stdout) };
  }
}
