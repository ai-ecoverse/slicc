#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectImportSites, moduleName } from './check-swift-unused-deps-lib.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');

const SKIP_DIRS = new Set(['.build', '.swiftpm', 'node_modules', 'dist', 'DerivedData']);

export const FORBIDDEN_IMPORT_RULES = [
  {
    id: 'widget-no-webrtc',
    roots: [
      'packages/ios-app/SliccWidgets',
      'packages/swift-launcher/SliccstartWidgets',
      'packages/swift-widgetkit/Sources/SliccWidgetKit',
    ],
    modules: ['WebRTC'],
    reason:
      'WidgetKit extensions have a tight memory budget; WebRTC belongs in the host app, not the widget surface',
  },
];

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

function swiftFilesAt(absRoot) {
  if (!existsSync(absRoot)) return null;
  const stat = statSync(absRoot);
  if (stat.isFile()) return absRoot.endsWith('.swift') ? [absRoot] : [];
  return listSwiftFiles(absRoot);
}

export function checkForbiddenImports(root = repoRoot, rules = FORBIDDEN_IMPORT_RULES) {
  const findings = [];
  let scannedFiles = 0;
  const scannedRoots = [];

  for (const rule of rules) {
    const banned = new Set(rule.modules.map(moduleName));
    for (const relRoot of rule.roots) {
      const absRoot = resolve(root, relRoot);
      const files = swiftFilesAt(absRoot);
      if (files === null) {
        findings.push({
          file: relRoot,
          severity: 'error',
          code: 'forbidden-import-root-missing',
          line: 1,
          message:
            `rule '${rule.id}' source root '${relRoot}' does not exist — ` +
            'the forbidden-import gate cannot verify it',
        });
        continue;
      }
      if (files.length === 0) {
        findings.push({
          file: relRoot,
          severity: 'error',
          code: 'forbidden-import-root-empty',
          line: 1,
          message:
            `rule '${rule.id}' source root '${relRoot}' contains no Swift files — ` +
            'the forbidden-import gate cannot verify it',
        });
        continue;
      }
      scannedRoots.push(relRoot);
      for (const abs of files) {
        scannedFiles += 1;
        const rel = relative(root, abs);
        for (const site of collectImportSites(readFileSync(abs, 'utf8'))) {
          if (!banned.has(moduleName(site.module))) continue;
          findings.push({
            file: rel,
            severity: 'error',
            code: 'forbidden-import',
            line: site.line,
            message: `rule '${rule.id}': '${site.module}' is forbidden under '${relRoot}' — ${rule.reason}`,
          });
        }
      }
    }
  }

  findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code)
  );
  return { findings, scannedFiles, scannedRoots };
}

function main() {
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag === -1 ? repoRoot : resolve(argv[rootFlag + 1] ?? '');
  let result;
  try {
    result = checkForbiddenImports(root);
  } catch (err) {
    stderr.write(`::error::check-swift-forbidden-imports failed: ${err.message}\n`);
    exit(2);
  }
  const { findings, scannedFiles, scannedRoots } = result;

  if (findings.length > 0) {
    for (const f of findings) {
      stderr.write(`::error file=${f.file},line=${f.line}::${f.code}: ${f.message}\n`);
    }
    stderr.write(`\n${findings.length} Swift forbidden-import issue(s).\n`);
    exit(1);
  }

  stdout.write(
    `ok: no forbidden Swift imports in ${scannedFiles} files across ${scannedRoots.length} roots\n`
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();
