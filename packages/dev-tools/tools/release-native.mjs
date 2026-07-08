#!/usr/bin/env node
// Gate the native macOS (Sliccstart DMG + update ZIP) and iOS (TestFlight)
// packaging steps of the semantic-release prepareCmd — and the Chrome Web Store
// publish step of the publishCmd (`--gate=chrome`) — on whether their relevant
// source changed since the previous release tag. The always-run steps
// (`npm run build`, `npm run package:release`, `npm run publish:worker`) stay in
// .releaserc.json; only these gated steps are decided here.
//
// The pure decision helpers (no IO) are unit-tested by the `dev-tools` vitest
// project via the co-located release-native.test.mjs. Only main() touches git
// and spawns the packaging / publish scripts.

import { execFileSync, execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// APPROVED relevant path sets. macOS also tracks packages/spoon/ because it
// builds the only web artifact embedded into the macOS .app, and packages/assets/
// because assemble-app.mjs consumes packages/assets/logos/macos-icon for the
// .app bundle icon.
export const MACOS_PATH_PREFIXES = [
  'packages/swift-launcher/',
  'packages/swift-server/',
  'packages/swift-optel/',
  'packages/spoon/',
  'packages/assets/',
];
export const IOS_PATH_PREFIXES = ['packages/ios-app/'];

// APPROVED extension-relevant path set for the Chrome Web Store publish. Covers
// the extension entry points plus every web package bundled into the extension
// artifact (webapp, its UI shell, shared primitives, and the injection/host
// SDKs), plus packages/assets/ (chrome-extension vite copies its logos + fonts,
// and webapp copies its favicon and uses it as publicDir). Excludes native
// (swift/ios), the worker, node-server, and docs.
export const EXTENSION_PATH_PREFIXES = [
  'packages/chrome-extension/',
  'packages/webapp/',
  'packages/webcomponents/',
  'packages/shared-ts/',
  'packages/cherry/',
  'packages/spoon/',
  'packages/cloud-core/',
  'packages/assets/',
];

// Command strings preserve the current .releaserc.json fail-fast behavior
// (chmod then run; a non-zero exit throws out of execSync).
export const MACOS_SCRIPT_CMD =
  'chmod +x packages/swift-launcher/sign-and-package.sh && packages/swift-launcher/sign-and-package.sh';
export const IOS_SCRIPT_CMD =
  'chmod +x packages/ios-app/scripts/package-and-upload-testflight.sh && packages/ios-app/scripts/package-and-upload-testflight.sh';
// A failing publish must fail the release (fail-fast preserved via execSync).
export const CHROME_PUBLISH_CMD = 'npm run publish:chrome';

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

// Core gating decision for the Chrome Web Store publish. Kept separate from
// decideGating so the native decision shape stays untouched.
export function decideChromeGating({ lastTag, changedFiles = [] } = {}) {
  if (isFirstRelease(lastTag)) {
    return { chrome: true, firstRelease: true };
  }
  return {
    chrome: changedFiles.some((f) => matchesAnyPrefix(f, EXTENSION_PATH_PREFIXES)),
    firstRelease: false,
  };
}

export function parseArgs(argv) {
  const args = { last: '', gate: '', dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a.startsWith('--last=')) args.last = a.slice('--last='.length);
    else if (a === '--last') args.last = argv[++i] ?? '';
    else if (a.startsWith('--gate=')) args.gate = a.slice('--gate='.length);
    else if (a === '--gate') args.gate = argv[++i] ?? '';
  }
  return args;
}

const HELP = `release-native — gate native macOS/iOS packaging and the Chrome Web Store publish on source changes

Usage:
  node packages/dev-tools/tools/release-native.mjs --last=<tag> [--gate=chrome] [--dry-run]

Options:
  --last=<tag>   Previous release git tag. Empty => first release => run ALL gated steps.
                 In .releaserc.json use --last='\${lastRelease.gitTag}'.
  --gate=chrome  Gate the Chrome Web Store publish (\`${CHROME_PUBLISH_CMD}\`) instead of
                 the default native macOS/iOS packaging.
  --dry-run, -n  Print the gating decision without running the packaging / publish scripts.
  --help, -h     Show this help.

Behavior:
  - First release (empty tag): run the gated step(s) unconditionally.
  - Default (no --gate): diff <tag>..HEAD and build macOS only if one of
    ${MACOS_PATH_PREFIXES.join(', ')} changed, iOS only if
    ${IOS_PATH_PREFIXES.join(', ')} changed.
  - --gate=chrome: diff <tag>..HEAD and publish to the Chrome Web Store only if one of
    ${EXTENSION_PATH_PREFIXES.join(', ')} changed.
  - A failing packaging / publish script fails the release (fail-fast preserved).`;

function getChangedFiles(lastTag) {
  const out = execFileSync('git', ['diff', '--name-only', lastTag, 'HEAD'], { encoding: 'utf8' });
  return parseChangedFiles(out);
}

function runStep(label, cmd, dryRun, verb = 'Building', dryVerb = 'build') {
  if (dryRun) {
    console.log(`[release-native] (dry-run) would ${dryVerb} ${label}: ${cmd}`);
    return;
  }
  console.log(`[release-native] ${verb} ${label} …`);
  execSync(cmd, { stdio: 'inherit' });
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const changedFiles = isFirstRelease(args.last) ? [] : getChangedFiles(args.last);

  if (args.gate === 'chrome') {
    const decision = decideChromeGating({ lastTag: args.last, changedFiles });
    if (decision.firstRelease) {
      console.log(
        '[release-native] First release (no previous tag) — publishing the extension to the Chrome Web Store.'
      );
    } else {
      console.log(`[release-native] Changed since ${args.last}: ${changedFiles.length} file(s).`);
    }

    if (decision.chrome) {
      runStep(
        'Chrome Web Store extension',
        CHROME_PUBLISH_CMD,
        args.dryRun,
        'Publishing',
        'publish'
      );
    } else {
      console.log(
        '[release-native] Skipping Chrome Web Store publish (no extension-relevant changes).'
      );
    }

    return 0;
  }

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
