// Pure helpers for the patch-package reconciliation tooling.
//
// patch-package patches are version-pinned by filename
// (`<pkg>+<version>.patch`, scoped packages encode the scope slash as `+`).
// When Renovate bumps a patched dependency, the installed version moves past
// the patch's pinned version and the fix silently stops applying. These helpers
// detect that drift deterministically (the orphaned-patch guard) and surface
// the metadata the reconcile workflow needs. No side effects — callers read the
// files and pass the parsed values in, so this stays unit-testable.

/**
 * Parse a patch-package filename into `{ pkg, version }`.
 *
 * `@zenfs+core+2.5.6.patch` → `{ pkg: '@zenfs/core', version: '2.5.6' }`
 * `just-bash+3.0.1.patch`   → `{ pkg: 'just-bash', version: '3.0.1' }`
 * Sequenced patches (`pkg+1.2.3+001+note.patch`) resolve to the first
 * semver-shaped segment as the version and everything before it as the package.
 * Returns `null` if no version segment is found.
 */
export function parsePatchFilename(filename) {
  const base = filename.replace(/\.patch$/, '');
  const parts = base.split('+');
  const verIdx = parts.findIndex((p) => /^\d+\.\d+\.\d+/.test(p));
  if (verIdx <= 0) return null;
  return { pkg: parts.slice(0, verIdx).join('/'), version: parts[verIdx] };
}

/**
 * Installed version of `pkg` from a parsed npm lockfile (v3), or `null` if
 * absent. Prefers the top-level/hoisted `node_modules/<pkg>` entry, then falls
 * back to any nested copy (`.../node_modules/<parent>/node_modules/<pkg>`) so a
 * transitive or non-hoisted patched dependency isn't a false "not in lockfile".
 */
export function lockedVersion(lock, pkg) {
  const packages = lock?.packages ?? {};
  const top = `node_modules/${pkg}`;
  if (packages[top]?.version != null) return packages[top].version;
  for (const [key, val] of Object.entries(packages)) {
    if ((key === top || key.endsWith(`/${top}`)) && val?.version != null) return val.version;
  }
  return null;
}

/** Manifest entries are real packages; skip the leading `//` comment key. */
function manifestPackages(manifest) {
  return Object.keys(manifest ?? {}).filter((k) => k !== '//');
}

/** The npm package names listed in the Renovate "patched dependencies" rule. */
export const PATCHED_GROUP_NAME = 'patched dependencies';

/**
 * Assert the Renovate "patched dependencies" rule's `matchPackageNames` matches
 * the manifest exactly. Without this the list is a silent manual contract: forget
 * to add a newly-patched package and Renovate won't group/label its bump, so the
 * auto-reconcile workflow (gated on the `patched-dependency` label) never fires
 * AND the bump can automerge under the broader non-major rule. Returns problems.
 */
export function checkRenovateSync({ manifest, renovate }) {
  const problems = [];
  const pkgs = manifestPackages(manifest);
  const rule = (renovate?.packageRules ?? []).find((r) => r.groupName === PATCHED_GROUP_NAME);

  if (pkgs.length === 0) {
    if (rule && (rule.matchPackageNames?.length ?? 0) > 0) {
      problems.push(
        `renovate.json "${PATCHED_GROUP_NAME}" rule lists ${rule.matchPackageNames.join(', ')} but patches/patches.json documents no packages — remove the rule or the entries.`
      );
    }
    return problems;
  }
  if (!rule) {
    problems.push(
      `renovate.json has no packageRule with groupName "${PATCHED_GROUP_NAME}", but patches/patches.json documents: ${pkgs.join(', ')}. Add the rule so bumps are grouped, labeled, and reconciled (see patches/README.md).`
    );
    return problems;
  }
  const ruleSet = new Set(rule.matchPackageNames ?? []);
  const manSet = new Set(pkgs);
  const missing = pkgs.filter((p) => !ruleSet.has(p));
  const extra = [...ruleSet].filter((p) => !manSet.has(p));
  if (missing.length) {
    problems.push(
      `renovate.json "${PATCHED_GROUP_NAME}" rule is missing ${missing.join(', ')} (documented in patches/patches.json). Add them or their bumps skip the reconcile workflow and may automerge.`
    );
  }
  if (extra.length) {
    problems.push(
      `renovate.json "${PATCHED_GROUP_NAME}" rule lists ${extra.join(', ')} with no patches/patches.json entry. Remove them or document the patch.`
    );
  }
  return problems;
}

/**
 * Validate every patch file against the manifest and the lockfile.
 *
 * Returns `{ problems, notes, checked }`. `problems` is non-empty when the
 * caller should fail (CI guard exits non-zero):
 *   - a patch file with no `patches.json` entry (undocumented patch),
 *   - a manifest `patchedVersion` that disagrees with the patch filename,
 *   - a patch whose package is absent from the lockfile,
 *   - an ORPHANED patch — lockfile version moved past the patch version
 *     (the Renovate-bump tripwire).
 * `notes` are non-blocking (e.g. a manifest entry whose patch file is absent,
 * which is fine while a patch lands in a separate PR or was just removed).
 */
export function checkPatches({ patchFiles, manifest, lock }) {
  const problems = [];
  const notes = [];
  const checked = [];

  for (const file of patchFiles) {
    const parsed = parsePatchFilename(file);
    if (!parsed) {
      problems.push(`${file}: cannot parse a package + version from the filename.`);
      continue;
    }
    const { pkg, version } = parsed;
    const entry = manifest?.[pkg];
    if (!entry) {
      problems.push(
        `${file}: no entry in patches/patches.json for "${pkg}". Document the patch (upstream, removeWhen, verify) so it can be reconciled on a dependency bump.`
      );
    } else if (entry.patchedVersion !== version) {
      problems.push(
        `${file}: patches.json["${pkg}"].patchedVersion="${entry.patchedVersion}" disagrees with the patch filename version ${version}. Keep them in sync.`
      );
    }

    const locked = lockedVersion(lock, pkg);
    if (locked == null) {
      problems.push(`${file}: "${pkg}" is not in package-lock.json (node_modules/${pkg}).`);
    } else if (locked !== version) {
      problems.push(
        `${file}: ORPHANED — patch is for ${pkg}@${version} but package-lock.json has ${pkg}@${locked}. ` +
          `A dependency bump moved past the patch, so the fix no longer applies. Either the upstream fix landed (remove the patch + its patches.json entry) or it is still needed (regenerate the patch for ${locked}). ` +
          `See patches/patches.json["${pkg}"].removeWhen.`
      );
    } else {
      checked.push(`${pkg}@${version}`);
    }
  }

  for (const pkg of manifestPackages(manifest)) {
    const hasFile = patchFiles.some((f) => parsePatchFilename(f)?.pkg === pkg);
    if (!hasFile) {
      notes.push(
        `patches.json lists "${pkg}" but no patch file is present — patch removed, or pending in another PR.`
      );
    }
  }

  return { problems, notes, checked };
}

/**
 * Build the reconcile context for a workflow: the patches that are ORPHANED
 * relative to the current lockfile, each annotated with its manifest metadata.
 * The workflow runs this after `npm ci` (so the lockfile reflects the bumped
 * version) to tell Claude exactly which patch to regenerate-or-remove and how.
 */
export function orphanedPatches({ patchFiles, manifest, lock }) {
  const out = [];
  for (const file of patchFiles) {
    const parsed = parsePatchFilename(file);
    if (!parsed) continue;
    const { pkg, version } = parsed;
    const locked = lockedVersion(lock, pkg);
    if (locked != null && locked !== version) {
      const entry = manifest?.[pkg] ?? {};
      out.push({
        pkg,
        patchFile: `patches/${file}`,
        patchedVersion: version,
        installedVersion: locked,
        upstream: entry.upstream ?? null,
        issue: entry.issue ?? null,
        reason: entry.reason ?? null,
        removeWhen: entry.removeWhen ?? null,
        verify: entry.verify ?? null,
      });
    }
  }
  return out;
}
