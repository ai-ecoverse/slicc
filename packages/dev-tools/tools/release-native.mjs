#!/usr/bin/env node

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MACOS_PATH_PREFIXES = [
  'packages/swift-launcher/',
  'packages/swift-server/',
  'packages/swift-optel/',
  'packages/swift-traysession/',
  'packages/swift-trayfollower/',
  'packages/swift-traykit/',
  'packages/swift-widgetkit/',
  'packages/spoon/',
  'packages/assets/',
];

export const IOS_PATH_PREFIXES = [
  'packages/ios-app/',
  'packages/swift-traysession/',
  'packages/swift-trayfollower/',
  'packages/swift-traykit/',
  'packages/swift-widgetkit/',
];

export const SLICC_CLI_PATH_PREFIXES = ['packages/slicc-cli/', 'packages/go-optel/'];

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

export const BIOME_JSH_PATH_PREFIXES = ['packages/dev-tools/biome-jsh/'];

export const BIOME_JSH_IGNORED_PATTERN = /\.test\.mjs$/;

export const MACOS_SCRIPT_CMD =
  'chmod +x packages/swift-launcher/sign-and-package.sh && packages/swift-launcher/sign-and-package.sh';
export const IOS_SCRIPT_CMD =
  'chmod +x packages/ios-app/scripts/package-and-upload-testflight.sh && packages/ios-app/scripts/package-and-upload-testflight.sh';

export const SLICC_CLI_SCRIPT = 'packages/slicc-cli/sign-and-package.sh';

export const CHROME_PUBLISH_CMD = 'npm run publish:chrome';

export const BIOME_JSH_PUBLISH_CMD =
  'npm publish packages/dev-tools/biome-jsh --provenance --access public';

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

export function decideSliccCliGating({ lastTag, changedFiles = [] } = {}) {
  if (isFirstRelease(lastTag)) {
    return { sliccCli: true, firstRelease: true };
  }
  return {
    sliccCli: changedFiles.some((f) => matchesAnyPrefix(f, SLICC_CLI_PATH_PREFIXES)),
    firstRelease: false,
  };
}

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

export function isRoutesReconcileOnlyFailure(output) {
  const text = typeof output === 'string' ? output : '';
  const scriptUploaded = /Uploaded [\w.-]+ \([\d.]+ sec\)/i.test(text);
  const routesReconcileFailed =
    /A request to the Cloudflare API \([^)]*workers\/routes\) failed/i.test(text);
  return scriptUploaded && routesReconcileFailed;
}

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

export function buildKnownGoodPointer(version) {
  const v = (typeof version === 'string' ? version : '').trim().replace(/^v/, '');
  if (!v) throw new Error('buildKnownGoodPointer: a non-empty version is required');
  return { version: v };
}

export const KNOWN_GOOD_MACOS_PATH = fileURLToPath(
  new URL('../../cloudflare-worker/src/known-good-macos.json', import.meta.url)
);

function writeKnownGoodPointer(version, targetPath = KNOWN_GOOD_MACOS_PATH) {
  const pointer = buildKnownGoodPointer(version);
  writeFileSync(targetPath, `{ "version": ${JSON.stringify(pointer.version)} }\n`);
  return pointer;
}

export const BIOME_JSH_PKG_JSON_PATH = fileURLToPath(
  new URL('../biome-jsh/package.json', import.meta.url)
);

export function buildBiomeJshManifest(manifest, version) {
  const v = (typeof version === 'string' ? version : '').trim().replace(/^v/, '');
  if (!v) throw new Error('buildBiomeJshManifest: a non-empty version is required');
  return { ...manifest, version: v };
}

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

export const NON_GATING_STEP_TIMEOUT_MS = 25 * 60 * 1000;

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

function runNativeGate(args, changedFiles) {
  const decision = decideGating({ lastTag: args.last, changedFiles });

  if (decision.firstRelease) {
    console.log('[release-native] First release (no previous tag) — building both native targets.');
  } else {
    console.log(`[release-native] Changed since ${args.last}: ${changedFiles.length} file(s).`);
  }

  if (decision.macos) {
    runStep('macOS (Sliccstart DMG + update ZIP)', MACOS_SCRIPT_CMD, args.dryRun);

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
