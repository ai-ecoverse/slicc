export function parsePatchFilename(filename) {
  const base = filename.replace(/\.patch$/, '');
  const parts = base.split('+');
  const verIdx = parts.findIndex((p) => /^\d+\.\d+\.\d+/.test(p));
  if (verIdx <= 0) return null;
  return { pkg: parts.slice(0, verIdx).join('/'), version: parts[verIdx] };
}

export function lockedVersion(lock, pkg) {
  const packages = lock?.packages ?? {};
  const top = `node_modules/${pkg}`;
  if (packages[top]?.version != null) return packages[top].version;
  for (const [key, val] of Object.entries(packages)) {
    if ((key === top || key.endsWith(`/${top}`)) && val?.version != null) return val.version;
  }
  return null;
}

export function declaredVersion(packageFiles, pkg) {
  for (const { manifest } of packageFiles ?? []) {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const spec = manifest?.[section]?.[pkg];
      if (spec != null && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/.test(spec)) return spec;
    }
  }
  return null;
}

function installedVersion({ lock, packageFiles, pkg }) {
  const locked = lockedVersion(lock, pkg);
  const declared = declaredVersion(packageFiles, pkg);
  if (declared != null && locked != null && declared !== locked) {
    return {
      version: declared,
      problem:
        `"${pkg}": package.json declares ${declared} but package-lock.json has ${locked}. ` +
        'The lockfile is stale, so the orphaned-patch check cannot be trusted (see #2957). ' +
        'Run `npm install` and commit package-lock.json — `npm run lint:lockfile` covers this.',
    };
  }
  return { version: declared ?? locked, problem: null };
}

function manifestPackages(manifest) {
  return Object.keys(manifest ?? {}).filter((k) => k !== '//');
}

export const PATCHED_GROUP_NAME = 'patched dependencies';

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

export function checkPatches({ patchFiles, manifest, lock, packageFiles }) {
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

    const { version: locked, problem: stale } = installedVersion({ lock, packageFiles, pkg });
    if (stale) problems.push(`${file}: ${stale}`);
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

export function orphanedPatches({ patchFiles, manifest, lock, packageFiles }) {
  const out = [];
  for (const file of patchFiles) {
    const parsed = parsePatchFilename(file);
    if (!parsed) continue;
    const { pkg, version } = parsed;
    const { version: locked } = installedVersion({ lock, packageFiles, pkg });
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
