import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkRandomExecutionOrder,
  findSharedDefaultsMutations,
  parseSchemeTestTargets,
} from './check-ios-test-isolation-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const gate = resolve(here, 'check-ios-test-isolation.mjs');
const projectYml = readFileSync(resolve(repoRoot, 'packages/ios-app/project.yml'), 'utf8');

describe('parseSchemeTestTargets', () => {
  it('reads both isolation attributes off the real scheme', () => {
    const targets = parseSchemeTestTargets(projectYml, 'SliccFollower');

    expect(targets.map((t) => t.name)).toEqual(['SliccFollowerTests', 'SliccFollowerUITests']);
    expect(targets.every((t) => t.randomExecutionOrder === true)).toBe(true);
    expect(targets.every((t) => t.parallelizable === false)).toBe(true);
  });

  it('is not fooled by a build target that shares the scheme name', () => {
    const targets = parseSchemeTestTargets(
      `targets:
  SliccFollower:
    type: application
    sources:
      - path: SliccFollower
schemes:
  SliccFollower:
    build:
      targets:
        SliccFollower: all
        SliccFollowerTests: [test]
    test:
      targets:
        - name: SliccFollowerTests
          randomExecutionOrder: true
`,
      'SliccFollower'
    );

    expect(targets).toEqual([
      { name: 'SliccFollowerTests', parallelizable: null, randomExecutionOrder: true },
    ]);
  });

  it('ignores another scheme and the test action siblings around the list', () => {
    const targets = parseSchemeTestTargets(
      `schemes:
  Other:
    test:
      targets:
        - name: OtherTests
          randomExecutionOrder: false
  SliccFollower:
    test:
      gatherCoverageData: true
      coverageTargets:
        - SliccFollower
      targets:
        # a comment inside the list
        - name: SliccFollowerTests
          parallelizable: no
          randomExecutionOrder: yes
      environmentVariables:
        SLICC_IOS_NO_ICLOUD: '1'
`,
      'SliccFollower'
    );

    expect(targets).toEqual([
      { name: 'SliccFollowerTests', parallelizable: false, randomExecutionOrder: true },
    ]);
  });
});

describe('checkRandomExecutionOrder', () => {
  const schemePath = 'packages/ios-app/project.yml';

  it('passes targets that declare random order', () => {
    expect(
      checkRandomExecutionOrder([{ name: 'A', randomExecutionOrder: true }], { schemePath })
    ).toEqual([]);
  });

  it('fails a target that never declares it', () => {
    const [problem] = checkRandomExecutionOrder(
      [{ name: 'SliccFollowerTests', randomExecutionOrder: null }],
      { schemePath }
    );
    expect(problem).toContain('does not declare randomExecutionOrder');
    expect(problem).toContain('SliccFollowerTests');
  });

  it('fails a target that turns it off', () => {
    const [problem] = checkRandomExecutionOrder(
      [{ name: 'SliccFollowerUITests', randomExecutionOrder: false }],
      { schemePath }
    );
    expect(problem).toContain('disables randomExecutionOrder');
  });

  it('fails when the test action lists no targets at all', () => {
    expect(checkRandomExecutionOrder([], { schemePath })).toEqual([
      `${schemePath}: found no test targets in the scheme's test action`,
    ]);
  });
});

describe('findSharedDefaultsMutations', () => {
  it('reports every mutating member with its line', () => {
    const source = [
      'func testSomething() {',
      '    UserDefaults.standard.set(true, forKey: "uiTestSessionsFixture")',
      '    UserDefaults.standard.removeObject(forKey: "uiTestSessionsFixture")',
      '    UserDefaults.standard .removePersistentDomain(forName: suite)',
      '    UserDefaults.standard.register(defaults: ["a": 1])',
      '}',
    ].join('\n');

    const problems = findSharedDefaultsMutations([{ path: 'Tests/A.swift', source }]);

    expect(problems).toHaveLength(4);
    expect(problems[0]).toBe(
      'Tests/A.swift:2: writes to UserDefaults.standard — ' +
        'use makeIsolatedDefaults(flags:) so the value cannot outlive this test'
    );
    expect(problems[3]).toContain('Tests/A.swift:5');
  });

  it('leaves reads and per-test suites alone', () => {
    const source = [
      'let launched = UserDefaults.standard.bool(forKey: "uiTestFixtureRoute")',
      'let name = UserDefaults.standard.string(forKey: "joinUrl")',
      'let defaults = try makeIsolatedDefaults()',
      'defaults.set(true, forKey: "uiTestSessionsFixture")',
      'suite.removePersistentDomain(forName: suiteName)',
    ].join('\n');

    expect(findSharedDefaultsMutations([{ path: 'Tests/B.swift', source }])).toEqual([]);
  });
});

describe('the gate against the repository', () => {
  it('passes, so a shared-domain write or a dropped random order fails CI', () => {
    const res = spawnSync('node', [gate], { encoding: 'utf8' });

    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain('test target(s) in random order');
  });
});
