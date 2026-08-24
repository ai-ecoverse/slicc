// Pure helpers for SPM ↔ XcodeGen pin reconciliation.
//
// A GitHub package that appears in both a xcodegen `project.yml` (exactVersion
// / minorVersion) and a `Package.swift` must describe overlapping versions.
// Renovate's swift manager and the project.yml regex customManager historically
// opened *two* PRs for the same bump (PRs #2320 / #2348): one moved
// Package.swift to 151 while the other moved project.yml, and SPM failed with
// "depends on webrtc 151 and root depends on webrtc 150".
//
// These helpers detect that drift and apply a one-way raise to the higher
// version already present in the tree. No network, no fs — callers pass parsed
// file contents in.

export const SWIFT_PIN_LABEL = 'swift-pin';

/** Last path component, lowercased — matches Package.resolved `identity`. */
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

/**
 * Does `version` satisfy a Package.swift requirement?
 * `kind` is `upToNextMajor` | `upToNextMinor` | `exact` | `from`.
 */
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
      return cmp >= 0;
    case 'upToNextMajor':
      return cmp >= 0 && v.major < floor.major + 1;
    case 'upToNextMinor':
      return cmp >= 0 && v.major === floor.major && v.minor < floor.minor + 1;
    default:
      return false;
  }
}

const PROJECT_PIN_RE =
  /url:\s*(https:\/\/github\.com\/[^\s]+)\r?\n[ \t]+(exactVersion|minorVersion):\s*(\S+)/g;

/** Pins from a xcodegen `project.yml`. */
export function parseProjectYmlPins(text, path = 'project.yml') {
  const pins = [];
  const src = String(text ?? '');
  for (const m of src.matchAll(PROJECT_PIN_RE)) {
    const repo = githubRepoFromUrl(m[1]);
    if (!repo) continue;
    pins.push({
      ...repo,
      kind: m[2],
      version: m[3],
      path,
      match: m[0],
    });
  }
  return pins;
}

const PACKAGE_PIN_RE =
  /\.package\s*\(\s*url:\s*"([^"]+)"\s*,\s*(?:\.upToNextMajor\s*\(\s*from:\s*"([^"]+)"\s*\)|\.upToNextMinor\s*\(\s*from:\s*"([^"]+)"\s*\)|exact:\s*"([^"]+)"|from:\s*"([^"]+)")/g;

/** Remote GitHub pins from a `Package.swift`. Path-local packages are ignored. */
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

/** Remote pins from a `Package.resolved` v2/v3 lockfile. */
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

/**
 * Dual-pin identities: GitHub packages that appear in both a project.yml and
 * a Package.swift. Those are the ones a split Renovate PR can make incompatible.
 */
export function dualPinKeys({ projectPins, swiftPins }) {
  const projectKeys = new Set((projectPins ?? []).map((p) => p.key));
  const keys = new Set();
  for (const pin of swiftPins ?? []) {
    if (projectKeys.has(pin.key)) keys.add(pin.key);
  }
  return keys;
}

/**
 * For each dual-pin identity, raise every stale side to the highest version
 * already declared. Never lowers a pin. `resolved` files are only forced to an
 * exact version when a project.yml `exactVersion` (or Package.swift `exact`)
 * is in play — range-style pins (minorVersion / upToNextMinor) may resolve
 * anywhere inside the range.
 */
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
    // Range-style pins (minorVersion / upToNextMinor) may resolve anywhere
    // inside the range; only exact pins force Package.resolved onto targetVersion.
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

/**
 * Apply mismatches to a `{ path: contents }` map. Returns a new map of paths
 * whose contents changed. `revisionsByKey` supplies the git tag SHA for
 * Package.resolved updates that need a new revision (exact pins).
 */
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

/** `owner/repo` as it appears in the GitHub URL — the name Renovate's regex manager uses. */
export function requiredRenovateNames(pin) {
  return [`${pin.owner}/${pin.repo}`];
}

/** Extra names github-releases may register the same pin under. */
export function extraRenovateNames(pin) {
  return [pin.repo];
}

/**
 * Every dual-pin `owner/repo` must appear in a renovate packageRule that adds
 * the `swift-pin` label, otherwise the reconcile workflow never fires and a
 * split bump can automerge into a red PR. Extra names (repo-only aliases) are
 * allowed so grouping still works when github-releases drops the owner prefix.
 */
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
  for (const pin of pins) {
    const required = `${pin.owner}/${pin.repo}`.toLowerCase();
    if (!listed.has(required)) missing.push(`${pin.owner}/${pin.repo}`);
  }
  if (missing.length > 0) {
    problems.push(
      `renovate.json "${SWIFT_PIN_LABEL}" rules are missing matchPackageNames for dual-pinned GitHub packages: ${missing.join(', ')}.`
    );
  }
  return problems;
}

/**
 * Peel a GitHub git-ref + optional annotated-tag payload down to the commit
 * SHA Package.resolved wants. `tagJson` is only needed when `refJson.object.type`
 * is `"tag"`.
 */
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
