import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parsePackageResolvedPins, parsePackageSwiftPins, parseProjectYmlPins } from './lib.mjs';

const SKIP_DIRS = new Set(['node_modules', '.build', 'dist', '.git']);

/** Recursively list pin files under `root` (`project.yml` / `Package.swift` / `Package.resolved`). */
export function collectPinFiles(root) {
  const out = [];
  walk(root, out);
  return out.sort();
}

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.name !== '.') continue;
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(join(dir, ent.name), acc);
      continue;
    }
    if (
      ent.name === 'project.yml' ||
      ent.name === 'Package.swift' ||
      ent.name === 'Package.resolved'
    ) {
      acc.push(join(dir, ent.name));
    }
  }
}

export function readPinFiles(root) {
  const files = collectPinFiles(join(root, 'packages'));
  const contents = {};
  const projectPins = [];
  const swiftPins = [];
  const resolvedPins = [];
  for (const abs of files) {
    const path = relative(root, abs);
    const text = readFileSync(abs, 'utf8');
    contents[path] = text;
    if (abs.endsWith('project.yml')) projectPins.push(...parseProjectYmlPins(text, path));
    else if (abs.endsWith('Package.swift')) swiftPins.push(...parsePackageSwiftPins(text, path));
    else resolvedPins.push(...parsePackageResolvedPins(text, path));
  }
  return { contents, projectPins, swiftPins, resolvedPins };
}
