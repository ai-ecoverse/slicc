#!/usr/bin/env node
// Gate the native macOS (Sliccstart DMG + update ZIP) and iOS (TestFlight)
// packaging steps of the semantic-release prepareCmd — and the Chrome Web Store
// publish steps of the publishCmd (`--gate=chrome` / `--gate=worker`) — plus the
// `@ai-ecoverse/biome-jsh` npm release (`--gate=biome-jsh-version` in prepare,
// `--gate=biome-jsh` in publish) — on whether their relevant source changed since
// the previous release tag. The always-run build/package steps stay in
// .releaserc.json; only gated steps are decided here.
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
  'packages/swift-traysession/',
  'packages/spoon/',
  'packages/assets/',
];
// swift-trayfollower compiles INTO the ipa (SliccTrayFollower, re-exported
// via TrayFollowerExports.swift), so a trayfollower-only change must gate an
// iOS release — without it the fix ships silently only when an unrelated
// ios-app file next changes.
export const IOS_PATH_PREFIXES = [
  'packages/ios-app/',
  'packages/swift-traysession/',
  'packages/swift-trayfollower/',
];

// APPROVED relevant path set for the `slicc` Go CLI binaries. The CLI vendors
// its own copy of the wire protocol (internal/protocol), so that part of the
// built binary has no cross-package inputs — but packages/go-optel/ is a real
// build dependency (pulled in via a local `replace` in slicc-cli's go.mod;
// this monorepo has no go.work), so a go-optel-only change must still gate a
// release, or a go-optel fix would ship silently until an unrelated
// slicc-cli file next changed.
export const SLICC_CLI_PATH_PREFIXES = ['packages/slicc-cli/', 'packages/go-optel/'];

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

// APPROVED relevant path set for the standalone `@ai-ecoverse/biome-jsh` npm
// package. It ships only its own directory (see its package.json `files`) and
// resolves the Biome binary at runtime, so it has no other build inputs — a
// SLICC release that touches nothing here would publish a byte-identical tarball
// under a new version number.
export const BIOME_JSH_PATH_PREFIXES = ['packages/dev-tools/biome-jsh/'];

// Files inside the package that never reach the tarball (the `files` array ships
// only biome-jsh.mjs, lib.mjs, jsh-biome-source.mjs and README.md), so a change
// confined to them would publish a byte-identical tarball.
export const BIOME_JSH_IGNORED_PATTERN = /\.test\.mjs$/;

// Command strings preserve the current .releaserc.json fail-fast behavior
// (chmod then run; a non-zero exit throws out of execSync).
export const MACOS_SCRIPT_CMD =
  'chmod +x packages/swift-launcher/sign-and-package.sh && packages/swift-launcher/sign-and-package.sh';
export const IOS_SCRIPT_CMD =
  'chmod +x packages/ios-app/scripts/package-and-upload-testflight.sh && packages/ios-app/scripts/package-and-upload-testflight.sh';
// Build + Developer ID-sign + notarize the Go CLI binaries, staging them into
// artifacts/release/ (attached by @semantic-release/github). Reuses the cert +
// notarytool creds already set up in the macOS release job. The version env is
// applied to the script invocation (not the preceding `chmod`) by the caller —
// `VAR=v chmod && script` would scope VAR to `chmod` only.
export const SLICC_CLI_SCRIPT = 'packages/slicc-cli/sign-and-package.sh';
// A failing publish must fail the release (fail-fast preserved via execSync).
export const CHROME_PUBLISH_CMD = 'npm run publish:chrome';
// biome-jsh is published from its own directory (it is not an npm workspace of
// the root package). `--provenance` / `--access public` mirror the settings the
// former second @semantic-release/npm target used.
export const BIOME_JSH_PUBLISH_CMD =
  'npm publish packages/dev-tools/biome-jsh --provenance --access public';

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

// Core gating decision for the `slicc` Go CLI binaries. Kept separate from
// decideGating so the native macOS/iOS decision shape stays untouched.
export function decideSliccCliGating({ lastTag, changedFiles = [] } = {}) {
  if (isFirstRelease(lastTag)) {
    return { sliccCli: true, firstRelease: true };
  }
  return {
    sliccCli: changedFiles.some((f) => matchesAnyPrefix(f, SLICC_CLI_PATH_PREFIXES)),
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

// Core gating decision for the @ai-ecoverse/biome-jsh npm release. The same
// decision drives both phases — the prepare-phase version bump and the
// publish-phase `npm publish` — so a published version always matches the
// version committed back by @semantic-release/git.
export function decideBiomeJshGating({ lastTag, changedFiles = [] } = {}) {
  if (isFirstRelease(lastTag)) {
    return { biomeJsh: true, firstRelease: true };
  }
  return {
    biomeJsh: changedFiles
      .filter((f) => !BIOME_JSH_IGNORED_PATTERN.test(f))
      .some((f) => matchesAnyPrefix(f, BIOME_JSH_PATH_PREFIXES)),
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

// Repo path of the biome-jsh package manifest, resolved relative to this script
// so it works from any cwd.
export const BIOME_JSH_PKG_JSON_PATH = fileURLToPath(
  new URL('../biome-jsh/package.json', import.meta.url)
);

// Pure helper (no IO): the biome-jsh manifest with `version` set to the release
// version. Trims a leading `v` (git-tag style). Throws on empty so the caller
// must decide whether to skip.
export function buildBiomeJshManifest(manifest, version) {
  const v = (typeof version === 'string' ? version : '').trim().replace(/^v/, '');
  if (!v) throw new Error('buildBiomeJshManifest: a non-empty version is required');
  return { ...manifest, version: v };
}

// Small IO wrapper: stamp the release version into the biome-jsh manifest,
// preserving the checked-in 2-space + trailing-newline format. The re-serialize
// is intentionally opinionated — any other formatting in the manifest gets
// canonicalized to that shape (matching root package.json / `npm init`).
function writeBiomeJshVersion(version, targetPath = BIOME_JSH_PKG_JSON_PATH) {
  const current = JSON.parse(readFileSync(targetPath, 'utf8'));
  const manifest = buildBiomeJshManifest(current, version);
  writeFileSync(targetPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const HELP = `release-native — gate native packaging, worker deploy, Chrome publish, and the biome-jsh npm release on source changes

Usage:
  node packages/dev-tools/tools/release-native.mjs --last=<tag> [--gate=chrome|worker|biome-jsh|biome-jsh-version] [--dry-run]

Options:
  --last=<tag>   Previous release git tag. Empty => first release => run ALL gated steps.
                 In .releaserc.json use --last='\${lastRelease.gitTag}'.
  --next=<ver>   Next release version. When the macOS gate is open and its packaging
                 step succeeds (non-dry-run), record it in the committed known-good
                 macOS pointer. Also the version stamped into the biome-jsh manifest by
                 --gate=biome-jsh-version. Empty => skip the pointer update / version
                 stamp (never fails the release).
                 In .releaserc.json use --next='\${nextRelease.version}'.
  --gate=chrome  Gate the Chrome Web Store publish (\`${CHROME_PUBLISH_CMD}\`) instead of
                 the default native macOS/iOS packaging.
  --gate=worker  Print "deploy" when the production worker/UI should deploy, otherwise
                 print "skip". This decision mode never runs the deploy itself.
  --gate=biome-jsh-version
                 Prepare phase: stamp --next into packages/dev-tools/biome-jsh/package.json
                 (committed by @semantic-release/git) only when the biome-jsh gate is open.
  --gate=biome-jsh
                 Publish phase: run \`${BIOME_JSH_PUBLISH_CMD}\` only when the gate is open.
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
    ${IOS_PATH_PREFIXES.join(', ')} changed, and the signed + notarized slicc CLI
    binaries only if ${SLICC_CLI_PATH_PREFIXES.join(', ')} changed.
  - --gate=chrome: use the same resolved diff ref and publish to the Chrome Web Store if one of
    ${EXTENSION_PATH_PREFIXES.join(', ')} changed.
  - --gate=worker: use the same resolved diff ref and print deploy only if one of
    ${WORKER_PATH_PREFIXES.join(', ')} changed.
  - --gate=biome-jsh[-version]: use the same resolved diff ref and bump / publish
    @ai-ecoverse/biome-jsh only if ${BIOME_JSH_PATH_PREFIXES.join(', ')} changed, so the
    package is not republished unchanged on every SLICC release.
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

function runStep(label, cmd, dryRun, verb = 'Building', dryVerb = 'build', execOpts = {}) {
  if (dryRun) {
    console.log(`[release-native] (dry-run) would ${dryVerb} ${label}: ${cmd}`);
    return;
  }
  console.log(`[release-native] ${verb} ${label} …`);
  execSync(cmd, { stdio: 'inherit', ...execOpts });
}

// Bound on a non-gating step. An archive + TestFlight upload normally runs
// well under 20 minutes; a hung xcodebuild/altool would otherwise sit on
// semantic-release's prepareCmd until the JOB timeout and gate every later
// publish anyway — the exact failure mode the wrapper exists to prevent.
export const NON_GATING_STEP_TIMEOUT_MS = 25 * 60 * 1000;

/**
 * Run a DISTRIBUTION step that must never gate the rest of the release.
 * TestFlight archiving/upload is distribution, not build correctness (CI
 * builds and tests iOS on every PR): a signing regression on Apple's side
 * — a provisioning profile losing the iCloud capability, an expired cert —
 * would otherwise hold the worker, extension, and macOS publishes hostage.
 * On 2026-08-02 exactly that produced 16 consecutive silent red releases
 * with a day of merged web work unshipped. The failure stays loud (a
 * GitHub Actions error annotation that surfaces on the run summary), the
 * release proceeds without an ipa — and a green release was already never
 * proof an ipa shipped, since the script soft-skips on missing secrets and
 * old Xcode too.
 *
 * The invocation is time-bounded (`NON_GATING_STEP_TIMEOUT_MS`): a HUNG
 * tool never throws on its own, and an unbounded synchronous call inside
 * prepareCmd would consume the job timeout and gate every later publish —
 * the same hostage situation, wearing a different face. On timeout,
 * execSync kills the process (SIGKILL — xcodebuild ignores politer
 * signals when wedged) and throws, landing in the same catch.
 *
 * `runStepImpl` is injectable for tests.
 */
export function runNonGatingStep(label, cmd, dryRun, runStepImpl = runStep) {
  try {
    runStepImpl(label, cmd, dryRun, undefined, undefined, {
      timeout: NON_GATING_STEP_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`::error title=${label} failed (release continued)::${message.split('\n')[0]}`);
    console.error(
      `[release-native] ${label} FAILED — continuing the release without it. ` +
        'Fix the native signing state and re-release to ship it.'
    );
    return false;
  }
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

// Default native gate: build macOS (+ known-good pointer), iOS, and the signed
// slicc CLI binaries per their change-since-last-tag decisions. Extracted from
// main() to keep its cognitive complexity within the biome gate.
function runNativeGate(args, changedFiles) {
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

  if (decision.ios) {
    runNonGatingStep('iOS (TestFlight ipa)', IOS_SCRIPT_CMD, args.dryRun);
  } else {
    console.log('[release-native] Skipping iOS native packaging (no iOS-relevant changes).');
  }

  const cliDecision = decideSliccCliGating({ lastTag: args.last, changedFiles });
  if (cliDecision.sliccCli) {
    // Pass the next version so the binaries stamp the release tag. The env MUST
    // sit on the script invocation, not the `chmod` before the `&&` (which would
    // scope it to `chmod`). Empty (a dry-run / manual run) → the script falls
    // back to package.json, then git describe.
    const versionEnv = args.next.trim() ? `SLICC_RELEASE_VERSION='${args.next.trim()}' ` : '';
    runStep(
      'slicc CLI (signed + notarized binaries)',
      `chmod +x ${SLICC_CLI_SCRIPT} && ${versionEnv}${SLICC_CLI_SCRIPT}`,
      args.dryRun
    );
  } else {
    console.log('[release-native] Skipping slicc CLI binaries (no packages/slicc-cli changes).');
  }
}

// biome-jsh gate. Two phases share one decision: `--gate=biome-jsh-version`
// stamps the release version into the manifest during prepare (so
// @semantic-release/git commits it), `--gate=biome-jsh` publishes during publish.
// A closed gate leaves the manifest at the last published version.
function runBiomeJshGate(args, changedFiles) {
  const publishPhase = args.gate === 'biome-jsh';
  const decision = decideBiomeJshGating({ lastTag: args.last, changedFiles });

  if (!decision.biomeJsh) {
    console.log(
      `[release-native] Skipping @ai-ecoverse/biome-jsh ${publishPhase ? 'npm publish' : 'version stamp'} (no packages/dev-tools/biome-jsh changes).`
    );
    return;
  }

  if (publishPhase) {
    runStep(
      '@ai-ecoverse/biome-jsh (npm)',
      BIOME_JSH_PUBLISH_CMD,
      args.dryRun,
      'Publishing',
      'publish'
    );
    return;
  }

  if (args.dryRun) {
    console.log(
      `[release-native] (dry-run) would stamp @ai-ecoverse/biome-jsh version ${args.next}.`
    );
    return;
  }

  if (!args.next.trim()) {
    console.warn(
      '[release-native] --next is empty; skipping the @ai-ecoverse/biome-jsh version stamp.'
    );
    return;
  }

  const manifest = writeBiomeJshVersion(args.next);
  console.log(`[release-native] Stamped @ai-ecoverse/biome-jsh version → ${manifest.version}.`);
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

  if (args.gate === 'biome-jsh' || args.gate === 'biome-jsh-version') {
    runBiomeJshGate(args, changedFiles);
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

  runNativeGate(args, changedFiles);
  return 0;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main());
