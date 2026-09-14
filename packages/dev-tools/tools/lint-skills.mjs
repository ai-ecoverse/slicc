#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

const strict = process.argv.includes('--strict') || process.env.CI === 'true';

const skillRoots = ['packages/vfs-root/workspace/skills', '.agents/skills'];

const isWin = process.platform === 'win32';
const tesslBin = resolve(repoRoot, 'node_modules', '.bin', isWin ? 'tessl.cmd' : 'tessl');
const tesslEnv = { ...process.env, TESSL_AUTO_UPDATE_INTERVAL_MINUTES: '0' };

function runTessl(args, cwd) {
  return spawnSync(tesslBin, args, {
    cwd,
    env: tesslEnv,
    encoding: 'utf8',
    shell: isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function discoverSkills() {
  const skills = [];
  for (const root of skillRoots) {
    const absRoot = resolve(repoRoot, root);
    if (!existsSync(absRoot)) continue;
    for (const entry of readdirSync(absRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(absRoot, entry.name);
      if (existsSync(join(dir, 'SKILL.md'))) {
        skills.push({ name: `${root}/${entry.name}`, dir });
      }
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function tesslResolvable() {
  if (!existsSync(tesslBin)) return false;
  const probe = runTessl(['--version']);
  return !probe.error && probe.status === 0;
}

function lintSkill(skill) {
  const tmp = mkdtempSync(join(tmpdir(), 'slicc-skill-'));
  try {
    cpSync(skill.dir, tmp, { recursive: true });
    const imported = runTessl(['skill', 'import', '--force', tmp], repoRoot);
    if (imported.status !== 0) {
      return { ok: false, log: (imported.stdout || '') + (imported.stderr || '') };
    }
    const linted = runTessl(['skill', 'lint', tmp], repoRoot);
    if (linted.status !== 0) {
      return { ok: false, log: (linted.stdout || '') + (linted.stderr || '') };
    }
    return { ok: true };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const skills = discoverSkills();
if (skills.length === 0) {
  process.stderr.write('lint-skills: no SKILL.md skills found\n');
  process.exit(1);
}

if (!tesslResolvable()) {
  const msg =
    'lint-skills: tessl could not be resolved via the npm path ' +
    '(node_modules/.bin/tessl). Run `npm ci` to install @tessl/cli.';
  if (strict) {
    process.stderr.write(`::error::${msg}\n`);
    process.exit(1);
  }
  process.stderr.write(`warning: ${msg} Skipping skill lint.\n`);
  process.exit(0);
}

const failures = [];
for (const skill of skills) {
  const result = lintSkill(skill);
  if (result.ok) {
    process.stdout.write(`ok: ${skill.name}\n`);
  } else {
    failures.push(skill.name);
    process.stderr.write(`::error::skill lint failed: ${skill.name}\n`);
    if (result.log) process.stderr.write(`${result.log.trim()}\n`);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `\nlint-skills: ${failures.length} of ${skills.length} skills failed: ${failures.join(', ')}\n`
  );
  process.exit(1);
}

process.stdout.write(`lint-skills: all ${skills.length} skills passed\n`);
