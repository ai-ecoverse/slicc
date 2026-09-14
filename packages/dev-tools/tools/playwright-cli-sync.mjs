#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const jsonFlag = process.argv.includes('--json');

function findHelpJson() {
  const override = process.argv.find((a) => a.startsWith('--help-json='));
  if (override) return override.slice('--help-json='.length);

  const req = createRequire(import.meta.url);
  try {
    const pkgJson = req.resolve('playwright-core/package.json');
    const candidate = resolve(dirname(pkgJson), 'lib/tools/cli-client/help.json');
    if (existsSync(candidate)) return candidate;
  } catch {}

  try {
    const which = execSync('which playwright-cli 2>/dev/null', { encoding: 'utf8' }).trim();
    if (which) {
      const real = realpathSync(which);

      const cliPkgDir = resolve(real, '..');
      const candidate = resolve(
        cliPkgDir,
        'node_modules/playwright-core/lib/tools/cli-client/help.json'
      );
      if (existsSync(candidate)) return candidate;
    }
  } catch {}

  return null;
}

const helpJsonPath = findHelpJson();
if (!helpJsonPath) {
  console.error(
    'playwright-core help.json not found.\n' +
      'Options:\n' +
      '  1. Install @playwright/cli globally: npm install -g @playwright/cli\n' +
      '  2. Pass path explicitly: --help-json=<path>\n' +
      '     e.g. <nvm>/lib/node_modules/@playwright/cli/node_modules/playwright-core/lib/tools/cli-client/help.json'
  );
  process.exit(1);
}

const officialSchema = JSON.parse(readFileSync(helpJsonPath, 'utf8'));

const manifestOverride = process.argv.find((a) => a.startsWith('--slicc-manifest='));
const sliccManifestPath = manifestOverride
  ? manifestOverride.slice('--slicc-manifest='.length)
  : resolve(
      repoRoot,
      'packages/webapp/src/shell/supplemental-commands/playwright/slicc-commands.json'
    );
const sliccSchema = JSON.parse(readFileSync(sliccManifestPath, 'utf8'));

const sliccOnlyCommands = new Set(sliccSchema._slicc_only ?? []);

const officialSkipFlags = sliccSchema._official_skip_flags ?? {};

const officialSkipCommands = new Set([
  'attach',
  'detach',
  'close',
  'delete-data',
  'list',
  'close-all',
  'kill-all',
  'install',
  'install-browser',
  'tray',
  'config-print',
  'run-code',
  'show',
  'pause-at',
  'step-over',
  'resume',
  'tracing-start',
  'tracing-stop',
  'video-start',
  'video-stop',
  'video-chapter',
  'video-show-actions',
  'video-hide-actions',
]);

const officialCmds = officialSchema.commands;
const sliccCmds = sliccSchema.commands;

const missingCommands = [];
const flagGaps = [];
const argGaps = [];

for (const [name, official] of Object.entries(officialCmds)) {
  if (officialSkipCommands.has(name)) continue;

  const slicc = sliccCmds[name];
  if (!slicc) {
    missingCommands.push({ name, args: official.args, flags: official.flags, help: official.help });
    continue;
  }

  const skipFlags = new Set(officialSkipFlags[name] ?? []);
  const missingFlags = {};
  for (const [flag, type] of Object.entries(official.flags ?? {})) {
    if (!skipFlags.has(flag) && !(flag in (slicc.flags ?? {}))) missingFlags[flag] = type;
  }
  if (Object.keys(missingFlags).length > 0) {
    flagGaps.push({ command: name, missingFlags });
  }

  const helpFirstLine = (official.help ?? '').split('\n')[0] ?? '';
  const officialRequired = (official.args ?? []).filter((a) => !helpFirstLine.includes(`[${a}]`));
  const sliccRequired = (slicc.args ?? []).filter((a) => !a.startsWith('['));
  if (officialRequired.length > sliccRequired.length) {
    argGaps.push({ command: name, officialArgs: official.args, sliccArgs: slicc.args });
  }
}

const undeclaredSliccOnly = Object.keys(sliccCmds).filter(
  (n) => !(n in officialCmds) && !sliccOnlyCommands.has(n)
);

if (jsonFlag) {
  console.log(JSON.stringify({ missingCommands, flagGaps, argGaps, undeclaredSliccOnly }, null, 2));
  process.exit(missingCommands.length + flagGaps.length + argGaps.length > 0 ? 1 : 0);
}

const total = missingCommands.length + flagGaps.length + argGaps.length;

if (total === 0 && undeclaredSliccOnly.length === 0) {
  console.log('✓ Slicc playwright-cli is fully aligned with the official schema.');
  process.exit(0);
}

if (missingCommands.length > 0) {
  console.log(`\n## Missing commands (${missingCommands.length})\n`);
  for (const { name, args, flags, help } of missingCommands) {
    const helpLine = (help ?? '').split('\n')[0] ?? '';
    const argStr = (args ?? [])
      .map((a) => (helpLine.includes(`[${a}]`) ? `[${a}]` : `<${a}>`))
      .join(' ');
    const flagStr = Object.entries(flags ?? {})
      .map(([f, t]) => `--${f}${t === 'boolean' ? '' : '=<val>'}`)
      .join(' ');
    console.log(`  ${name}${argStr ? ' ' + argStr : ''}${flagStr ? '  [' + flagStr + ']' : ''}`);
  }
}

if (flagGaps.length > 0) {
  console.log(`\n## Flag gaps on existing commands (${flagGaps.length})\n`);
  for (const { command, missingFlags } of flagGaps) {
    const flags = Object.entries(missingFlags)
      .map(([f, t]) => `--${f} (${t})`)
      .join(', ');
    console.log(`  ${command}: ${flags}`);
  }
}

if (argGaps.length > 0) {
  console.log(`\n## Arg gaps on existing commands (${argGaps.length})\n`);
  for (const { command, officialArgs, sliccArgs } of argGaps) {
    console.log(
      `  ${command}: official=${JSON.stringify(officialArgs)} slicc=${JSON.stringify(sliccArgs)}`
    );
  }
}

if (undeclaredSliccOnly.length > 0) {
  console.log(
    `\n## Slicc-only commands not listed in _slicc_only (${undeclaredSliccOnly.length})\n`
  );
  for (const name of undeclaredSliccOnly) {
    console.log(`  ${name}  — add to _slicc_only in slicc-commands.json if intentional`);
  }
}

console.log(`\n${total} gap(s) found.`);
process.exit(total > 0 ? 1 : 0);
