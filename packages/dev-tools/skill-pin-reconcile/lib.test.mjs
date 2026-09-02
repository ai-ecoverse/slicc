import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { exactPinVersion, PINS, reconcilePin, syncSkillText } from './lib.mjs';

const V86 = PINS.find((p) => p.dep === 'v86');
if (!V86) throw new Error('expected a v86 pin in PINS');

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'reconcile.mjs');

const SKILL_TEMPLATE = `---
name: v86
---

\`\`\`bash
ipk add -g v86@0.5.424
mkdir -p /workspace/.v86
\`\`\`
`;

describe('exactPinVersion', () => {
  it('reads an exact pin from dependencies or devDependencies', () => {
    expect(exactPinVersion(JSON.stringify({ dependencies: { v86: '0.5.441' } }), 'v86')).toEqual({
      ok: true,
      version: '0.5.441',
    });
    expect(exactPinVersion(JSON.stringify({ devDependencies: { v86: '0.5.441' } }), 'v86')).toEqual(
      { ok: true, version: '0.5.441' }
    );
  });

  it('rejects caret ranges, missing deps, and invalid JSON', () => {
    expect(exactPinVersion(JSON.stringify({ dependencies: { v86: '^0.5.441' } }), 'v86').ok).toBe(
      false
    );
    expect(exactPinVersion(JSON.stringify({ dependencies: {} }), 'v86').ok).toBe(false);
    expect(exactPinVersion('{not-json', 'v86').ok).toBe(false);
  });
});

describe('syncSkillText', () => {
  it('rewrites a mismatched pin and reports changed', () => {
    const result = syncSkillText(SKILL_TEMPLATE, V86, '0.5.441');
    expect(result).toMatchObject({ ok: true, changed: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.next).toContain('ipk add -g v86@0.5.441');
    expect(result.next).not.toContain('ipk add -g v86@0.5.424');
  });

  it('is a no-op when the skill already matches', () => {
    const already = SKILL_TEMPLATE.replace('0.5.424', '0.5.441');
    const result = syncSkillText(already, V86, '0.5.441');
    expect(result).toEqual({ ok: true, next: already, changed: false });
  });

  it('fails when the install line is missing', () => {
    expect(syncSkillText('# no install line\n', V86, '0.5.441').ok).toBe(false);
  });
});

describe('reconcilePin', () => {
  it('composes package.json + skill into a sync decision', () => {
    const result = reconcilePin({
      packageJsonText: JSON.stringify({ devDependencies: { v86: '0.5.441' } }),
      skillText: SKILL_TEMPLATE,
      pin: V86,
    });
    expect(result).toMatchObject({ ok: true, version: '0.5.441', changed: true });
  });

  it('surfaces package.json failures separately from skill failures', () => {
    expect(
      reconcilePin({
        packageJsonText: JSON.stringify({ dependencies: { v86: '^1.0.0' } }),
        skillText: SKILL_TEMPLATE,
        pin: V86,
      })
    ).toMatchObject({ ok: false, where: 'packageJson' });
    expect(
      reconcilePin({
        packageJsonText: JSON.stringify({ dependencies: { v86: '0.5.441' } }),
        skillText: 'missing',
        pin: V86,
      })
    ).toMatchObject({ ok: false, where: 'skill' });
  });
});

describe('reconcile.mjs CLI', () => {
  /** @type {string[]} */
  const temps = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * @param {{ version?: string; skillVersion?: string; write?: boolean; omitPin?: boolean; omitSkillLine?: boolean }} opts
   */
  function runCli(opts = {}) {
    const {
      version = '0.5.441',
      skillVersion = '0.5.424',
      write = false,
      omitPin = false,
      omitSkillLine = false,
    } = opts;
    const root = mkdtempSync(join(tmpdir(), 'skill-pin-'));
    temps.push(root);
    const pkgPath = join(root, 'packages/webapp/package.json');
    const skillPath = join(root, 'packages/vfs-root/workspace/skills/v86/SKILL.md');
    mkdirSync(dirname(pkgPath), { recursive: true });
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(
      pkgPath,
      JSON.stringify({
        devDependencies: omitPin ? {} : { v86: version },
      })
    );
    writeFileSync(
      skillPath,
      omitSkillLine ? '# no install line\n' : SKILL_TEMPLATE.replace('0.5.424', skillVersion)
    );

    const args = [ENTRY];
    if (write) args.push('--write');
    const proc = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, SKILL_PIN_ROOT: root },
    });
    return {
      status: proc.status,
      stdout: proc.stdout,
      stderr: proc.stderr,
      skill: readFileSync(skillPath, 'utf8'),
    };
  }

  it('dry-run exits 2 on drift without rewriting the skill', () => {
    const { status, skill, stdout } = runCli({ write: false });
    expect(status).toBe(2);
    expect(stdout).toMatch(/dry-run/);
    expect(skill).toContain('ipk add -g v86@0.5.424');
  });

  it('--write applies the sync and exits 0', () => {
    const { status, skill } = runCli({ write: true });
    expect(status).toBe(0);
    expect(skill).toContain('ipk add -g v86@0.5.441');
  });

  it('exits 0 when already in sync', () => {
    const { status, stdout } = runCli({ skillVersion: '0.5.441' });
    expect(status).toBe(0);
    expect(stdout).toMatch(/already matches/);
  });

  it('exits 1 on a malformed package.json pin', () => {
    const { status, stderr } = runCli({ omitPin: true });
    expect(status).toBe(1);
    expect(stderr).toMatch(/no exact v86 pin/);
  });

  it('exits 1 when the skill install line is missing', () => {
    const { status, stderr } = runCli({ omitSkillLine: true });
    expect(status).toBe(1);
    expect(stderr).toMatch(/no `ipk add/);
  });
});
