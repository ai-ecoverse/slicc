#!/usr/bin/env node
// Forbidden-import gate for Swift/iOS widget targets.
//
// Companion to `check-swift-unused-deps.mjs` (declared vs imported) and the
// webapp layer-back-edge ratchet (TS directory stack). Swift leans on SPM
// modules; this gate is the remaining fitness function: a widget process
// must not import WebRTC. Wired as `npm run lint:swift-forbidden-imports`
// into `lint` / `lint:ci`. No Swift toolchain required.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  analyzeSource,
  analyzeXcodegenTarget,
  FORBIDDEN_IMPORT_RULES,
  formatHelp,
  hasPublicSurface,
} from './check-swift-forbidden-imports-lib.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');

const SKIP_DIRS = new Set(['.build', '.swiftpm', 'node_modules', 'dist', 'DerivedData']);

function listSwiftFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...listSwiftFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith('.swift')) {
      out.push(abs);
    }
  }
  return out;
}

function missingRootFinding(rule, relRoot) {
  return {
    file: relRoot,
    line: 1,
    code: 'unresolved-scan-root',
    severity: 'error',
    ruleId: rule.id,
    message: `rule '${rule.id}' scan root '${relRoot}' does not exist`,
  };
}

/** Walk one rule's source roots. */
function scanRuleSources(root, rule) {
  const findings = [];
  let ruleFiles = 0;
  let sawPublic = false;
  const missingRoots = [];
  for (const relRoot of rule.roots) {
    const abs = resolve(root, relRoot);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      missingRoots.push(relRoot);
      findings.push(missingRootFinding(rule, relRoot));
      continue;
    }
    for (const file of listSwiftFiles(abs)) {
      const relPath = relative(root, file);
      const source = readFileSync(file, 'utf8');
      ruleFiles++;
      if (rule.requirePublicSurface && hasPublicSurface(source)) sawPublic = true;
      findings.push(...analyzeSource({ relPath, source, rule }));
    }
  }
  return { findings, ruleFiles, sawPublic, missingRoots };
}

function publicSurfaceFinding(rule) {
  return {
    file: rule.roots[0],
    line: 1,
    code: 'missing-public-surface',
    severity: 'error',
    ruleId: rule.id,
    message:
      `rule '${rule.id}' requires a \`public\`/\`open\` declaration in ` +
      `${rule.roots.join(', ')} — that is the cross-module surface other ` +
      'packages import. Mark the API `public` deliberately, or drop the rule.',
  };
}

function emptyRootFinding(rule) {
  return {
    file: rule.roots[0],
    line: 1,
    code: 'empty-scan-root',
    severity: 'error',
    ruleId: rule.id,
    message:
      `rule '${rule.id}' resolved to no Swift sources under ` +
      `${rule.roots.join(', ')} — the gate cannot enforce it`,
  };
}

function xcodegenFindings(root, rule) {
  if (!rule.projectYml) return [];
  const ymlRel = rule.projectYml.file;
  const ymlAbs = resolve(root, ymlRel);
  if (!existsSync(ymlAbs)) {
    return [
      {
        file: ymlRel,
        line: 1,
        code: 'unresolved-xcodegen-target',
        severity: 'error',
        ruleId: rule.id,
        message: `rule '${rule.id}' names '${ymlRel}' which is missing`,
      },
    ];
  }
  return analyzeXcodegenTarget({
    relPath: ymlRel,
    yml: readFileSync(ymlAbs, 'utf8'),
    rule,
  });
}

/**
 * Scan `root` against `rules`. Findings carry a repo-relative `file`.
 *
 * @param {string} [root]
 * @param {typeof FORBIDDEN_IMPORT_RULES} [rules]
 */
export function checkRepo(root = repoRoot, rules = FORBIDDEN_IMPORT_RULES) {
  const findings = [];
  let scannedFiles = 0;

  for (const rule of rules) {
    const scanned = scanRuleSources(root, rule);
    scannedFiles += scanned.ruleFiles;
    findings.push(...scanned.findings);
    if (
      rule.requirePublicSurface &&
      scanned.missingRoots.length === 0 &&
      scanned.ruleFiles > 0 &&
      !scanned.sawPublic
    ) {
      findings.push(publicSurfaceFinding(rule));
    }
    if (scanned.ruleFiles === 0 && scanned.missingRoots.length === 0 && rule.roots.length > 0) {
      findings.push(emptyRootFinding(rule));
    }
    findings.push(...xcodegenFindings(root, rule));
  }

  findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code)
  );
  return { findings, scannedFiles, ruleCount: rules.length };
}

function wantsHelp(args) {
  return args.includes('--help') || args.includes('-h');
}

function main() {
  if (wantsHelp(argv.slice(2))) {
    stdout.write(formatHelp());
    return;
  }

  const rootFlag = argv.indexOf('--root');
  const root = rootFlag === -1 ? repoRoot : resolve(argv[rootFlag + 1] ?? '');
  let result;
  try {
    result = checkRepo(root);
  } catch (err) {
    stderr.write(`::error::check-swift-forbidden-imports failed: ${err.message}\n`);
    exit(2);
  }
  const { findings, scannedFiles, ruleCount } = result;

  if (findings.length > 0) {
    for (const f of findings) {
      stderr.write(`::error file=${f.file},line=${f.line}::${f.code}: ${f.message}\n`);
    }
    stderr.write(
      `\n${findings.length} Swift forbidden-import issue(s) across ${ruleCount} rule(s).\n`
    );
    exit(1);
  }

  stdout.write(
    `ok: ${ruleCount} forbidden-import rule(s) clean (${scannedFiles} Swift files scanned)\n`
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();
