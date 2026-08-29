import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTestIndex, skipArgs, validate } from './ios-ui-test-exclusions.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/ios-ui-test-exclusions.mjs');
const uiTestDir = resolve(repoRoot, 'packages/ios-app/SliccFollower/Tests/SliccFollowerUITests');

const REASON = 'A reason long enough to be a real explanation of the exclusion.';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ios-ui-test-exclusions-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a Swift UI test file into the scratch bundle directory. */
function swiftFile(name, body) {
  mkdirSync(join(tmpDir, 'bundle'), { recursive: true });
  writeFileSync(join(tmpDir, 'bundle', name), body);
}

describe('readTestIndex', () => {
  it('indexes every XCTestCase and its test methods', () => {
    swiftFile(
      'DockUITests.swift',
      `import XCTest\nfinal class DockUITests: XCTestCase {\n  func testRailShows() {}\n  func testRailHides() {}\n  private func helper() {}\n}\n`
    );
    const index = readTestIndex(join(tmpDir, 'bundle'));
    expect(Object.keys(index)).toEqual(['DockUITests']);
    expect([...index.DockUITests]).toEqual(['testRailShows', 'testRailHides']);
  });

  it('ignores non-Swift files sitting in the bundle directory', () => {
    swiftFile('DockUITests.swift', `final class DockUITests: XCTestCase { func testA() {} }`);
    writeFileSync(join(tmpDir, 'bundle', 'README.md'), 'final class FakeUITests: XCTestCase {}');
    expect(Object.keys(readTestIndex(join(tmpDir, 'bundle')))).toEqual(['DockUITests']);
  });

  it('finds every class in the real bundle, which is what the gate checks against', () => {
    const index = readTestIndex(uiTestDir);
    expect(Object.keys(index).length).toBeGreaterThan(20);
    expect(index).toHaveProperty('FixtureConversationUITests');
    expect([...index.FixtureConversationUITests]).toContain(
      'testEveryFixtureMessageVariantRenders'
    );
  });
});

describe('validate', () => {
  const index = { DockUITests: new Set(['testRailShows']) };

  it('accepts a class-level entry with a reason', () => {
    expect(validate({ exclusions: [{ test: 'DockUITests', reason: REASON }] }, index)).toEqual([]);
  });

  it('accepts a single-method entry', () => {
    expect(
      validate({ exclusions: [{ test: 'DockUITests/testRailShows', reason: REASON }] }, index)
    ).toEqual([]);
  });

  it('rejects a class that no longer exists — a stale exclusion suppresses nothing', () => {
    const problems = validate({ exclusions: [{ test: 'DeletedUITests', reason: REASON }] }, index);
    expect(problems).toEqual([
      'DeletedUITests: no XCTestCase named DeletedUITests in SliccFollowerUITests — stale exclusion, delete it',
    ]);
  });

  it('rejects a method that no longer exists on a class that does', () => {
    const problems = validate(
      { exclusions: [{ test: 'DockUITests/testRenamed', reason: REASON }] },
      index
    );
    expect(problems).toEqual([
      'DockUITests/testRenamed: DockUITests has no testRenamed — stale exclusion, delete it',
    ]);
  });

  it('rejects an entry with no reason, so opting out of CI stays a written decision', () => {
    expect(validate({ exclusions: [{ test: 'DockUITests' }] }, index)).toEqual([
      'DockUITests: needs a `reason` explaining why CI cannot run it',
    ]);
  });

  it('rejects a hand-wavy reason', () => {
    expect(validate({ exclusions: [{ test: 'DockUITests', reason: 'flaky' }] }, index)).toEqual([
      'DockUITests: needs a `reason` explaining why CI cannot run it',
    ]);
  });

  it('rejects a duplicate spec', () => {
    const problems = validate(
      {
        exclusions: [
          { test: 'DockUITests', reason: REASON },
          { test: 'DockUITests', reason: REASON },
        ],
      },
      index
    );
    expect(problems).toContain('DockUITests: listed more than once');
  });

  it('rejects a spec deeper than Class/testMethod', () => {
    const problems = validate(
      { exclusions: [{ test: 'SliccFollowerUITests/DockUITests/testRailShows', reason: REASON }] },
      index
    );
    expect(problems).toEqual([
      'SliccFollowerUITests/DockUITests/testRailShows: expected "Class" or "Class/testMethod", not a longer path',
    ]);
  });

  it('rejects a registry with no exclusions array at all', () => {
    expect(validate({}, index)).toEqual(['ui-test-exclusions.json has no `exclusions` array']);
  });
});

describe('skipArgs', () => {
  it('qualifies every spec with the bundle name xcodebuild expects', () => {
    expect(
      skipArgs({ exclusions: [{ test: 'DockUITests' }, { test: 'DockUITests/testRailShows' }] })
    ).toEqual([
      'SliccFollowerUITests/DockUITests',
      'SliccFollowerUITests/DockUITests/testRailShows',
    ]);
  });

  it('returns nothing for an empty registry, so the CI step passes no -skip-testing', () => {
    expect(skipArgs({ exclusions: [] })).toEqual([]);
  });
});

describe('as an entry script', () => {
  function run(...args) {
    try {
      return { code: 0, out: execFileSync('node', [scriptPath, ...args], { encoding: 'utf8' }) };
    } catch (err) {
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  it('validates the registry checked into this repo', () => {
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain('ios-ui-test-exclusions: ok');
  });

  it('prints one bundle-qualified spec per line for the CI step to read', () => {
    const { code, out } = run('--print-skip-args');
    expect(code).toBe(0);
    const lines = out.trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.startsWith('SliccFollowerUITests/')).toBe(true);
  });
});
