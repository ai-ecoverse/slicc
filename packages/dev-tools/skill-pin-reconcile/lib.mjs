export const PINS = [
  {
    dep: 'v86',
    packageJson: 'packages/webapp/package.json',
    skill: 'packages/vfs-root/workspace/skills/v86/SKILL.md',
    pattern: /ipk add -g v86@\d+\.\d+\.\d+/g,
    line: (v) => `ipk add -g v86@${v}`,
  },
];

export function exactPinVersion(packageJsonText, dep) {
  let pkg;
  try {
    pkg = JSON.parse(packageJsonText);
  } catch (err) {
    return {
      ok: false,
      reason: `invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const version = pkg.dependencies?.[dep] ?? pkg.devDependencies?.[dep] ?? null;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    return {
      ok: false,
      reason: `no exact ${dep} pin (got ${JSON.stringify(version)})`,
    };
  }
  return { ok: true, version };
}

export function syncSkillText(skillText, pin, version) {
  const expected = pin.line(version);

  const pattern = new RegExp(pin.pattern.source, pin.pattern.flags);
  if (!pattern.test(skillText)) {
    return {
      ok: false,
      reason: `no \`ipk add -g ${pin.dep}@X.Y.Z\` line to sync`,
    };
  }
  pattern.lastIndex = 0;
  const next = skillText.replace(pattern, expected);
  return { ok: true, next, changed: next !== skillText };
}

export function reconcilePin({ packageJsonText, skillText, pin }) {
  const pinned = exactPinVersion(packageJsonText, pin.dep);
  if (!pinned.ok) {
    return { ok: false, reason: pinned.reason, where: 'packageJson' };
  }
  const synced = syncSkillText(skillText, pin, pinned.version);
  if (!synced.ok) {
    return { ok: false, reason: synced.reason, where: 'skill' };
  }
  return {
    ok: true,
    version: pinned.version,
    next: synced.next,
    changed: synced.changed,
  };
}
