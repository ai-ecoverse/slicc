// Regression tests for the UI-test-runner init-failure retry guard
// (swift-coverage-runner-retry.sh, sourced by swift-coverage-check.sh).
// Drives the sourced function with a stub command so no xcodebuild or
// simulator is involved: a matching first failure retries exactly once, a
// non-matching failure exits immediately with its status preserved, and a
// second matching failure is not retried again.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, 'swift-coverage-runner-retry.sh');

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
