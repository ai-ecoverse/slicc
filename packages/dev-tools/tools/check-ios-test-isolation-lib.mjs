// Pure helpers for the ios-app test-isolation gate.
//
// Both ios-app bundles run serially: simulator clones race the XCUITest
// runner's install, and the clone that loses fails preflight with "Busy"
// before a test runs (see project.yml). What stands in for parallel isolation
// is therefore (a) random execution order, which makes an order-dependent test
// fail rather than pass by luck, and (b) per-test state — no test may write to
// the state the whole bundle shares. Both are easy to drop silently: (a) is one
// line in a generated project file nobody reads, and (b) is one convenient
// `UserDefaults.standard.set` away.
//
// No fs, no network — callers pass file contents in.

/** Mutating `UserDefaults.standard` members. Reads are fine; writes are not. */
const SHARED_DEFAULTS_MUTATORS = [
  'set',
  'setValue',
  'register',
  'removeObject',
  'removePersistentDomain',
  'setPersistentDomain',
];

const SHARED_DEFAULTS_MUTATION = new RegExp(
  `UserDefaults\\.standard\\s*\\.\\s*(${SHARED_DEFAULTS_MUTATORS.join('|')})\\s*\\(`
);

const indentOf = (line) => line.length - line.trimStart().length;

const carriesContent = (line) => line.trim() !== '' && !line.trim().startsWith('#');

function parseBool(raw) {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (['true', 'yes', 'on'].includes(value)) return true;
  if (['false', 'no', 'off'].includes(value)) return false;
  return null;
}

/**
 * The raw lines of a scheme test action's `targets:` sequence, indentation
 * intact.
 *
 * Walks the fixed nesting XcodeGen documents (`schemes:` → scheme → `test:` →
 * `targets:`) rather than pulling in a YAML dependency, which these gates do
 * without. Staying anchored on `schemes:` matters because `SliccFollower` names
 * both a build target and the scheme, and the build action has a `targets:` key
 * of its own.
 */
function schemeTestTargetLines(yaml, schemeName) {
  const collected = [];
  let inSchemes = false;
  let inScheme = false;
  let inTestAction = false;
  let inTargets = false;

  for (const line of String(yaml ?? '').split('\n')) {
    if (!carriesContent(line)) continue;
    const indent = indentOf(line);
    const trimmed = line.trim();

    if (indent === 0) {
      inSchemes = trimmed === 'schemes:';
      inScheme = false;
      inTestAction = false;
      inTargets = false;
    } else if (!inSchemes) {
    } else if (indent === 2) {
      // A sibling scheme ends this one.
      inScheme = trimmed === `${schemeName}:`;
      inTestAction = false;
      inTargets = false;
    } else if (!inScheme) {
    } else if (indent === 4) {
      inTestAction = trimmed === 'test:';
      inTargets = false;
    } else if (!inTestAction) {
    } else if (indent === 6) {
      // Any other key of the test action (`coverageTargets:`, …) ends the list.
      inTargets = trimmed === 'targets:';
    } else if (inTargets) {
      collected.push(line);
    }
  }
  return collected;
}

/** `parallelizable` / `randomExecutionOrder` off one `key: value` line. */
function applyTargetAttribute(target, trimmed) {
  const [, key, value] = trimmed.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/) ?? [];
  if (key === 'parallelizable') target.parallelizable = parseBool(value);
  if (key === 'randomExecutionOrder') target.randomExecutionOrder = parseBool(value);
}

/**
 * The test targets of a XcodeGen scheme, with the two isolation-relevant
 * attributes each declares (`null` when a target says nothing about one).
 *
 * @returns {{name: string, parallelizable: boolean|null, randomExecutionOrder: boolean|null}[]}
 */
export function parseSchemeTestTargets(yaml, schemeName) {
  const targets = [];
  let sequenceIndent = null;

  for (const line of schemeTestTargetLines(yaml, schemeName)) {
    const indent = indentOf(line);
    const trimmed = line.trim();

    if (trimmed.startsWith('- ')) {
      const item = trimmed.slice(2).trim();
      sequenceIndent = indent;
      targets.push({
        name: item.match(/^name:\s*(\S+)/)?.[1] ?? item,
        parallelizable: null,
        randomExecutionOrder: null,
      });
      continue;
    }

    const current = targets.at(-1);
    if (current && sequenceIndent !== null && indent > sequenceIndent) {
      applyTargetAttribute(current, trimmed);
    }
  }
  return targets;
}

/**
 * Every test target must declare random execution order while it is serial:
 * that is the only thing making an order-dependent test fail rather than pass
 * by luck on the machine that happened to run it in a friendly order.
 */
export function checkRandomExecutionOrder(targets, { schemePath }) {
  if (targets.length === 0) {
    return [`${schemePath}: found no test targets in the scheme's test action`];
  }
  const problems = [];
  for (const target of targets) {
    if (target.randomExecutionOrder === true) continue;
    const state = target.randomExecutionOrder === null ? 'does not declare' : 'disables';
    problems.push(
      `${schemePath}: test target ${target.name} ${state} randomExecutionOrder — ` +
        'the bundle runs serially, so random order is what enforces test independence'
    );
  }
  return problems;
}

/**
 * A test may not write to `UserDefaults.standard`. Inside the unit bundle that
 * is the host app's own persistent domain: shared by every test in the bundle
 * and kept on disk in the simulator container, so a write outlives both the
 * test and the run. `makeIsolatedDefaults` hands out a per-test suite instead.
 *
 * @param {{path: string, source: string}[]} files
 */
export function findSharedDefaultsMutations(files) {
  const problems = [];
  for (const { path, source } of files) {
    source.split('\n').forEach((line, index) => {
      if (!SHARED_DEFAULTS_MUTATION.test(line)) return;
      problems.push(
        `${path}:${index + 1}: writes to UserDefaults.standard — ` +
          'use makeIsolatedDefaults(flags:) so the value cannot outlive this test'
      );
    });
  }
  return problems;
}
