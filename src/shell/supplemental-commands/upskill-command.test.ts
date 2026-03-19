import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../fs/index.js';
import { initSkillsSystem } from '../../skills/index.js';
import { createSkillCommand, createUpskillCommand } from './upskill-command.js';

function createMockCtx() {
  return {
    fs: {
      resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    },
    cwd: '/workspace',
    env: new Map<string, string>(),
    stdin: '',
  } as const;
}

let dbCounter = 0;

describe('skill/upskill command compatibility discovery', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-upskill-command-${dbCounter++}`,
      wipe: true,
    });
    await initSkillsSystem(fs);
  });

  it('skill help documents discoverable compatibility roots and native-only management', async () => {
    const result = await createSkillCommand(fs).execute(['--help'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('List discoverable skills and management status');
    expect(result.stdout).toContain('**/.agents/skills/*');
    expect(result.stdout).toContain('**/.claude/skills/*');
    expect(result.stdout).toContain('Only native /workspace/skills entries are install-managed');
  });

  it('skill list shows source and read-only compatibility status', async () => {
    await fs.mkdir('/workspace/skills/native-skill', { recursive: true });
    await fs.writeFile(
      '/workspace/skills/native-skill/manifest.yaml',
      'skill: native-skill\nversion: 1.2.3\ndescription: Native skill\n',
    );

    await fs.mkdir('/repo/.claude/skills/compat-skill', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/compat-skill/SKILL.md', '# Compat Skill');

    const result = await createSkillCommand(fs).execute(['list'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Discoverable skills:');
    expect(result.stdout).toContain('native-skill');
    expect(result.stdout).toContain('compat-skill');
    expect(result.stdout).toContain('native');
    expect(result.stdout).toContain('.claude');
    expect(result.stdout).toContain('available');
    expect(result.stdout).toContain('compatibility (read-only)');
  });

  it('skill info reports source and management mode for compatibility skills', async () => {
    await fs.mkdir('/repo/.agents/skills/agent-skill', { recursive: true });
    await fs.writeFile('/repo/.agents/skills/agent-skill/SKILL.md', '# Agent Skill');

    const result = await createSkillCommand(fs).execute(['info', 'agent-skill'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Skill: agent-skill');
    expect(result.stdout).toContain('Source: .agents');
    expect(result.stdout).toContain('Source root: /repo/.agents/skills');
    expect(result.stdout).toContain('Management: compatibility-only (read-only)');
    expect(result.stdout).toContain('Instructions: /repo/.agents/skills/agent-skill/SKILL.md');
  });

  it('skill install refuses to mutate compatibility-discovered skills', async () => {
    await fs.mkdir('/repo/.claude/skills/compat-skill', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/compat-skill/SKILL.md', '# Compat Skill');

    const result = await createSkillCommand(fs).execute(['install', 'compat-skill'], createMockCtx() as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('compatibility-only/read-only');
    expect(result.stderr).toContain('/repo/.claude/skills');
  });

  it('upskill list uses unified local discovery wording', async () => {
    await fs.mkdir('/repo/.agents/skills/local-agent-skill', { recursive: true });
    await fs.writeFile('/repo/.agents/skills/local-agent-skill/SKILL.md', '# Local Agent Skill');

    const result = await createUpskillCommand(fs, vi.fn() as never).execute(['list'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Discoverable local skills:');
    expect(result.stdout).toContain('local-agent-skill');
    expect(result.stdout).toContain('.agents');
    expect(result.stdout).toContain('Only native /workspace/skills entries are install-managed');
  });
});