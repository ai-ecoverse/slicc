/**
 * Pure helpers for skill-pin-reconcile. The CLI in reconcile.mjs is the only
 * I/O surface; keep this module free of fs / process so the exit-code and
 * sync decisions are unit-testable (Codex review on PR #2779).
 */

/** @typedef {{ dep: string; packageJson: string; skill: string; pattern: RegExp; line: (v: string) => string }} SkillPin */

/** @type {readonly SkillPin[]} */
export const PINS = [
  {
    dep: 'v86',
    packageJson: 'packages/webapp/package.json',
    skill: 'packages/vfs-root/workspace/skills/v86/SKILL.md',
    pattern: /ipk add -g v86@\d+\.\d+\.\d+/g,
    line: (v) => `ipk add -g v86@${v}`,
  },
];

/**
 * Read an exact X.Y.Z pin from a package.json document.
 * @param {string} packageJsonText
 * @param {string} dep
 * @returns {{ ok: true; version: string } | { ok: false; reason: string }}
 */
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

/**
 * Rewrite the skill's `ipk add -g <dep>@X.Y.Z` line to match `version`.
 * @param {string} skillText
 * @param {SkillPin} pin
 * @param {string} version
 * @returns {{ ok: true; next: string; changed: boolean } | { ok: false; reason: string }}
 */
export function syncSkillText(skillText, pin, version) {
  const expected = pin.line(version);
  // Clone so callers can reuse the shared PINS patterns without lastIndex bleed.
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

/**
 * Reconcile one pin against in-memory package.json + skill contents.
 * @param {{ packageJsonText: string; skillText: string; pin: SkillPin }} args
 * @returns {
 *   | { ok: true; version: string; next: string; changed: boolean }
 *   | { ok: false; reason: string; where: 'packageJson' | 'skill' }
 * }
 */
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
