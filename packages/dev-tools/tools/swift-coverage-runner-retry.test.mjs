// Regression tests for the UI-test-runner init-failure retry guard
// (swift-coverage-runner-retry.sh, sourced by swift-coverage-check.sh).
// Drives the sourced function with a stub command so no xcodebuild or
// simulator is involved: a matching first failure retries exactly once, a
// non-matching failure exits immediately with its status preserved, and a
// second matching failure is not retried again.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, 'swift-coverage-runner-retry.sh');
const coverageScriptPath = resolve(here, 'swift-coverage-check.sh');
const coverageScript = readFileSync(coverageScriptPath, 'utf8');

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-retry-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Write a stub whose per-attempt behavior is scripted: `outcomes` is one
 * entry per expected invocation, each { output, exit }. The stub counts
 * calls in a file so the test can assert how many attempts ran.
 */
function makeStub(outcomes) {
  const stub = join(dir, 'stub.sh');
  const countFile = join(dir, 'calls');
  writeFileSync(countFile, '0');
  const cases = outcomes
    .map((o, i) => `    ${i + 1}) printf '%s\\n' ${JSON.stringify(o.output)}; exit ${o.exit} ;;`)
    .join('\n');
  writeFileSync(
    stub,
    `#!/bin/bash
n=$(($(cat "${countFile}") + 1))
printf '%s' "$n" > "${countFile}"
case "$n" in
${cases}
    *) echo "unexpected extra invocation $n" >&2; exit 99 ;;
esac
`
  );
  chmodSync(stub, 0o755);
  return { stub, calls: () => Number(readFileSync(countFile, 'utf8')) };
}

function run(stub) {
  const log = join(dir, 'xcodebuild.log');
  const res = spawnSync('bash', [
    '-c',
    `set -uo pipefail; source ${JSON.stringify(lib)}; run_with_runner_init_retry ${JSON.stringify(log)} ${JSON.stringify(stub)}`,
  ]);
  return { status: res.status, stdout: res.stdout.toString() };
}

describe('run_with_runner_init_retry', () => {
  it('retries exactly once when the first failure matches the runner-init signature', () => {
    const { stub, calls } = makeStub([
      { output: 'Timed out while loading Accessibility.', exit: 65 },
      { output: 'Test Suite All tests passed', exit: 0 },
    ]);
    const res = run(stub);
    expect(res.status).toBe(0);
    expect(calls()).toBe(2);
    expect(res.stdout).toContain('simulator infrastructure, not a test failure');
  });

  it('also matches the "failed to initialize for UI testing" phrasing', () => {
    const { stub, calls } = makeStub([
      { output: 'The test runner failed to initialize for UI testing.', exit: 65 },
      { output: 'ok', exit: 0 },
    ]);
    expect(run(stub).status).toBe(0);
    expect(calls()).toBe(2);
  });

  it('also matches the SpringBoard preflight-Busy launch refusal', () => {
    const { stub, calls } = makeStub([
      {
        output:
          'SliccFollowerUITests-Runner encountered an error (Failed to install or launch the test runner. ' +
          '(Underlying Error: The request was denied by service delegate (SBMainWorkspace) for reason: ' +
          'Busy ("Application failed preflight checks").))',
        exit: 65,
      },
      { output: 'ok', exit: 0 },
    ]);
    expect(run(stub).status).toBe(0);
    expect(calls()).toBe(2);
  });

  it('does not retry a permanent install failure (generic wrapper without Busy)', () => {
    const { stub, calls } = makeStub([
      {
        output:
          'Failed to install or launch the test runner. (Underlying Error: ' +
          'The code signature is invalid.)',
        exit: 65,
      },
    ]);
    const res = run(stub);
    expect(res.status).toBe(65);
    expect(calls()).toBe(1);
  });

  it('does not retry a genuine test failure and preserves its exit status', () => {
    const { stub, calls } = makeStub([{ output: "Test Case 'testSomething' failed", exit: 65 }]);
    const res = run(stub);
    expect(res.status).toBe(65);
    expect(calls()).toBe(1);
    expect(res.stdout).not.toContain('re-running');
  });

  it('gives up after one retry, preserving the second exit status', () => {
    const { stub, calls } = makeStub([
      { output: 'Timed out while loading Accessibility.', exit: 65 },
      { output: 'Timed out while loading Accessibility.', exit: 70 },
    ]);
    const res = run(stub);
    expect(res.status).toBe(70);
    expect(calls()).toBe(2);
  });

  it('passes a first-attempt success straight through', () => {
    const { stub, calls } = makeStub([{ output: 'all green', exit: 0 }]);
    expect(run(stub).status).toBe(0);
    expect(calls()).toBe(1);
  });
});

describe('swift-coverage-check xcodebuild invocation', () => {
  it('selects an iPhone from the runtime matching the simulator SDK', () => {
    const devices = {
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-4-1': [
          { isAvailable: true, name: 'iPhone 17 Pro', udid: 'prerelease' },
        ],
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
          { isAvailable: true, name: 'iPhone 17', udid: 'matching' },
        ],
      },
    };
    const result = spawnSync(
      'bash',
      ['-c', `source ${JSON.stringify(coverageScriptPath)}; select_iphone_for_sdk 26.5`],
      { input: JSON.stringify(devices) }
    );
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe('matching');
    expect(coverageScript).toContain('xcrun --sdk iphonesimulator --show-sdk-version');
  });

  it('runs only the unit bundle and keeps simulator code signing enabled', () => {
    expect(coverageScript).toContain('"-only-testing:${TEST_BUNDLE_NAME}Tests"');
    expect(coverageScript).toContain('-parallel-testing-enabled NO');
    expect(coverageScript).not.toContain('CODE_SIGNING_ALLOWED=NO');
  });

  it('discovers linked framework coverage objects without kit-specific names', () => {
    const packageRoot = join(dir, 'ios-app');
    const appDir = join(dir, 'SliccFollower.app');
    const futureKit = join(appDir, 'Frameworks/FutureKit.framework/FutureKit');
    const vendorKit = join(appDir, 'Frameworks/VendorKit.framework/VendorKit');
    mkdirSync(dirname(futureKit), { recursive: true });
    mkdirSync(dirname(vendorKit), { recursive: true });
    writeFileSync(futureKit, 'instrumented local framework');
    writeFileSync(vendorKit, 'linked vendor framework');

    const result = spawnSync('bash', [
      '-c',
      `source ${JSON.stringify(coverageScriptPath)}
configure_xcode_coverage_scope ios-app ${JSON.stringify(packageRoot)} ${JSON.stringify(appDir)}
printf 'objects=%s\\n' "\${COVERAGE_OBJECT_ARGS[*]}"
printf 'arch=%s\\n' "\${COVERAGE_ARCH_ARGS[*]}"
printf 'ignore=%s\\n' "\${COVERAGE_IGNORE_REGEX}"
printf 'sources=%s\\n' "\${COVERAGE_SOURCE_PATHS[*]}"`,
    ]);
    const output = result.stdout.toString();

    expect(result.status).toBe(0);
    expect(output).toContain(`objects=-object ${futureKit} -object ${vendorKit}`);
    expect(output).toContain('arch=-arch ');
    expect(output).toContain('SliccFollower/(Views|CDP)/');
    expect(output).toContain(`sources=${packageRoot}`);
    expect(coverageScript).not.toContain('SliccTrayKit.framework');
  });
});

describe('swift-coverage-check SPM invocation', () => {
  it('reports coverage when optional coverage argument arrays are empty', () => {
    const packageRoot = join(dir, 'spm-package');
    const bundleName = 'FixturePackageTests';
    const coverageDir = join(packageRoot, '.build/coverage');
    const testBinary = join(
      packageRoot,
      `.build/debug/${bundleName}.xctest/Contents/MacOS/${bundleName}`
    );
    const binDir = join(dir, 'bin');
    mkdirSync(dirname(testBinary), { recursive: true });
    mkdirSync(coverageDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(testBinary, 'fixture test binary');
    writeFileSync(join(coverageDir, 'default.profdata'), 'fixture profile');
    writeFileSync(join(binDir, 'swift'), '#!/bin/bash\nexit 0\n');
    writeFileSync(
      join(binDir, 'xcrun'),
      `#!/bin/bash
shift
for arg in "$@"; do
  [[ -n "$arg" ]] || exit 90
done
if [[ "$1" == "report" ]]; then
  echo "TOTAL 1 0 100 1 0 100 1 0 100 1 0 100"
fi
`
    );
    chmodSync(testBinary, 0o755);
    chmodSync(join(binDir, 'swift'), 0o755);
    chmodSync(join(binDir, 'xcrun'), 0o755);

    const result = spawnSync(
      '/bin/bash',
      [coverageScriptPath, packageRoot, bundleName, '0', '0', '0'],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Coverage summary:');
  });
});
