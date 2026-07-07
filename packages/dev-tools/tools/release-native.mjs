#!/usr/bin/env node
// Gate the native macOS (Sliccstart DMG + update ZIP) and iOS (TestFlight)
// packaging steps of the semantic-release prepareCmd on whether their relevant
// source changed since the previous release tag. The always-run steps
// (`npm run build`, `npm run package:release`) stay in .releaserc.json; only
// these two native steps are gated here.
//
// The pure decision helpers (no IO) are unit-tested by the `dev-tools` vitest
// project via the co-located release-native.test.mjs. Only main() touches git
// and spawns the packaging scripts.

import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// APPROVED relevant path sets. macOS also tracks packages/spoon/ because it
// builds the only web artifact embedded into the macOS .app.
export const MACOS_PATH_PREFIXES = [
  'packages/swift-launcher/',
  'packages/swift-server/',
  'packages/swift-optel/',
  'packages/spoon/',
];
export const IOS_PATH_PREFIXES = ['packages/ios-app/'];

// Command strings preserve the current .releaserc.json fail-fast behavior
// (chmod then run; a non-zero exit throws out of execSync).
export const MACOS_SCRIPT_CMD =
  'chmod +x packages/swift-launcher/sign-and-package.sh && packages/swift-launcher/sign-and-package.sh';
export const IOS_SCRIPT_CMD =
  'chmod +x packages/ios-app/scripts/package-and-upload-testflight.sh && packages/ios-app/scripts/package-and-upload-testflight.sh';

// An empty / unset / placeholder tag means "first release" — build both.
export function isFirstRelease(lastTag) {
  const t = typeof lastTag === 'string' ? lastTag.trim() : '';
  return t === '' || t === 'null' || t === 'undefined';
}

export function matchesAnyPrefix(file, prefixes) {
  return prefixes.some((p) => {
    const dir = p.replace(/\/+$/, '');
    return file === dir || file.startsWith(`${dir}/`);
  });
}

export function parseChangedFiles(gitOutput) {
  return String(gitOutput ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// Core gating decision. Returns which native artifacts to build.
export function decideGating({ lastTag, changedFiles = [] } = {}) {
  if (isFirstRelease(lastTag)) {
    return { macos: true, ios: true, firstRelease: true };
  }
  return {
    macos: changedFiles.some((f) => matchesAnyPrefix(f, MACOS_PATH_PREFIXES)),
    ios: changedFiles.some((f) => matchesAnyPrefix(f, IOS_PATH_PREFIXES)),
    firstRelease: false,
  };
}

export function parseArgs(argv) {
  const args = { last: '', dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a.startsWith('--last=')) args.last = a.slice('--last='.length);
    else if (a === '--last') args.last = argv[++i] ?? '';
  }
  return args;
}

const HELP = `release-native — gate native macOS/iOS release packaging on source changes

Usage:
  node packages/dev-tools/tools/release-native.mjs --last=<tag> [--dry-run]

Options:
  --last=<tag>   Previous release git tag. Empty => first release => build BOTH.
                 In .releaserc.json use --last='\${lastRelease.gitTag}'.
  --dry-run, -n  Print the gating decision without running the packaging scripts.
  --help, -h     Show this help.

Behavior:
  - First release (empty tag): build macOS + iOS native artifacts.
  - Otherwise: diff <tag>..HEAD and build macOS only if one of
    ${MACOS_PATH_PREFIXES.join(', ')} changed, iOS only if
    ${IOS_PATH_PREFIXES.join(', ')} changed.
  - A failing packaging script fails the release (fail-fast preserved).`;

function getChangedFiles(lastTag) {
  const out = execSync(`git diff --name-only ${lastTag} HEAD`, { encoding: 'utf8' });
  return parseChangedFiles(out);
}

function runStep(label, cmd, dryRun) {
  if (dryRun) {
    console.log(`[release-native] (dry-run) would build ${label}: ${cmd}`);
    return;
  }
  console.log(`[release-native] Building ${label} …`);
  execSync(cmd, { stdio: 'inherit' });
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const changedFiles = isFirstRelease(args.last) ? [] : getChangedFiles(args.last);
  const decision = decideGating({ lastTag: args.last, changedFiles });

  if (decision.firstRelease) {
    console.log('[release-native] First release (no previous tag) — building both native targets.');
  } else {
    console.log(`[release-native] Changed since ${args.last}: ${changedFiles.length} file(s).`);
  }

  if (decision.macos) runStep('macOS (Sliccstart DMG + update ZIP)', MACOS_SCRIPT_CMD, args.dryRun);
  else console.log('[release-native] Skipping macOS native packaging (no macOS-relevant changes).');

  if (decision.ios) runStep('iOS (TestFlight ipa)', IOS_SCRIPT_CMD, args.dryRun);
  else console.log('[release-native] Skipping iOS native packaging (no iOS-relevant changes).');

  return 0;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main());
