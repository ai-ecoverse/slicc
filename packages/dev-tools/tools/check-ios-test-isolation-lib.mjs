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
      inScheme = trimmed === `${schemeName}:`;
      inTestAction = false;
      inTargets = false;
    } else if (!inScheme) {
    } else if (indent === 4) {
      inTestAction = trimmed === 'test:';
      inTargets = false;
    } else if (!inTestAction) {
    } else if (indent === 6) {
      inTargets = trimmed === 'targets:';
    } else if (inTargets) {
      collected.push(line);
    }
  }
  return collected;
}

function applyTargetAttribute(target, trimmed) {
  const [, key, value] = trimmed.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/) ?? [];
  if (key === 'parallelizable') target.parallelizable = parseBool(value);
  if (key === 'randomExecutionOrder') target.randomExecutionOrder = parseBool(value);
}

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
