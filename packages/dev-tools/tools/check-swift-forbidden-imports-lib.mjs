// Pure analysis for the Swift/iOS forbidden-import gate.
//
// Swift layering leans on SPM modules (`swift-traykit`, `swift-widgetkit`,
// `swift-traysession`, `swift-optel`): the cross-module surface is `public`,
// not a TS-style directory stack. What the compiler still allows — and what
// WidgetKit's memory budget cannot — is a widget process importing WebRTC
// (or a tray-follower module that pulls it in). This module encodes those
// denylist rules and matches them against:
//
//   * `import` / `canImport` sites (via collectImportHits)
//   * xcodegen `project.yml` target `dependencies:` (SliccWidgets is not an
//     SPM target, so linking WebRTC without an import would otherwise pass)
//   * a `public`/`open` declaration on the widgetkit library (the deliberate
//     cross-module surface both widget hosts import)
//
// String-level on purpose: the gate runs in the Linux `lint` job, which has
// no Swift toolchain.

import {
  blankStringLiterals,
  collectImportHits,
  stripComments,
} from './check-swift-unused-deps-lib.mjs';

/**
 * Modules that pull WebRTC (or re-export the tray-follower that does) into
 * a widget process. Importing any of these is how a widget blows its memory
 * budget without writing `import WebRTC` itself.
 */
export const WIDGET_FORBIDDEN_MODULES = [
  'WebRTC',
  'SliccTrayFollower',
  'SliccTrayVFS',
  'SliccTrayKit',
];

const WIDGET_REASON =
  'WidgetKit extensions run in a short-lived process with a hard memory budget; ' +
  'they must not import WebRTC or the tray-follower modules that pull it in. ' +
  'Draw through SliccWidgetKit — its `public` API is the cross-module surface.';

const WIDGETKIT_REASON =
  'SliccWidgetKit is Foundation + SwiftUI + WidgetKit only. Both widget hosts ' +
  'import this module; its `public` types are the deliberate cross-module ' +
  'surface. WebRTC and tray-follower modules stay out.';

/**
 * Frozen denylist. Add a rule when a new widget host or SPM library needs
 * the same budget; do not grow a baseline of violations.
 *
 * @typedef {object} ForbiddenImportRule
 * @property {string} id
 * @property {string[]} roots repo-relative directories of `.swift` sources
 * @property {string[]} forbidden module / xcodegen package / target names
 * @property {string} reason
 * @property {{file: string, target: string}} [projectYml]
 * @property {boolean} [requirePublicSurface]
 */
export const FORBIDDEN_IMPORT_RULES = [
  {
    id: 'ios-widgets-no-webrtc',
    roots: ['packages/ios-app/SliccWidgets'],
    forbidden: WIDGET_FORBIDDEN_MODULES,
    reason: WIDGET_REASON,
    projectYml: {
      file: 'packages/ios-app/project.yml',
      target: 'SliccWidgets',
    },
  },
  {
    id: 'sliccstart-widgets-no-webrtc',
    roots: ['packages/swift-launcher/SliccstartWidgets'],
    forbidden: WIDGET_FORBIDDEN_MODULES,
    reason: WIDGET_REASON,
    projectYml: {
      file: 'packages/swift-launcher/project.yml',
      target: 'SliccstartWidgets',
    },
  },
  {
    id: 'widgetkit-no-webrtc',
    // The gallery executable is a design-time AppKit tool, not a widget
    // process — it is intentionally outside this root.
    roots: [
      'packages/swift-widgetkit/Sources/SliccWidgetKit',
      'packages/swift-widgetkit/Tests/SliccWidgetKitTests',
    ],
    forbidden: WIDGET_FORBIDDEN_MODULES,
    reason: WIDGETKIT_REASON,
    requirePublicSurface: true,
  },
];

const PUBLIC_DECL_RE = /^[ \t]*(?:@[\w]+(?:\([^)]*\))?[ \t]+)*(?:public|open)[ \t]+/m;

/** True when `source` declares a `public` or `open` API (comments blanked). */
export function hasPublicSurface(source) {
  return PUBLIC_DECL_RE.test(blankStringLiterals(stripComments(source)));
}

/**
 * Forbidden `import` / `canImport` sites in one Swift file under `rule`.
 *
 * @returns {{file: string, line: number, code: string, severity: 'error', ruleId: string, message: string}[]}
 */
export function analyzeSource({ relPath, source, rule }) {
  const forbidden = new Set(rule.forbidden);
  const findings = [];
  for (const hit of collectImportHits(source)) {
    if (!forbidden.has(hit.module)) continue;
    findings.push({
      file: relPath,
      line: hit.line,
      code: 'forbidden-import',
      severity: 'error',
      ruleId: rule.id,
      message:
        `${relPath} imports '${hit.module}' (${hit.kind}) — forbidden by rule ` +
        `'${rule.id}': ${rule.reason}`,
    });
  }
  return findings;
}

/**
 * `dependencies:` entries of a named xcodegen target. Returns `null` when
 * the target is missing, or `{ kind, name, line }[]` for `package:` /
 * `target:` / `product:` keys (sdk entries are ignored).
 */
export function xcodegenTargetDependencies(yml, targetName) {
  const lines = yml.split('\n');
  const header = `  ${targetName}:`;
  const start = lines.indexOf(header);
  if (start === -1) return null;

  const block = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^ {2}\S/.test(line) || (/^\S/.test(line) && line.trim() !== '')) break;
    block.push({ line, number: i + 1 });
  }

  const depIdx = block.findIndex(({ line }) => /^ {4}dependencies:\s*$/.test(line));
  if (depIdx === -1) return [];

  const deps = [];
  for (let i = depIdx + 1; i < block.length; i++) {
    const { line, number } = block[i];
    if (line.trim() === '') continue;
    if (!/^ {6}/.test(line)) break;
    const pkg = /(?:^|[-\s])package:\s*(\S+)/.exec(line);
    const tgt = /(?:^|[-\s])target:\s*(\S+)/.exec(line);
    const product = /(?:^|[-\s])product:\s*(\S+)/.exec(line);
    if (pkg) deps.push({ kind: 'package', name: pkg[1], line: number });
    if (tgt) deps.push({ kind: 'target', name: tgt[1], line: number });
    if (product) deps.push({ kind: 'product', name: product[1], line: number });
  }
  return deps;
}

/**
 * Forbidden xcodegen package/target/product links on `rule.projectYml.target`.
 */
export function analyzeXcodegenTarget({ relPath, yml, rule }) {
  const target = rule.projectYml?.target;
  if (!target) return [];
  const deps = xcodegenTargetDependencies(yml, target);
  if (deps === null) {
    return [
      {
        file: relPath,
        line: 1,
        code: 'unresolved-xcodegen-target',
        severity: 'error',
        ruleId: rule.id,
        message:
          `rule '${rule.id}' names xcodegen target '${target}' which is missing ` +
          `from ${relPath}`,
      },
    ];
  }
  const forbidden = new Set(rule.forbidden);
  const findings = [];
  for (const dep of deps) {
    if (!forbidden.has(dep.name)) continue;
    findings.push({
      file: relPath,
      line: dep.line,
      code: 'forbidden-target-dependency',
      severity: 'error',
      ruleId: rule.id,
      message:
        `xcodegen target '${target}' declares ${dep.kind} '${dep.name}' — ` +
        `forbidden by rule '${rule.id}': ${rule.reason}`,
    });
  }
  return findings;
}

/**
 * Help text listing every rule. Printed by `--help` so the dispatcher
 * answers without scanning the tree.
 */
export function formatHelp(rules = FORBIDDEN_IMPORT_RULES) {
  const lines = [
    'Swift/iOS forbidden-import gate.',
    '',
    'Usage:',
    '  node packages/dev-tools/tools/check-swift-forbidden-imports.mjs [--root <dir>] [--help]',
    '',
    'Fails when a widget (or SliccWidgetKit) imports WebRTC or a tray-follower',
    'module that pulls it in, or when an xcodegen widget target links one.',
    'The Swift layer stack is the SPM modules; cross-module API is `public`.',
    '',
    'Rules:',
  ];
  for (const rule of rules) {
    lines.push(`  ${rule.id}`);
    lines.push(`    roots: ${rule.roots.join(', ')}`);
    if (rule.projectYml) {
      lines.push(`    xcodegen: ${rule.projectYml.file} target ${rule.projectYml.target}`);
    }
    if (rule.requirePublicSurface) {
      lines.push('    requires: public/open declarations in the scanned sources');
    }
    lines.push(`    forbidden: ${rule.forbidden.join(', ')}`);
    lines.push(`    ${rule.reason}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
