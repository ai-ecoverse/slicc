#!/usr/bin/env node
// Gate the native macOS (Sliccstart DMG + update ZIP) and iOS (TestFlight)
// packaging steps of the semantic-release prepareCmd — and the Chrome Web Store
// publish steps of the publishCmd (`--gate=chrome` / `--gate=worker`) — on whether
// their relevant source changed since the previous release tag. The always-run
// build/package steps stay in .releaserc.json; only gated steps are decided here.
//
// The pure decision helpers (no IO) are unit-tested by the `dev-tools` vitest
// project via the co-located release-native.test.mjs. Only main() touches git
// and spawns the packaging / publish scripts.

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
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

// APPROVED worker/UI-relevant path set for the production worker deploy. This
// includes the worker, everything bundled into its served UI, shared worker
// dependencies, and the node-server/template inputs published for cloud cones.
// Root package metadata is included because dependency changes can alter both
// the worker/UI build and the hosted template runtime.
export const WORKER_PATH_PREFIXES = [
  'packages/cloudflare-worker/',
  'packages/webapp/',
  'packages/webcomponents/',
  'packages/spoon/',
  'packages/cherry/',
  'packages/shared-ts/',
  'packages/cloud-core/',
  'packages/dev-tools/e2b-template/',
  'packages/node-server/',
  'packages/vfs-root/',
  'packages/assets/',
  'package.json',
  'package-lock.json',
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

export function resolveDiffRef({ headSubject, headRef = 'HEAD' } = {}) {
  return String(headSubject ?? '').startsWith('chore(release):') ? `${headRef}^` : headRef;
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

export function decideWorkerGating({ lastTag, changedFiles = [] } = {}) {
  if (isFirstRelease(lastTag)) {
    return { worker: true, firstRelease: true };
  }
  return {
    worker: changedFiles.some((f) => matchesAnyPrefix(f, WORKER_PATH_PREFIXES)),
    firstRelease: false,
  };
}

// Pure classifier (no IO): given the combined stdout+stderr of a `wrangler
// deploy`, decide whether the ONLY thing that failed was route reconciliation
// (so the new worker version already uploaded AND activated — script + assets
// are live and serving — and only the routes step failed, e.g. the deploy token
// lacks Zone → Workers Routes → Edit). Such a failure is tolerable because the
// routes are set-once/stable and the new version is already serving them; the
// release should continue. Any other failure (script upload, bindings,
// asset-too-large) is NOT tolerable and must fail the release.
//
// Two signals, BOTH required:
//   1. the worker version uploaded ("Uploaded <name> (<n> sec)") — proves the
//      new version is live, which is what makes ignoring the routes step safe;
//   2. Wrangler's specific route-reconcile error bullet ("A request to the
//      Cloudflare API (…/workers/routes) failed") — NOT any stray
//      "workers/routes" mention in the debug log.
// Requiring the upload line rules out a pre-deploy routes failure (version never
// went live). Wrangler phrases the routes failure two ways for these workers —
// the hub wraps it in "Some triggers failed to deploy for <worker>", the preview
// worker surfaces the bare routes-API auth error — and both carry signals 1+2,
// so matching on those (rather than the "triggers failed" wrapper) covers both.
export function isRoutesReconcileOnlyFailure(output) {
  const text = typeof output === 'string' ? output : '';
  const scriptUploaded = /Uploaded [\w.-]+ \([\d.]+ sec\)/i.test(text);
  const routesReconcileFailed =
    /A request to the Cloudflare API \([^)]*workers\/routes\) failed/i.test(text);
  return scriptUploaded && routesReconcileFailed;
}

// Value-taking flags → args field. Each supports `--flag=value` and
// `--flag value`; unknown flags are ignored (unchanged behavior).
const VALUE_OPTS = {
  '--last': 'last',
  '--next': 'next',
  '--gate': 'gate',
  '--classify-deploy-log': 'classifyDeployLog',
};

export function parseArgs(argv) {
  const args = { last: '', next: '', gate: '', dryRun: false, help: false, classifyDeployLog: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--dry-run' || a === '-n') {
      args.dryRun = true;
      continue;
    }
    const eq = a.indexOf('=');
    const field = VALUE_OPTS[eq === -1 ? a : a.slice(0, eq)];
    if (field) args[field] = eq === -1 ? (argv[++i] ?? '') : a.slice(eq + 1);
  }
  return args;
}

// Pure helper (no IO): build the committed known-good macOS pointer object for a
// version string. Trims a leading `v` (git-tag style). Throws on empty so the
// caller must decide whether to skip.
export function buildKnownGoodPointer(version) {
  const v = (typeof version === 'string' ? version : '').trim().replace(/^v/, '');
  if (!v) throw new Error('buildKnownGoodPointer: a non-empty version is required');
  return { version: v };
}

// Repo path of the committed known-good macOS pointer, resolved relative to this
// script so it works from any cwd.
export const KNOWN_GOOD_MACOS_PATH = fileURLToPath(
  new URL('../../cloudflare-worker/src/known-good-macos.json', import.meta.url)
);

// Small IO wrapper: serialize the pure pointer to the committed file (single-line
// object + trailing newline, matching the checked-in format).
function writeKnownGoodPointer(version, targetPath = KNOWN_GOOD_MACOS_PATH) {
  const pointer = buildKnownGoodPointer(version);
  writeFileSync(targetPath, `{ "version": ${JSON.stringify(pointer.version)} }\n`);
  return pointer;
}

const HELP = `release-native — gate native packaging, worker deploy, and Chrome publish on source changes

Usage:
  node packages/dev-tools/tools/release-native.mjs --last=<tag> [--gate=chrome|worker] [--dry-run]

Options:
  --last=<tag>   Previous release git tag. Empty => first release => run ALL gated steps.
                 In .releaserc.json use --last='\${lastRelease.gitTag}'.
  --next=<ver>   Next release version. When the macOS gate is open and its packaging
                 step succeeds (non-dry-run), record it in the committed known-good
                 macOS pointer. Empty => skip the pointer update (never fails the release).
                 In .releaserc.json use --next='\${nextRelease.version}'.
  --gate=chrome  Gate the Chrome Web Store publish (\`${CHROME_PUBLISH_CMD}\`) instead of
                 the default native macOS/iOS packaging.
  --gate=worker  Print "deploy" when the production worker/UI should deploy, otherwise
                 print "skip". This decision mode never runs the deploy itself.
  --classify-deploy-log=<path>
                 Read a captured \`wrangler deploy\` log and print "routes-only" when the
                 ONLY failure was route reconciliation (the script + assets deployed and
                 are live), otherwise "fatal". Used by publish-worker.sh; never touches git.
  --dry-run, -n  Print the gating decision without running the packaging / publish scripts.
  --help, -h     Show this help.

Behavior:
  - First release (empty tag): run the gated step(s) unconditionally.
  - Default (no --gate): diff <tag> against HEAD (or HEAD^ for a generated release commit)
    and build macOS only if one of
    ${MACOS_PATH_PREFIXES.join(', ')} changed, iOS only if
    ${IOS_PATH_PREFIXES.join(', ')} changed.
  - --gate=chrome: use the same resolved diff ref and publish to the Chrome Web Store if one of
    ${EXTENSION_PATH_PREFIXES.join(', ')} changed.
  - --gate=worker: use the same resolved diff ref and print deploy only if one of
    ${WORKER_PATH_PREFIXES.join(', ')} changed.
  - A failing packaging / publish script fails the release (fail-fast preserved).`;

export function getChangedFiles(lastTag) {
  const headRef = 'HEAD';
  const headSubject = execFileSync('git', ['log', '-1', '--format=%s', headRef], {
    encoding: 'utf8',
  });
  const diffRef = resolveDiffRef({ headSubject, headRef });
  const out = execFileSync('git', ['diff', '--name-only', lastTag, diffRef], {
    encoding: 'utf8',
  });
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

// IO wrapper: classify a captured `wrangler deploy` log file as "routes-only"
// (tolerable — the script + assets already deployed and are live) or "fatal".
// An unreadable file is conservatively "fatal" so an unclassifiable deploy is
// never mistaken for the benign routes-only case.
function classifyDeployLogFile(path) {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`[release-native] could not read deploy log ${path}; treating as fatal: ${err}`);
    return 'fatal';
  }
  return isRoutesReconcileOnlyFailure(text) ? 'routes-only' : 'fatal';
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  if (args.classifyDeployLog) {
    console.log(classifyDeployLogFile(args.classifyDeployLog));
    return 0;
  }

  const changedFiles = isFirstRelease(args.last) ? [] : getChangedFiles(args.last);

  if (args.gate === 'worker') {
    const decision = decideWorkerGating({ lastTag: args.last, changedFiles });
    console.log(decision.worker ? 'deploy' : 'skip');
    return 0;
  }

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

  if (decision.macos) {
    runStep('macOS (Sliccstart DMG + update ZIP)', MACOS_SCRIPT_CMD, args.dryRun);
    // The macOS packaging step succeeded (runStep throws on failure) — record the
    // DMG-carrying version in the committed pointer. Skipped on dry-run and when
    // --next is empty (a missing version must not fail the release).
    if (!args.dryRun) {
      if (args.next.trim()) {
        const pointer = writeKnownGoodPointer(args.next);
        console.log(
          `[release-native] Updated known-good macOS pointer → ${pointer.version} (${KNOWN_GOOD_MACOS_PATH}).`
        );
      } else {
        console.warn('[release-native] --next is empty; skipping known-good macOS pointer update.');
      }
    }
  } else {
    console.log('[release-native] Skipping macOS native packaging (no macOS-relevant changes).');
  }

  if (decision.ios) runStep('iOS (TestFlight ipa)', IOS_SCRIPT_CMD, args.dryRun);
  else console.log('[release-native] Skipping iOS native packaging (no iOS-relevant changes).');

  return 0;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main());
