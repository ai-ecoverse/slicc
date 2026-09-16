// Regression tests for the shared simulator preparation step
// (ios-sim-prepare.sh, sourced by swift-coverage-check.sh and ios-sim-test.sh).
// A stub `xcrun` on PATH records every call, so no simulator is involved: the
// device has to be booted and waited on BEFORE the containers are erased, and
// a device that never had the app installed must not fail the run.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, 'ios-sim-prepare.sh');

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ios-sim-prepare-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Stub `xcrun` that appends each invocation to a log. `uninstallExit` scripts
 * what `simctl uninstall` returns, and `bootstatusExit` what the boot wait
 * returns, so both failure paths can be driven.
 */
function stubXcrun({ uninstallExit = 0, bootstatusExit = 0 } = {}) {
  const binDir = join(dir, 'bin');
  const log = join(dir, 'xcrun.log');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'xcrun'),
    `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$2" in
  uninstall) exit ${uninstallExit} ;;
  bootstatus) exit ${bootstatusExit} ;;
esac
exit 0
`
  );
  chmodSync(join(binDir, 'xcrun'), 0o755);
  return { binDir, calls: () => readFileSync(log, 'utf8').trim().split('\n') };
}

function prepare(binDir, { strict = true } = {}) {
  const flags = strict ? 'set -euo pipefail;' : '';
  return spawnSync(
    'bash',
    ['-c', `${flags} source ${JSON.stringify(lib)}; prepare_ios_simulator sim-udid`],
    { encoding: 'utf8', env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } }
  );
}

describe('prepare_ios_simulator', () => {
  it('waits for the boot to finish before erasing any container', () => {
    const { binDir, calls } = stubXcrun();
    const res = prepare(binDir);

    expect(res.status, res.stderr).toBe(0);
    expect(calls()).toEqual([
      'simctl boot sim-udid',
      'simctl bootstatus sim-udid -b',
      'simctl uninstall sim-udid com.sliccy.follower',
      'simctl uninstall sim-udid com.sliccy.follower.uitests.xctrunner',
    ]);
  });

  it('erases the unit-test host app and the UI-test runner, not just one', () => {
    const { binDir, calls } = stubXcrun();
    prepare(binDir);
    const uninstalled = calls().filter((call) => call.includes('uninstall'));

    // The unit bundle is hosted in the app, so its UserDefaults.standard is
    // the app's container; the runner keeps its own.
    expect(uninstalled).toHaveLength(2);
  });

  it('tolerates a device that never had the app installed', () => {
    const { binDir, calls } = stubXcrun({ uninstallExit: 1 });
    const res = prepare(binDir);

    expect(res.status, res.stderr).toBe(0);
    expect(calls().filter((call) => call.includes('uninstall'))).toHaveLength(2);
  });

  it('warns but continues when the boot wait does not report a clean boot', () => {
    const { binDir, calls } = stubXcrun({ bootstatusExit: 1 });
    const res = prepare(binDir);

    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('::warning::');
    // The reset still has to happen — a device that booted slowly is exactly
    // the one most likely to be carrying an interrupted run's state.
    expect(calls().filter((call) => call.includes('uninstall'))).toHaveLength(2);
  });
});

describe('callers', () => {
  it('both ios-app test legs prepare the simulator through the shared step', () => {
    for (const script of ['swift-coverage-check.sh', 'ios-sim-test.sh']) {
      const source = readFileSync(resolve(here, script), 'utf8');
      expect(source, script).toContain('source "$SCRIPT_DIR/ios-sim-prepare.sh"');
      expect(source, script).toContain('prepare_ios_simulator "$UDID"');
      // No leg may keep a private copy of the boot wait: that is how the two
      // drifted before, and the reset would be the next thing to diverge.
      expect(source, script).not.toContain('xcrun simctl bootstatus');
    }
  });
});
