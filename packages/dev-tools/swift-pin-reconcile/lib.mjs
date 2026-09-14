export const SWIFT_PIN_LABEL = 'swift-pin';

export function githubRepoFromUrl(url) {
  const m = String(url ?? '').match(/github\.com\/([^/]+)\/([^/\s]+)/i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, '');
  return {
    owner,
    repo,
    identity: repo.toLowerCase(),
    key: `${owner.toLowerCase()}/${repo.toLowerCase()}`,
  };
}

export function parseSemver(version) {
  const m = String(version ?? '')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: version };
}

export function cmpSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

export function maxVersion(a, b) {
  if (!a) return b;
  if (!b) return a;
  return cmpSemver(a, b) >= 0 ? a : b;
}

export function rangeContains(requirement, version) {
  if (!requirement) return false;
  const v = parseSemver(version);
  const floor = parseSemver(requirement.version);
  if (!v || !floor) return false;
  const cmp = cmpSemver(version, requirement.version);
  switch (requirement.kind) {
    case 'exact':
      return cmp === 0;
    case 'from':
    case 'upToNextMajor':
      return cmp >= 0 && v.major < floor.major + 1;
    case 'upToNextMinor':
      return cmp >= 0 && v.major === floor.major && v.minor < floor.minor + 1;
    default:
      return false;
  }
}

const YML_SKIP_LINE = '(?:\\r?\\n(?:\\1[ \\t]+(?:#.*|<<:\\s*\\S+|&\\S.*)|\\1[ \\t]*))*';
const PROJECT_PIN_RE = new RegExp(
  `(?:^|\\n)([ \\t]*)([A-Za-z0-9._-]+):[^\\n]*${YML_SKIP_LINE}\\r?\\n\\1[ \\t]+url:\\s*(https://github\\.com/[^\\s]+)${YML_SKIP_LINE}\\r?\\n\\1[ \\t]+(exactVersion|minorVersion):\\s*(\\S+)`,
  'g'
);

export function parseProjectYmlPins(text, path = 'project.yml') {
  const pins = [];
  const src = String(text ?? '');
  for (const m of src.matchAll(PROJECT_PIN_RE)) {
    const repo = githubRepoFromUrl(m[3]);
    if (!repo) continue;
    pins.push({
      ...repo,
      ymlName: m[2],
      kind: m[4],
      version: m[5],
      path,
      match: m[0].replace(/^\n/, ''),
    });
  }
  return pins;
}

const PACKAGE_PIN_RE =
  /\.package\s*\(\s*url:\s*"([^"]+)"\s*,\s*(?:\.upToNextMajor\s*\(\s*from:\s*"([^"]+)"\s*\)|\.upToNextMinor\s*\(\s*from:\s*"([^"]+)"\s*\)|exact:\s*"([^"]+)"|from:\s*"([^"]+)")/g;

export function parsePackageSwiftPins(text, path = 'Package.swift') {
  const pins = [];
  const src = String(text ?? '');
  for (const m of src.matchAll(PACKAGE_PIN_RE)) {
    const repo = githubRepoFromUrl(m[1]);
    if (!repo) continue;
    let kind;
    let version;
    if (m[2]) {
      kind = 'upToNextMajor';
      version = m[2];
    } else if (m[3]) {
      kind = 'upToNextMinor';
      version = m[3];
    } else if (m[4]) {
      kind = 'exact';
      version = m[4];
    } else {
      kind = 'from';
      version = m[5];
    }
    pins.push({
      ...repo,
      kind,
      version,
      path,
      match: m[0],
    });
  }
  return pins;
}

export function parsePackageResolvedPins(text, path = 'Package.resolved') {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return [];
  }
  const pins = [];
  for (const pin of parsed?.pins ?? []) {
    const location = pin?.location ?? '';
    const repo = githubRepoFromUrl(location);
    const version = pin?.state?.version;
    if (!repo || version == null) continue;
    pins.push({
      ...repo,
      identity: pin.identity ?? repo.identity,
      version,
      revision: pin.state?.revision ?? null,
      path,
    });
  }
  return pins;
}

export function dualPinKeys({ projectPins, swiftPins }) {
  const projectKeys = new Set((projectPins ?? []).map((p) => p.key));
  const keys = new Set();
  for (const pin of swiftPins ?? []) {
    if (projectKeys.has(pin.key)) keys.add(pin.key);
  }
  return keys;
}

export function collectDualPins({ projectPins, swiftPins }) {
  const dualKeys = dualPinKeys({ projectPins, swiftPins });
  const seen = new Set();
  const dualPins = [];
  for (const pin of projectPins ?? []) {
    if (!dualKeys.has(pin.key)) continue;
    const alias = `${pin.key}\0${(pin.ymlName ?? '').toLowerCase()}`;
    if (seen.has(alias)) continue;
    seen.add(alias);
    dualPins.push(pin);
  }
  return dualPins;
}

export function findMismatches({ projectPins = [], swiftPins = [], resolvedPins = [] }) {
  const keys = dualPinKeys({ projectPins, swiftPins });
  const mismatches = [];
  for (const key of keys) {
    const project = projectPins.filter((p) => p.key === key);
    const swift = swiftPins.filter((p) => p.key === key);
    const resolved = resolvedPins.filter((p) => p.key === key);
    const sample = project[0] ?? swift[0];
    const targetVersion = [...project, ...swift].map((p) => p.version).reduce(maxVersion, null);
    if (!targetVersion) continue;

    const exactPin = [...project, ...swift].some(
      (p) => p.kind === 'exactVersion' || p.kind === 'exact'
    );
    const projectEdits = project.filter((p) => p.version !== targetVersion);
    const swiftEdits = swift.filter((p) => !rangeContains(p, targetVersion));

    const resolvedEdits = exactPin ? resolved.filter((p) => p.version !== targetVersion) : [];

    if (projectEdits.length === 0 && swiftEdits.length === 0 && resolvedEdits.length === 0) {
      continue;
    }
    mismatches.push({
      key,
      owner: sample.owner,
      repo: sample.repo,
      identity: sample.identity,
      targetVersion,
      needsRevision: exactPin && resolvedEdits.length > 0,
      projectEdits,
      swiftEdits,
      resolvedEdits,
    });
  }
  return mismatches.sort((a, b) => a.key.localeCompare(b.key));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bumpQuotedVersion(snippet, from, to) {
  const re = new RegExp(`"${escapeRegExp(from)}"`, 'g');
  return snippet.replace(re, `"${to}"`);
}

function bumpProjectVersion(snippet, from, to) {
  const re = new RegExp(`((?:exactVersion|minorVersion):\\s*)${escapeRegExp(from)}\\b`);
  return snippet.replace(re, `$1${to}`);
}

function updateResolvedPin(text, { identity, from, to, revision }) {
  const ident = escapeRegExp(identity);
  const fromVer = escapeRegExp(from);
  const re = new RegExp(
    `("identity"\\s*:\\s*"${ident}"[\\s\\S]*?"revision"\\s*:\\s*")[^"]+("[\\s\\S]*?"version"\\s*:\\s*")${fromVer}(")`
  );
  if (revision) {
    return text.replace(re, `$1${revision}$2${to}$3`);
  }
  const verOnly = new RegExp(
    `("identity"\\s*:\\s*"${ident}"[\\s\\S]*?"version"\\s*:\\s*")${fromVer}(")`
  );
  return text.replace(verOnly, `$1${to}$2`);
}

export function applyMismatches(fileContents, mismatches, revisionsByKey = {}) {
  const next = { ...fileContents };
  const changed = {};
  for (const mismatch of mismatches ?? []) {
    for (const edit of mismatch.projectEdits) {
      const current = next[edit.path];
      if (current == null) continue;
      const updated = current.replace(
        edit.match,
        bumpProjectVersion(edit.match, edit.version, mismatch.targetVersion)
      );
      next[edit.path] = updated;
    }
    for (const edit of mismatch.swiftEdits) {
      const current = next[edit.path];
      if (current == null) continue;
      const updated = current.replace(
        edit.match,
        bumpQuotedVersion(edit.match, edit.version, mismatch.targetVersion)
      );
      next[edit.path] = updated;
    }
    const revision = revisionsByKey[mismatch.key] ?? revisionsByKey[mismatch.identity];
    for (const edit of mismatch.resolvedEdits) {
      const current = next[edit.path];
      if (current == null) continue;
      next[edit.path] = updateResolvedPin(current, {
        identity: edit.identity,
        from: edit.version,
        to: mismatch.targetVersion,
        revision,
      });
    }
  }
  for (const [path, text] of Object.entries(next)) {
    if (text !== fileContents[path]) changed[path] = text;
  }
  return changed;
}

export function requiredRenovateNames(pin) {
  const names = [`${pin.owner}/${pin.repo}`];
  const ymlName = pin.ymlName?.trim();
  if (ymlName && !names.some((n) => n.toLowerCase() === ymlName.toLowerCase())) {
    names.push(ymlName);
  }
  return names;
}

export function extraRenovateNames(pin) {
  return [pin.repo];
}

export function checkRenovateSwiftPinSync({ dualPins, renovate }) {
  const problems = [];
  const pins = dualPins ?? [];
  const rules = (renovate?.packageRules ?? []).filter((r) =>
    (r.addLabels ?? []).includes(SWIFT_PIN_LABEL)
  );
  if (pins.length === 0) {
    if (rules.length > 0) {
      problems.push(
        `renovate.json has ${rules.length} "${SWIFT_PIN_LABEL}" rule(s) but no GitHub package is dual-pinned in project.yml + Package.swift — remove the rule(s).`
      );
    }
    return problems;
  }
  if (rules.length === 0) {
    const names = pins.map((p) => `${p.owner}/${p.repo}`).join(', ');
    problems.push(
      `renovate.json has no packageRule that addLabels "${SWIFT_PIN_LABEL}", but these GitHub packages are dual-pinned in project.yml + Package.swift: ${names}. Add the label so renovate-swift-pin-reconcile.yml fires.`
    );
    return problems;
  }
  const listed = new Set();
  for (const rule of rules) {
    for (const name of rule.matchPackageNames ?? []) {
      listed.add(String(name).toLowerCase());
    }
  }
  const missing = [];
  const missingSeen = new Set();
  for (const pin of pins) {
    for (const name of requiredRenovateNames(pin)) {
      const lower = name.toLowerCase();
      if (listed.has(lower) || missingSeen.has(lower)) continue;
      missingSeen.add(lower);
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    problems.push(
      `renovate.json "${SWIFT_PIN_LABEL}" rules are missing matchPackageNames for dual-pinned GitHub packages: ${missing.join(', ')}.`
    );
  }
  return problems;
}

export function commitShaFromTagRef(refJson, tagJson) {
  const obj = refJson?.object;
  if (!obj) return null;
  if (obj.type === 'tag') return tagJson?.object?.sha ?? null;
  return obj.sha ?? null;
}

export function describeMismatch(mismatch) {
  const bits = [];
  for (const e of mismatch.projectEdits) {
    bits.push(`${e.path} ${e.kind} ${e.version} → ${mismatch.targetVersion}`);
  }
  for (const e of mismatch.swiftEdits) {
    bits.push(`${e.path} ${e.kind} ${e.version} → ${mismatch.targetVersion}`);
  }
  for (const e of mismatch.resolvedEdits) {
    bits.push(`${e.path} resolved ${e.version} → ${mismatch.targetVersion}`);
  }
  return `${mismatch.key}: ${bits.join('; ')}`;
}
