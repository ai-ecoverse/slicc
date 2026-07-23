import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'check-skill-router-sync.sh');
const fixtures = [];

function createFixture(routerSkills = ['alpha'], agentSkills = ['alpha']) {
  const root = mkdtempSync(join(tmpdir(), 'skill-router-sync-'));
  fixtures.push(root);
  mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });

  for (const skill of agentSkills) {
    const skillDir = join(root, '.agents', 'skills', skill);
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
    symlinkSync(`../../.agents/skills/${skill}`, join(root, '.claude', 'skills', skill));
  }

  const routes = routerSkills.map((skill) => `- Example → use \`${skill}\``).join('\n');
  writeFileSync(
    join(root, 'AGENTS.md'),
    `# Instructions\n\n## Developer Agent Skills (.agents/skills/)\n\n${routes}\n\n## Next\n`
  );
  return root;
}

function runCheck(root) {
  try {
    const stdout = execFileSync('bash', [scriptPath, root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    return {
      status: error.status,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { force: true, recursive: true });
  }
});

describe('check-skill-router-sync.sh', () => {
  it('accepts matching router, canonical skills, and Claude symlinks', () => {
    const result = runCheck(createFixture(['alpha', 'beta'], ['alpha', 'beta']));

    expect(result.status).toBe(0);
    expect(result.output).toContain('All 2 developer skill(s) match');
  });

  it('reports canonical skills missing from the router', () => {
    const result = runCheck(createFixture(['alpha'], ['alpha', 'beta']));

    expect(result.status).toBe(1);
    expect(result.output).toContain('Developer skills missing from the AGENTS.md router');
    expect(result.output).toContain('  - beta');
  });

  it('reports router entries without a canonical skill', () => {
    const result = runCheck(createFixture(['alpha', 'missing'], ['alpha']));

    expect(result.status).toBe(1);
    expect(result.output).toContain('AGENTS.md router references nonexistent developer skills');
    expect(result.output).toContain('  - missing');
  });

  it('accepts a byte-identical Claude skill directory', () => {
    const root = createFixture();
    rmSync(join(root, '.claude', 'skills', 'alpha'));
    cpSync(join(root, '.agents', 'skills', 'alpha'), join(root, '.claude', 'skills', 'alpha'), {
      recursive: true,
    });

    expect(runCheck(root).status).toBe(0);
  });

  it('rejects a canonical skill missing from the Claude skill directory', () => {
    const root = createFixture();
    rmSync(join(root, '.claude', 'skills', 'alpha'));
    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain('Canonical developer skill missing from .claude/skills: alpha');
  });

  it('rejects a Claude skill directory that differs from the canonical skill', () => {
    const root = createFixture();
    rmSync(join(root, '.claude', 'skills', 'alpha'));
    mkdirSync(join(root, '.claude', 'skills', 'alpha'));
    writeFileSync(join(root, '.claude', 'skills', 'alpha', 'SKILL.md'), 'different\n');
    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain('Claude skill differs from canonical developer skill: alpha');
  });

  it('rejects a Claude symlink that points outside the canonical skill tree', () => {
    const root = createFixture();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'SKILL.md'), 'outside\n');
    rmSync(join(root, '.claude', 'skills', 'alpha'));
    symlinkSync('../../outside', join(root, '.claude', 'skills', 'alpha'));
    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain('Claude skill symlink must resolve to .agents/skills/alpha');
  });
});
